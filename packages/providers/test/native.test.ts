import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ModelAction, ModelMessage, Protocol } from '../src/model-types.ts';
import { createModelProvider } from '../src/model-provider.ts';
import { collect, input, listen, tool } from './fixture.ts';

const argument = { version: 1 };
const schemas = {
  responses: {
    response: {
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
        { type: 'function_call', call_id: 'p', name: 'publish', arguments: JSON.stringify(argument) },
      ],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    },
    frames() {
      return [
        { type: 'response.output_text.delta', delta: 'ans' },
        { type: 'response.output_text.delta', delta: 'wer' },
        { type: 'response.function_call_arguments.done', arguments: JSON.stringify(argument) },
        { type: 'response.completed', response: this.response },
      ];
    },
  },
  gemini: {
    response: {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'answer' },
              { thoughtSignature: 'opaque', functionCall: { name: 'publish', args: argument } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9 },
    },
    frames() {
      return [this.response];
    },
  },
  anthropic: {
    response: {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'p', name: 'publish', input: argument },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    },
    frames() {
      return [
        { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'p', name: 'publish', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"version":' },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];
    },
  },
};
for (const protocol of Object.keys(schemas) as (keyof typeof schemas)[]) {
  for (const stream of [false, true]) {
    it(
      protocol +
        ' validates headers, model routing, native function round-trip, usage and text; streaming=' +
        stream,
      async () => {
        const wire = schemas[protocol];
        const rawBodies: Record<string, unknown>[] = [];
        const paths: string[] = [];
        const authorized: boolean[] = [];
        const token = randomUUID();
        const baseUrl = await listen(async (req, res) => {
          paths.push(req.url ?? '');
          const auth =
            protocol === 'gemini'
              ? req.headers['x-goog-api-key']
              : protocol === 'anthropic'
                ? req.headers['x-api-key']
                : req.headers.authorization;
          authorized.push(
            auth === (protocol === 'responses' ? 'Bearer ' : '') + token &&
              req.headers['x-tenant'] === token,
          );
          let raw = '';
          for await (const chunk of req) raw += chunk;
          rawBodies.push(JSON.parse(raw));
          const body = stream
            ? wire
                .frames()
                .map((v) => 'event: message\ndata: ' + JSON.stringify(v) + '\n\n')
                .join('')
            : JSON.stringify(wire.response);
          res.end(body);
        });
        const p = createModelProvider(
          {
            protocol,
            baseUrl,
            model: 'my/model',
            credentialRef: 'keychain:model',
            headerRefs: { 'X-Tenant': 'keychain:tenant' },
          },
          async () => token,
        );
        const ev = await collect(p.stream(input, [tool], { stream }));
        expect(ev.at(-1)).toEqual({ type: 'completed' });
        expect(
          ev
            .filter((e) => e.type === 'text_delta')
            .map((e) => e.text)
            .join(''),
        ).toBe('answer');
        expect(ev).toContainEqual(
          expect.objectContaining({ type: 'usage', inputTokens: 4, outputTokens: 5 }),
        );
        const call = ev.find((e) => e.type === 'action') as ModelAction;
        expect(call).toMatchObject({ name: 'publish', arguments: argument });
        const history: ModelMessage[] = [
          ...input,
          { role: 'assistant', content: 'answer', toolCalls: [call] },
          { role: 'tool', toolCallId: call.id, content: 'tool-result' },
        ];
        await collect(p.stream(history, [tool], { stream }));
        expect(authorized).toEqual([true, true]);
        expect(JSON.stringify(rawBodies[0]).includes(token)).toBe(false);
        const second = rawBodies[1];
        expect(JSON.stringify(second)).toContain('tool-result');
        if (protocol === 'gemini') {
          expect(paths[0]).toBe(
            '/tenant/v1/models/my%2Fmodel:' +
              (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'),
          );
          expect(JSON.stringify(second)).toContain('"thoughtSignature":"opaque"');
          expect(JSON.stringify(second)).not.toContain('gemini-1');
        } else if (protocol === 'responses') {
          expect(paths[0]).toBe('/tenant/v1/responses');
          expect(second).toMatchObject({ model: 'my/model', store: false });
          expect(JSON.stringify(second)).toContain('"encrypted_content":"opaque"');
        } else {
          expect(paths[0]).toBe('/tenant/v1/messages');
          expect(JSON.stringify(second)).toContain('"tool_use_id":"p"');
        }
      },
    );
  }

  it(protocol + ' strips unknown upstream error bodies', async () => {
    const privateText = randomUUID();
    const baseUrl = await listen((_req, res) => {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: privateText } }));
    });
    const events = await collect(createModelProvider({ protocol, baseUrl, model: 'custom' }).stream(input));
    expect(events).toEqual([expect.objectContaining({ type: 'error', kind: 'auth', httpStatus: 401 })]);
    expect(JSON.stringify(events).includes(privateText)).toBe(false);
  });
}
it.each(['chat-completions', 'responses', 'gemini', 'anthropic'] as Protocol[])(
  'cancel before sending a %s prompt',
  async (protocol) => {
    const c = new AbortController();
    c.abort();
    const events = await collect(
      createModelProvider({ protocol, baseUrl: 'https://offline.invalid', model: 'x' }).stream(input, [], {
        signal: c.signal,
      }),
    );
    expect(events).toEqual([expect.objectContaining({ type: 'error', kind: 'cancelled' })]);
  },
);
