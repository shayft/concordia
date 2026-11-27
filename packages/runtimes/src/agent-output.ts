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
    const data = claude.safeParse(decode(output));
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
