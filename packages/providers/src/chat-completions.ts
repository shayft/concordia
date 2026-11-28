import type { ModelEvent, ModelMessage, ModelTool, ProviderConfig } from './model-types.ts';
import { action, list, obj, readJson, sse, string, usage } from './wire.ts';

export function chatBody(
  config: ProviderConfig,
  messages: ModelMessage[],
  tools: ModelTool[],
  stream: boolean,
  continuations: WeakMap<ModelMessage, string>,
) {
  return {
    ...config.params,
    model: config.model,
    stream,
    max_completion_tokens: config.maxOutputTokens ?? 1024,
    ...(stream && { stream_options: { include_usage: true } }),
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(tools.length && m.role === 'assistant' && continuations.has(m) && {reasoning_content: continuations.get(m)}),
      ...(m.role === 'tool' && { tool_call_id: m.toolCallId }),
      ...(m.toolCalls?.length && {
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      }),
    })),
    ...(tools.length && {
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    }),
  };
}
function finish(reason: unknown) {
  if (reason !== 'stop' && reason !== 'tool_calls') throw new Error('incomplete');
}
export async function* chatEvents(response: Response, stream: boolean, rememberReasoning: (content: string) => void): AsyncGenerator<ModelEvent> {
  const meter = (v: unknown) => {
    if (!v) return [];
    const u = obj(v);
    return usage(u.prompt_tokens, u.completion_tokens, u.total_tokens);
  };
  if (!stream) {
    const body = await readJson(response);
    const choice = obj(list(body.choices)[0]);
    finish(choice.finish_reason);
    const m = obj(choice.message);
    if (m.content) yield { type: 'text_delta', text: string(m.content) };
    for (const entry of list(m.tool_calls ?? [])) {
      const tool = obj(entry);
      const fn = obj(tool.function);
      yield { type: 'action', ...action(tool.id, fn.name, fn.arguments) };
    }
    if (typeof m.reasoning_content === 'string') rememberReasoning(m.reasoning_content);
    yield* meter(body.usage);
    return;
  }
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finished = false;
  let reasoning: string | undefined;
  for await (const data of sse(response)) {
    if (data === '[DONE]') {
      if (!finished) throw new Error('missing finish');
      if (reasoning !== undefined) rememberReasoning(reasoning);
      for (const { id, name, args } of calls.values()) yield { type: 'action', ...action(id, name, args) };
      return;
    }
    const frame = obj(JSON.parse(data));
    if (frame.error) throw new Error('provider error');
    for (const item of list(frame.choices)) {
      const choice = obj(item);
      if (finished || (choice.index ?? 0) !== 0) throw new Error('unexpected choice');
      const delta = obj(choice.delta);
      if (typeof delta.reasoning_content === 'string') reasoning = (reasoning ?? '') + delta.reasoning_content;
      if (delta.content) yield { type: 'text_delta', text: string(delta.content) };
      for (const part of list(delta.tool_calls ?? [])) {
        const fragment = obj(part);
        if (!Number.isSafeInteger(fragment.index)) throw new Error('tool index');
        const index = fragment.index as number;
        const call = calls.get(index) ?? { id: '', name: '', args: '' };
        const fn = obj(fragment.function ?? {});
        if (fragment.id) call.id += string(fragment.id);
        if (fn.name) call.name += string(fn.name);
        if (fn.arguments) call.args += string(fn.arguments);
        calls.set(index, call);
      }
      if (choice.finish_reason != null) {
        finish(choice.finish_reason);
        finished = true;
      }
    }
    yield* meter(frame.usage);
  }
  throw new Error('missing done');
}
