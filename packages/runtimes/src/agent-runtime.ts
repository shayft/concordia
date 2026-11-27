import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { actionTools, type ActionName, type PlatformAction } from '@concordia/protocol';
import { codexOptions, inspectCli, modelArgs, type CliOptions } from './cli.ts';
import { prepareEnvironment, type CliKind } from './environment.ts';
import { CliDiagnosticError, nativeCliFailure } from './errors.ts';
import { ExecutionMcpServer } from './mcp.ts';
import { runProcess } from './process.ts';
import { decodeAgentOutput } from './agent-output.ts';

export type AgentRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'action'; action: PlatformAction }
  | { type: 'permission_request'; message: string }
  | { type: 'completed' }
  | { type: 'error'; message: string };

export interface AgentExecutionInput {
  executionId: string; memberId: string; taskId: string; prompt: string; cwd: string;
  permission: 'read-only' | 'worktree-write'; authorizedWorktree?: string;
  mcpOrigin: string; approvedDiagnostic?: Awaited<ReturnType<typeof inspectCli>>; allowedActions?: ReadonlySet<ActionName>; recoveryDir?: string; signal?: AbortSignal;
}
export interface CliSessionStore { get(key: string): string | undefined; set(key: string, session: string): void }
interface RuntimeConfig extends CliOptions { kind: CliKind; connectionId: string }
const activeSessions = new Set<string>();
const observedServers = z.tuple([z.object({ name: z.literal('concordia'), enabled: z.literal(true), transport: z.object({
  type: z.literal('streamable_http'), url: z.string(), bearer_token_env_var: z.literal('CONCORDIA_MCP_TOKEN'),
  http_headers_helper: z.null().optional(), http_headers: z.record(z.string(), z.never()).nullish(),
  env_http_headers: z.record(z.string(), z.never()).nullish(),
}) })]);

function actionUrl(origin: string, executionId: string) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !/^[a-zA-Z0-9_-]{1,200}$/.test(executionId)) {
    throw new CliDiagnosticError('动作地址或执行编号无效。');
  }
  url.pathname = '/mcp/' + executionId;
  return url.href;
}
function redact(text: string, env: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD|CUSTOM_HEADERS/i.test(name)) text = text.replaceAll(value, '[已脱敏]');
  }
  return text;
}

export class CliAgentRuntime {
  private active = new Map<string, AbortController>();
  constructor(private readonly config: RuntimeConfig, private readonly mcp: ExecutionMcpServer,
    private readonly sessions: CliSessionStore) {}
  getCapabilities() { return { actions: 'mcp', sessions: true, readOnly: true, worktreeWrite: true } as const; }
  validate() { return inspectCli(this.config.kind, this.config); }
  cancel(executionId: string) {
    const controller = this.active.get(executionId);
    if (controller) { this.mcp.close(executionId); controller.abort(); }
  }

  async run(input: AgentExecutionInput, emit: (event: AgentRuntimeEvent) => void): Promise<void> {
    try {
      await this.execute(input, emit);
    } catch (error) {
      const message = error instanceof CliDiagnosticError ? error.message : 'CLI 执行未完成。';
      emit({ type: 'error', message });
      throw error instanceof CliDiagnosticError ? error : new CliDiagnosticError(message);
    }
  }

  private async execute(input: AgentExecutionInput, emit: (event: AgentRuntimeEvent) => void) {
    const { executionId, memberId, taskId, prompt, permission } = input;
    if (!memberId || !taskId || !prompt || !isAbsolute(input.cwd) || !['read-only','worktree-write'].includes(permission)) {
      throw new CliDiagnosticError('执行输入不完整。');
    }
    const cwd = await realpath(input.cwd);
    const write = permission === 'worktree-write';
    const bound = !!input.authorizedWorktree && isAbsolute(input.authorizedWorktree) && await realpath(input.authorizedWorktree) === cwd;
    if ((input.authorizedWorktree || write) && !bound) throw new CliDiagnosticError('缺少当前工作树的授权。','permission');
    const allowed = new Set(actionTools.map(tool => tool.name).filter(name => {
      if (input.allowedActions && !input.allowedActions.has(name)) return false;
      if (name === 'read_file') return bound;
      if (['write_file', 'commit_artifact', 'run_project_command'].includes(name)) return write && bound;
      return true;
    }));
    const { kind, model, connectionId } = this.config;
    const key = JSON.stringify([kind, connectionId, model ?? null, memberId, taskId, cwd, permission]);
    if (this.active.has(executionId) || activeSessions.has(key)) throw new CliDiagnosticError('同一会话已有执行。');
    const controller = new AbortController();
    const abort = () => this.cancel(executionId);
    this.active.set(executionId, controller);
    activeSessions.add(key);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    let opened = false;
    try {
      const signal = controller.signal;
      const diagnostic = await inspectCli(kind, { ...this.config, cwd, signal });
      if (input.approvedDiagnostic) {
        // The working tree can differ from the inspected connection directory.
        // Reject a different executable, credential method, model or environment.
        const profile = (d: typeof diagnostic) => JSON.stringify([d.kind, d.executable, d.version,
          d.login, d.authMethod, d.billing, d.billingEnvironment, d.unmanagedConfirmed, d.arguments]);
        if (profile(input.approvedDiagnostic) !== profile(diagnostic)) throw new CliDiagnosticError('工作目录中的 CLI 连接与批准的预检结果不符。');
      }
      if (kind === 'claude' && !diagnostic.unmanagedConfirmed) throw new CliDiagnosticError('需要确认 Claude 无受管策略。','permission');
      if (diagnostic.login === '未登录') throw new CliDiagnosticError('CLI 未登录。','auth');
      const url = actionUrl(input.mcpOrigin, executionId);
      const { childEnv } = prepareEnvironment(this.config.env ?? process.env, this.config.passEnv);
      const options = { cwd, signal, env: childEnv, recoveryDir: input.recoveryDir, executionId };
      const previous = this.sessions.get(key);
      if (previous && !z.uuid().safeParse(previous).success) throw new CliDiagnosticError('保存的 CLI 会话无效。');
      const requested = previous ?? (kind === 'claude' ? randomUUID() : undefined);
      let args: string[];
      if (kind === 'claude') {
        const mcpConfig = { mcpServers: { concordia: { type: 'http', url,
          headers: { Authorization: 'Bearer ${CONCORDIA_MCP_TOKEN}' } } } };
        // All edits on Claude use the scope-checked MCP file tools: native
        // restricted mode would discard provider settings on this invocation.
        const tools = Array.from(allowed, name => 'mcp__concordia__' + name);
        args = ['--print','--safe-mode','--strict-mcp-config','--mcp-config',JSON.stringify(mcpConfig),
          '--tools', '', '--allowedTools', tools.join(','),
          '--permission-mode','default','--settings',JSON.stringify({ disableAllHooks: true, fallbackModel: [], switchModelsOnFlag: false, disableClaudeAiConnectors: true }),
          '--output-format','json','--max-turns','16', ...modelArgs(model),
          previous ? '--resume' : '--session-id', requested!];
      } else {
        const cfg = codexOptions.slice(0, -2);
        cfg.push('-c', 'mcp_servers={concordia={url=' + JSON.stringify(url) + ',bearer_token_env_var="CONCORDIA_MCP_TOKEN",required=true}}');
        // Check that invocation overrides actually replaced inherited MCP entries.
        const list = await runProcess(diagnostic.executable, [...cfg, 'mcp','list','--json'], options);
        let observed: unknown;
        try { observed = JSON.parse(list.stdout); } catch { /* Fail closed below. */ }
        const parsed = observedServers.safeParse(observed);
        if (list.exitCode !== 0 || !parsed.success || parsed.data[0].transport.url !== url) {
          throw new CliDiagnosticError('Codex 的实际 MCP 配置不匹配。');
        }
        if (write) cfg.push('-c','sandbox_workspace_write.writable_roots=[]','-c','sandbox_workspace_write.exclude_slash_tmp=true',
          '-c','sandbox_workspace_write.exclude_tmpdir_env_var=true','-c','sandbox_workspace_write.network_access=false');
        args = [...cfg,'--ask-for-approval','on-request','exec','--sandbox', write ? 'workspace-write' : 'read-only',
          '--skip-git-repo-check','--json',...modelArgs(model), ...(previous ? ['resume',previous] : []), '-'];
      }
      // Reject incompatible local releases before forwarding credentials or a task.
      const help = await runProcess(diagnostic.executable, kind === 'claude' ? ['--help'] : ['exec','--help'], options);
      const required = kind === 'claude' ? ['--allowedTools','--strict-mcp-config','--mcp-config',previous ? '--resume' : '--session-id'] : ['--sandbox','--json','resume'];
      if (help.exitCode !== 0 || !required.every(flag => help.stdout.includes(flag))) throw new CliDiagnosticError('当前 CLI 缺少会话或受限工具所需的参数。');
      const token = this.mcp.open(executionId, action => emit({ type: 'action', action }), allowed);
      opened = true;
      const env = { ...childEnv, CONCORDIA_MCP_TOKEN: token };
      const result = await runProcess(diagnostic.executable, args, { ...options, env, stdin: prompt, timeoutMs: 120_000 });
      if (signal.aborted) throw new CliDiagnosticError('执行已取消。');
      if (result.exitCode !== 0) throw nativeCliFailure(result.stderr + '\n' + result.stdout);
      const output = decodeAgentOutput(kind, result.stdout);
      if (requested && requested !== output.session) throw new CliDiagnosticError('CLI 返回了另一个会话。');
      if (!this.mcp.initialized(executionId)) throw new CliDiagnosticError('CLI 未连接本次执行的 MCP 动作通道。');
      const reverseKey = JSON.stringify(['session-owner', kind, output.session]);
      const owner = this.sessions.get(reverseKey);
      if (owner && owner !== key) throw new CliDiagnosticError('CLI 会话已经绑定另一成员或任务。');
      this.sessions.set(reverseKey, key);
      this.sessions.set(key, output.session);
      if (output.denied) {
        emit({ type: 'permission_request', message: 'CLI 拒绝了需要授权的工具。' });
        throw new CliDiagnosticError('需要用户处理 CLI 权限。','permission');
      }
      if (!output.success) throw nativeCliFailure(result.stdout);
      if (output.text) emit({ type: 'text_delta', text: redact(output.text, env) });
      if (output.usage) emit({ type: 'usage', inputTokens: output.usage.input_tokens, outputTokens: output.usage.output_tokens });
      emit({ type: 'completed' });
    } catch (err) {
      if (err instanceof CliDiagnosticError) throw err;
      if (err instanceof Error && err.message === '进程运行超时') throw new CliDiagnosticError('CLI 执行超时。','transient');
      throw new CliDiagnosticError(controller.signal.aborted ? '执行已取消。' : 'CLI 执行未完成。');
    } finally {
      if (opened) this.mcp.close(executionId);
      input.signal?.removeEventListener('abort', abort);
      this.active.delete(executionId);
      activeSessions.delete(key);
    }
  }
}
