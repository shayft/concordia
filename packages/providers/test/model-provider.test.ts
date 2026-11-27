import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createModelProvider } from '../src/model-provider.ts';
import { collect, input, listen, tool } from './fixture.ts';

function data(value: unknown) {
  return 'data: ' + JSON.stringify(value) + '\r\n\r\n';
}
function frame(delta: unknown, reason: string | null = null) {
  return data({ choices: [{ index: 0, delta, finish_reason: reason }] });
}
it('delivers SSE before EOF; merges fragmented calls and suppresses a credential across chunk boundaries', async () => {
  const token = randomUUID();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const baseUrl = await listen(async (_req, res) => {
    res.write(frame({ content: 'hello ' + token.slice(0, 5) }));
    await pending;
    res.write(frame({ content: token.slice(5) + ' world' }));
    res.write(
      frame({ tool_calls: [{ index: 0, id: 'one', function: { name: 'publish', arguments: '{"v":' } }] }),
    );
    res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, 'tool_calls'));
    res.write(data({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } }));
    res.end('data: [DONE]\r\n\r\n');
  });
  const p = createModelProvider(
    { protocol: 'chat-completions', baseUrl, credentialRef: 'keychain:test', model: 'free/model' },
    async () => token,
  );
  const stream = p.stream(input, [tool])[Symbol.asyncIterator]();
  const first = await stream.next();
  release();
  expect(first.value).toEqual({ type: 'text_delta', text: 'hello ' });
  const rest = [];
  for (let next = await stream.next(); !next.done; next = await stream.next()) rest.push(next.value);
  expect(JSON.stringify(rest).includes(token)).toBe(false);
  expect(rest).toContainEqual({ type: 'action', id: 'one', name: 'publish', arguments: { v: 1 } });
  expect(rest).toContainEqual({ type: 'usage', inputTokens: 2, outputTokens: 4, totalTokens: 6 });
  expect(rest.at(-1)).toEqual({ type: 'completed' });
});
it('supports multiple URLs and arbitrary models in parallel; keeps the supplied endpoint and tool schema', async () => {
  const routes: string[] = [];
  const ids: string[] = [];
  const address = () =>
    listen(async (req, res) => {
      routes.push(req.url ?? '');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      ids.push(payload.model);
      if (payload.tools?.[0]?.function.name !== 'publish' || payload.max_completion_tokens !== 99) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'received' } }] }));
    });
  const results = await Promise.all(
    (await Promise.all([address(), address()])).map((baseUrl, i) =>
      collect(
        createModelProvider({
          protocol: 'chat-completions',
          baseUrl,
          endpoint: 'custom/chat',
          model: 'any/' + i,
          maxOutputTokens: 99,
        }).stream(input, [tool], { stream: false }),
      ),
    ),
  );
  expect(routes).toEqual(['/tenant/v1/custom/chat', '/tenant/v1/custom/chat']);
  expect(ids.sort()).toEqual(['any/0', 'any/1']);
  for (const events of results)
    expect(events).toEqual([{ type: 'text_delta', text: 'received' }, { type: 'completed' }]);
});
it('rejects truncated streams before acting on a partial tool call', async () => {
  const baseUrl = await listen((_req, res) =>
    res.end(
      frame(
        { tool_calls: [{ index: 0, id: 'p', function: { name: 'publish', arguments: '{}' } }] },
        'tool_calls',
      ),
    ),
  );
  const events = await collect(
    createModelProvider({ protocol: 'chat-completions', baseUrl, model: 'x' }).stream(input, [tool]),
  );
  expect(events).toEqual([expect.objectContaining({ type: 'error', kind: 'invalid' })]);
});
it.each([
  [401, 'auth'],
  [429, 'rate_limit'],
  [503, 'server'],
  [307, 'invalid'],
] as const)('normalizes HTTP %i without retry or disclosure', async (status, kind) => {
  const received = vi.fn();
  const privateMessage = randomUUID();
  const baseUrl = await listen((_req, res) => {
    received();
    res.writeHead(status, { location: '/next' });
    res.end(privateMessage);
  });
  const events = await collect(
    createModelProvider({ protocol: 'chat-completions', baseUrl, model: 'x' }).stream(input),
  );
  expect(events).toEqual([expect.objectContaining({ type: 'error', kind, httpStatus: status })]);
  expect(JSON.stringify(events).includes(privateMessage)).toBe(false);
  expect(received).toHaveBeenCalledTimes(1);
});
it('does not send a late request after a timeout waiting for a credential', async () => {
  const received = vi.fn();
  const baseUrl = await listen(received);
  let release!: (v: string) => void;
  const blocked = new Promise<string>((resolve) => {
    release = resolve;
  });
  const events = await collect(
    createModelProvider(
      { protocol: 'chat-completions', baseUrl, model: 'x', credentialRef: 'keychain:test', timeoutMs: 40 },
      () => blocked,
    ).stream(input),
  );
  release(randomUUID());
  expect(events).toEqual([expect.objectContaining({ type: 'error', kind: 'timeout' })]);
  expect(received).not.toHaveBeenCalled();
});

it.each(['CONCORDIA_OK', 'different'])('报告连接验证的用量，包括非约定回显', async (content) => {
  const baseUrl = await listen((_req, res) =>
    res.end(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    ),
  );
  const result = await createModelProvider({
    protocol: 'chat-completions',
    baseUrl,
    model: 'private',
  }).validateConnection();
  expect(result).toMatchObject({
    ok: content === 'CONCORDIA_OK',
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  });
});
