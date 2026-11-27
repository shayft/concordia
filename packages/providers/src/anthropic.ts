import type { ModelEvent, ModelMessage, ModelTool, ProviderConfig } from './model-types.ts';
import { action, list, obj, readJson, sse, string, usage, type Dictionary } from './wire.ts';

export function anthropicBody(
  config: ProviderConfig,
  history: ModelMessage[],
  tools: ModelTool[],
  stream: boolean,
) {
  const system = history
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const messages: { role: string; content: Dictionary[] }[] = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    const content: Dictionary[] = [];
    if (m.role === 'tool')
      content.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else {
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? [])
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    ...config.params,
    model: config.model,
    max_tokens: config.maxOutputTokens ?? 1024,
    stream,
    messages,
    ...(system && { system }),
    ...(tools.length && {
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    }),
  };
}
function finished(reason: unknown) {
  return reason === 'end_turn' || reason === 'tool_use' || reason === 'stop_sequence';
}
export async function* anthropicEvents(res: Response, stream: boolean): AsyncGenerator<ModelEvent> {
  if (!stream) {
    const body = await readJson(res);
    if (!finished(body.stop_reason)) throw new Error('incomplete');
    for (const raw of list(body.content)) {
      const block = obj(raw);
      if (block.type === 'text') yield { type: 'text_delta', text: string(block.text) };
      else if (block.type === 'tool_use')
        yield { type: 'action', ...action(block.id, block.name, block.input) };
      else throw new Error('unsupported block');
    }
    if (body.usage) {
      const u = obj(body.usage);
      yield* usage(u.input_tokens, u.output_tokens, undefined);
    }
    return;
  }
  const calls = new Map<number, { id: unknown; name: unknown; args: string; initial: unknown }>();
  let inputTokens: unknown;
  let outputTokens: unknown;
  let stopped = false;
  for await (const data of sse(res)) {
    const frame = obj(JSON.parse(data));
    const index = frame.index as number;
    if (frame.type === 'message_start') {
      const u = obj(obj(frame.message).usage ?? {});
      inputTokens = u.input_tokens;
      outputTokens = u.output_tokens;
    } else if (frame.type === 'content_block_start') {
      const b = obj(frame.content_block);
      if (b.type === 'tool_use') calls.set(index, { id: b.id, name: b.name, args: '', initial: b.input });
      else if (b.type === 'text') {
        if (b.text) yield { type: 'text_delta', text: string(b.text) };
      } else throw new Error('unsupported block');
    } else if (frame.type === 'content_block_delta') {
      const d = obj(frame.delta);
      if (d.type === 'text_delta') yield { type: 'text_delta', text: string(d.text) };
      else if (d.type === 'input_json_delta') {
        const call = calls.get(index);
        if (!call) throw new Error('unexpected tool');
        call.args += string(d.partial_json);
      } else throw new Error('unexpected content delta');
    } else if (frame.type === 'content_block_stop') {
      const call = calls.get(index);
      if (call) {
        yield { type: 'action', ...action(call.id, call.name, call.args || call.initial) };
        calls.delete(index);
      }
    } else if (frame.type === 'message_delta') {
      stopped = finished(obj(frame.delta).stop_reason);
      if (frame.usage) outputTokens = obj(frame.usage).output_tokens ?? outputTokens;
    } else if (frame.type === 'message_stop') {
      if (!stopped || calls.size) throw new Error('incomplete');
      yield* usage(inputTokens, outputTokens, undefined);
      return;
    } else if (frame.type !== 'ping') throw new Error('upstream error');
  }
  throw new Error('unfinished stream');
}
