import type { ModelAction, ModelEvent, ModelMessage, ModelTool, ProviderConfig } from './model-types.ts';
import { action, list, obj, readJson, sse, string, usage, type Dictionary } from './wire.ts';

export function geminiBody(config: ProviderConfig, messages: ModelMessage[], tools: ModelTool[]) {
  const system = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const calls = new Map<string, ModelAction>();
  const contents: { role: string; parts: Dictionary[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts: Dictionary[] = [];
    if (m.role === 'tool') {
      const call = calls.get(m.toolCallId ?? '');
      if (!call) throw new Error('missing tool reference');
      parts.push({
        functionResponse: {
          name: call.name,
          ...(!call.generatedId && { id: call.id }),
          response: { output: m.content },
        },
      });
    } else {
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls ?? []) {
        calls.set(call.id, call);
        parts.push({
          functionCall: {
            name: call.name,
            args: call.arguments,
            ...(!call.generatedId && { id: call.id }),
          },
          ...(call.thoughtSignature && { thoughtSignature: call.thoughtSignature }),
        });
      }
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const params = { ...config.params };
  const generationConfig: Dictionary = { maxOutputTokens: config.maxOutputTokens ?? 1024 };
  for (const [key, wire] of Object.entries({
    temperature: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
    topP: 'topP',
    topK: 'topK',
    stop: 'stopSequences',
  })) {
    if (params[key] !== undefined) {
      generationConfig[wire] = params[key];
      delete params[key];
    }
  }
  return {
    ...params,
    contents,
    generationConfig,
    ...(system.length && { systemInstruction: { parts: system } }),
    ...(tools.length && {
      tools: [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.inputSchema,
          })),
        },
      ],
    }),
  };
}
export async function* geminiEvents(res: Response, stream: boolean): AsyncGenerator<ModelEvent> {
  async function* frames() {
    if (!stream) {
      yield await readJson(res);
      return;
    }
    for await (const data of sse(res)) yield obj(JSON.parse(data));
  }
  let finished = false;
  let callIndex = 0;
  let meter: ModelEvent[] = [];
  for await (const frame of frames()) {
    if (frame.error || (frame.promptFeedback && obj(frame.promptFeedback).blockReason))
      throw new Error('blocked');
    if (frame.usageMetadata) {
      const u = obj(frame.usageMetadata);
      meter = usage(u.promptTokenCount, u.candidatesTokenCount, u.totalTokenCount);
    }
    for (const raw of list(frame.candidates ?? [])) {
      const c = obj(raw);
      if (finished || (c.index ?? 0) !== 0) throw new Error('unexpected candidate');
      for (const rawPart of list(c.content ? (obj(c.content).parts ?? []) : [])) {
        const part = obj(rawPart);
        if (part.thought === true) continue;
        if (part.text) yield { type: 'text_delta', text: string(part.text) };
        if (part.functionCall) {
          const fn = obj(part.functionCall);
          const generatedId = fn.id === undefined;
          const id = fn.id ?? 'gemini-' + ++callIndex;
          yield {
            type: 'action',
            ...action(id, fn.name, fn.args ?? {}),
            ...(generatedId && { generatedId: true }),
            ...(typeof part.thoughtSignature === 'string' && { thoughtSignature: part.thoughtSignature }),
          };
        }
      }
      if (c.finishReason) {
        if (c.finishReason !== 'STOP') throw new Error('incomplete');
        finished = true;
      }
    }
  }
  if (!finished) throw new Error('missing finish');
  yield* meter;
}
