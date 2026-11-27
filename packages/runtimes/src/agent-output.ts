import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { CliDiagnosticError, nativeCliFailure } from './errors.ts';
import type { CliKind } from './environment.ts';

const usage = z.object({ input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional() });
const thread = z.uuid();
const claude = z.object({
  type: z.literal('result'), subtype: z.string(), is_error: z.boolean(), result: z.string().optional(),
  session_id: thread, usage: usage.optional(), permission_denials: z.array(z.unknown()).optional(),
});
const line = z.object({
  type: z.string(), thread_id: thread.optional(), usage: usage.optional(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});

export function decodeAgentOutput(kind: CliKind, output: string) {
  const decode = (s: string): unknown => {
    try { return JSON.parse(s); } catch { throw new CliDiagnosticError('CLI 输出格式错误。'); }
  };
  if (kind === 'claude') {
    const rows = output.trim().split(/\r?\n/).map(decode);
    const results = rows.filter(row => !!row && typeof row === 'object' && 'type' in row && row.type === 'result');
    if (results.length !== 1) throw new CliDiagnosticError('Claude Code 缺少唯一的本次结果。');
    const data = claude.safeParse(results[0]);
    if (!data.success) throw new CliDiagnosticError('Claude Code 结果格式未知。');
    const { session_id, result, permission_denials, ...meta } = data.data;
    return { session: session_id, text: result ?? '', usage: meta.usage,
      denied: !!permission_denials?.length, success: !meta.is_error && meta.subtype === 'success' };
  }
  let session: string | undefined;
  let started = false;
  let completed = false;
  let text = '';
  let tokens: z.infer<typeof usage> | undefined;
  for (const row of output.trim().split(/\r?\n/)) {
    const data = line.safeParse(decode(row));
    if (!data.success || completed) throw new CliDiagnosticError('Codex CLI 结果格式未知。');
    const { type, item } = data.data;
    if (type === 'thread.started') {
      if (session || !data.data.thread_id) throw new CliDiagnosticError('Codex CLI 会话标识无效。');
      session = data.data.thread_id;
    } else if (type === 'turn.started') {
      if (!session || started) throw new CliDiagnosticError('Codex CLI 执行顺序无效。');
      started = true;
    } else if (type === 'item.completed' && item?.type === 'agent_message') {
      if (!started || item.text === undefined) throw new CliDiagnosticError('Codex CLI 文本事件无效。');
      text += item.text;
    } else if (type === 'turn.completed') {
      if (!started) throw new CliDiagnosticError('Codex CLI 未启动执行。');
      completed = true;
      tokens = data.data.usage;
    } else if (type === 'error' || type === 'turn.failed') {
      throw nativeCliFailure(row);
    } else if (!['item.started', 'item.updated', 'item.completed'].includes(type)) {
      throw new CliDiagnosticError('Codex CLI 出现未知事件。');
    }
  }
  if (!completed || !session) throw new CliDiagnosticError('Codex CLI 缺少终止事件。');
  return { session, text, usage: tokens, denied: false, success: true };
}

// The observer sees bounded stdout only in memory. Retain only the official
// initialization UUID, before an interrupted turn can lose its final message.
export function watchSessionStart(kind: CliKind, save: (id: string) => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let found = false;
  return (chunk: Buffer) => {
    if (found) return;
    pending += decoder.write(chunk);
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== 'object' || !('type' in event)) continue;
      let id: unknown;
      if (kind === 'claude' && event.type === 'system' && 'subtype' in event && event.subtype === 'init' && 'session_id' in event) id = event.session_id;
      if (kind === 'codex' && event.type === 'thread.started' && 'thread_id' in event) id = event.thread_id;
      if (id !== undefined) {
        const result = thread.safeParse(id);
        if (!result.success) throw new CliDiagnosticError('初始 CLI 会话编号无效。');
        save(result.data);
        found = true;
        pending = '';
        return;
      }
    }
  };
}
