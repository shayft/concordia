import type { ModelAction, ModelEvent } from './model-types.ts';

export type Dictionary = Record<string, unknown>;
export function obj(v: unknown): Dictionary {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('object');
  return v as Dictionary;
}
export function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('array');
  return v;
}
export function string(v: unknown): string {
  if (typeof v !== 'string') throw new Error('string');
  return v;
}
export function usage(input: unknown, output: unknown, total: unknown): ModelEvent[] {
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const [inputTokens, outputTokens, totalTokens] = [input, output, total].map(count);
  if ([inputTokens, outputTokens, totalTokens].every(v => v === undefined)) return [];
  return [{ type: 'usage', inputTokens, outputTokens, totalTokens }];
}
export function action(id: unknown, name: unknown, args: unknown): ModelAction {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) throw new Error('tool call');
  return { id, name, arguments: obj(typeof args === 'string' ? JSON.parse(args) : args) };
}

async function* chunks(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('empty body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let bytes = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('oversize');
      yield decoder.decode(value, {stream:true});
    }
    yield decoder.decode();
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
export async function readJson(response: Response): Promise<Dictionary> {
  let body = '';
  for await (const chunk of chunks(response)) body += chunk;
  return obj(JSON.parse(body));
}
// Split SSE fields after decoding bytes. A TCP chunk may end inside UTF-8 or CRLF.
export async function* sse(response: Response): AsyncGenerator<string> {
  let tail = '';
  let data: string[] = [];
  for await (const chunk of chunks(response)) {
    tail += chunk;
    let end: number;
    while ((end = tail.indexOf('\n')) !== -1) {
      const line = tail.slice(0, end).replace(/\r$/, '');
      tail = tail.slice(end + 1);
      if (!line) {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line === 'data' || line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (tail.trim() || data.length) throw new Error('truncated event');
}
