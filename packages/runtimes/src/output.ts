import { CliDiagnosticError, nativeErrorCategory } from './errors.ts';
import { z } from 'zod';
import type { CliKind } from './environment.ts';

export const probeReply = 'CONCORDIA_OK';
export const probePrompt = 'Reply with exactly CONCORDIA_OK. Do not use tools or access files.';

const claudeResult = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
  is_error: z.literal(false),
  result: z.string(),
});
const codexEvent = z.object({ type: z.string() });
const codexItem = z.object({ type: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }) });

function decode(line: string): unknown {
  try { return JSON.parse(line); } catch { throw new CliDiagnosticError('CLI 机器输出不是有效 JSON。'); }
}

function checkReply(text?: string) {
  if (text?.trim() !== probeReply) {
    throw new CliDiagnosticError('CLI 未返回预期的固定校验文本，原始内容已丢弃。');
  }
  return probeReply;
}

export function parseProbeOutput(kind: CliKind, stdout: string): { text: string; recording: string } {
  if (kind === 'claude') {
    const parsed = claudeResult.safeParse(decode(stdout));
    if (!parsed.success) throw new CliDiagnosticError('Claude Code 未返回成功的 result 事件（' + nativeErrorCategory(stdout) + '）。');
    const text = checkReply(parsed.data.result);
    // Reconstruct from an allowlist. Never serialize arbitrary CLI metadata.
    return { text, recording: JSON.stringify({ ...parsed.data, result: text }) + '\n' };
  }

  let completed = false;
  let text: string | undefined;
  const recording = [];
  let turnStarted = false;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const raw = decode(line);
    const event = codexEvent.safeParse(raw);
    if (!event.success || completed) throw new CliDiagnosticError('Codex CLI 事件顺序或格式异常。');
    const type = event.data.type;
    if (type === 'turn.started') {
      if (turnStarted) throw new CliDiagnosticError('Codex CLI 返回了多次执行。');
      turnStarted = true;
    } else if (type === 'turn.completed') {
      if (!turnStarted) throw new CliDiagnosticError('Codex CLI 缺少 turn.started。');
      completed = true;
    } else if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
      const parsed = codexItem.safeParse(raw);
      if (!turnStarted || !parsed.success) throw new CliDiagnosticError('Codex CLI 输出无效的 item。');
      const item = parsed.data.item;
      // Reasoning is free text and can contain local context. Omit it entirely.
      if (item.type === 'reasoning') continue;
      if (item.type !== 'agent_message') throw new CliDiagnosticError('Codex CLI 返回了只读文本校验以外的活动。');
      if (type === 'item.completed') {
        text = checkReply(item.text);
        recording.push({ type, item: { type: item.type, text } });
      }
      continue;
    } else if (type === 'turn.failed' || type === 'error') {
      throw new CliDiagnosticError('Codex CLI 报告执行失败（' + nativeErrorCategory(line) + '）。');
    } else if (type !== 'thread.started') {
      throw new CliDiagnosticError('Codex CLI 返回失败或未识别的事件。');
    }
    recording.push({ type });
  }
  if (!completed || text === undefined) throw new CliDiagnosticError('Codex CLI 缺少最终文本或 turn.completed。');
  return { text, recording: recording.map(entry => JSON.stringify(entry)).join('\n') + '\n' };
}

type Login = '已登录' | '未登录' | '未知';
type AuthMethod = 'Claude.ai' | 'ChatGPT' | 'API Key' | '外部凭据' | '未知';
export interface AuthStatus {
  login: Login;
  authMethod: AuthMethod;
  billing: 'API' | '未知';
}

export function parseAuth(kind: CliKind, stdout: string, stderr: string, exitCode: number | null): AuthStatus {
  const unknown: AuthStatus = { login: '未知', authMethod: '未知', billing: '未知' };
  if (kind === 'claude') {
    try {
      const result = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional() }).safeParse(decode(stdout));
      if (!result.success) return unknown;
      if (exitCode === 1 && !result.data.loggedIn) return { ...unknown, login: '未登录' };
      if (exitCode !== 0 || !result.data.loggedIn) return unknown;
      switch (result.data.authMethod) {
        case 'claude.ai': return { ...unknown, login: '已登录', authMethod: 'Claude.ai' };
        case 'api_key': case 'api_key_helper': return { login: '已登录', authMethod: 'API Key', billing: 'API' };
        case 'third_party': case 'oauth_token': return { ...unknown, login: '已登录', authMethod: '外部凭据' };
        default: return { ...unknown, login: '已登录' };
      }
    } catch { return unknown; }
  }
  const status = stdout + '\n' + stderr;
  if (exitCode === 1 && /^Not logged in\s*$/im.test(status)) return { ...unknown, login: '未登录' };
  if (exitCode !== 0) return unknown;
  if (/^Logged in using ChatGPT\s*$/im.test(status)) return { ...unknown, login: '已登录', authMethod: 'ChatGPT' };
  if (/^Logged in using an API key\b/im.test(status)) return { ...unknown, login: '已登录', authMethod: 'API Key' };
  return unknown;
}
