import { throwUpstreamError } from './upstream-error.ts';
import type {
  ModelEvent,
  ModelMessage,
  ModelTool,
  ProviderConfig,
  ResponseReasoning,
} from './model-types.ts';
import { action, list, obj, readJson, sse, string, usage, type Dictionary } from './wire.ts';

export function responsesBody(
  config: ProviderConfig,
  messages: ModelMessage[],
  tools: ModelTool[],
  stream: boolean,
) {
  const input: Dictionary[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content) input.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls ?? []) {
      input.push(...(call.responseReasoning ?? []));
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return {
    ...config.params,
    model: config.model,
    input,
    store: false,
    stream,
    max_output_tokens: config.maxOutputTokens ?? 1024,
    ...(tools.length && {
      tools: tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      })),
    }),
  };
}
function* result(body: Dictionary, emitted: string): Generator<ModelEvent> {
  if (body.error) throwUpstreamError(body.error);
  if (body.status !== 'completed') throw new Error('incomplete');
  let text = '';
  const reasoning: ResponseReasoning[] = [];
  for (const raw of list(body.output)) {
    const item = obj(raw);
    if (item.type === 'message') {
      for (const part of list(item.content)) {
        const block = obj(part);
        if (block.type !== 'output_text') throw new Error('unexpected response content');
        text += string(block.text);
      }
    } else if (item.type === 'function_call') {
      yield {
        type: 'action',
        ...action(item.call_id, item.name, item.arguments),
        ...(reasoning.length && { responseReasoning: reasoning.splice(0) }),
      };
    } else if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string') {
        reasoning.push({ type: 'reasoning', encrypted_content: item.encrypted_content, summary: [] });
      }
    } else throw new Error('unexpected hosted tool');
  }
  if (!text.startsWith(emitted)) throw new Error('inconsistent final text');
  if (text.length > emitted.length) yield { type: 'text_delta', text: text.slice(emitted.length) };
  if (body.usage) {
    const u = obj(body.usage);
    yield* usage(u.input_tokens, u.output_tokens, u.total_tokens);
  }
}
export async function* responsesEvents(res: Response, stream: boolean): AsyncGenerator<ModelEvent> {
  if (!stream) {
    yield* result(await readJson(res), '');
    return;
  }
  let emitted = '';
  for await (const data of sse(res)) {
    const frame = obj(JSON.parse(data));
    if (frame.type === 'response.output_text.delta') {
      const text = string(frame.delta);
      emitted += text;
      yield { type: 'text_delta', text };
    } else if (frame.type === 'response.completed') {
      yield* result(obj(frame.response), emitted);
      return;
     } else if (frame.type === 'error') throwUpstreamError(frame.error ?? frame);
    else if (frame.type === 'response.failed' || frame.type === 'response.incomplete') {
      throwUpstreamError(obj(frame.response ?? {}).error);
    }
  }
  throw new Error('unfinished stream');
}
