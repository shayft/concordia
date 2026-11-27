import { expect, it, vi } from 'vitest';
import type { ModelProvider } from '@concordia/providers';
import { runBuiltin } from '../src/builtin.ts';

function exercise(answers: string[]) {
  const rounds = vi.fn();
  const dispatch = vi.fn(async () => ({ accepted: true }));
  const provider: ModelProvider = {
    getCapabilities: () => ({ streaming: true, nativeTools: false }),
    validateConnection: async () => ({ ok: true, text: 'unused' }),
    async *stream(messages, tools) {
      expect(tools).toEqual([]);
      expect(messages[0]?.content).toContain('submit_result');
      const text = answers.shift();
      if (text === undefined) throw new Error('extra request');
      yield { type: 'text_delta', text };
      yield { type: 'completed' };
    },
  };
  const result = runBuiltin({
    provider,
    mode: 'json',
    prompt: '完成确认',
    instruction: '测试',
    allowed: new Set(['submit_result']),
    beforeCall: rounds,
    usage: () => {},
    dispatch,
    signal: new AbortController().signal,
    maxCalls: 4,
  });
  return { result, rounds, dispatch };
}

it('JSON 模式在一次修复后派发已经过协议校验的动作', async () => {
  const action = { type: 'submit_result', summary: '完成' };
  const { result, rounds, dispatch } = exercise(['broken', JSON.stringify(action)]);
  await result;
  expect(rounds).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(action, '1/0');
});

it('连续格式错误或越权 JSON 只允许一次修复，且不派发动作', async () => {
  const { result, rounds, dispatch } = exercise(['broken', '{"type":"progress","message":"未授权"}']);
  await expect(result).rejects.toMatchObject({ kind: 'invalid' });
  expect(rounds).toHaveBeenCalledTimes(2);
  expect(dispatch).not.toHaveBeenCalled();
});

it('审查请求结束本轮工作，累计用量在完整一轮内只结算一次', async () => {
  const usage = vi.fn();
  const dispatch = vi.fn(async () => ({ status: 'review' }));
  const rounds = vi.fn();
  const provider: ModelProvider = {
    getCapabilities: () => ({ streaming: true, nativeTools: true }),
    validateConnection: async () => ({ ok: true, text: 'unused' }),
    async *stream() {
      yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
      yield { type: 'usage', outputTokens: 4 };
      yield { type: 'action', id: 'review', name: 'request_review', arguments: { taskId: 'current' } };
      yield { type: 'completed' };
    },
  };
  await runBuiltin({
    provider,
    mode: 'native',
    prompt: '审核',
    instruction: '审核',
    allowed: new Set(['request_review']),
    beforeCall: rounds,
    usage,
    dispatch,
    signal: new AbortController().signal,
    maxCalls: 3,
  });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(
    { type: 'request_review', taskId: 'current' },
    '0/review',
  );
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 3, outputTokens: 4 });
  expect(rounds).toHaveBeenCalledTimes(1);
});

it('取消带走未执行的动作，同时保留已收到的部分用量', async () => {
  const stop = new AbortController();
  const usage = vi.fn();
  const dispatch = vi.fn();
  const provider: ModelProvider = {
    getCapabilities: () => ({ streaming: true, nativeTools: false }),
    validateConnection: async () => ({ ok: true, text: 'unused' }),
    async *stream() {
      yield { type: 'usage', inputTokens: 3 };
      stop.abort();
      yield { type: 'text_delta', text: '{"type":"submit_result","summary":"迟到"}' };
    },
  };
  await expect(
    runBuiltin({
      provider,
      mode: 'json',
      prompt: '执行',
      instruction: '完成',
      allowed: new Set(['submit_result']),
      beforeCall: () => {},
      usage,
      dispatch,
      signal: stop.signal,
      maxCalls: 2,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 3 });
  expect(dispatch).not.toHaveBeenCalled();
});
