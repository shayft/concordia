import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveCliDirectory } from './cli-path.ts';
import { prepareEnvironment, resolveExecutable, type CliKind } from './environment.ts';
import { CliDiagnosticError, nativeCliFailure } from './errors.ts';
import { parseAuth, parseProbeOutput, probePrompt } from './output.ts';
import { runProcess, type ProcessResult } from './process.ts';

export interface CliOptions {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  passEnv?: readonly string[];
  signal?: AbortSignal;
  confirmUnmanaged?: boolean;
  model?: string;
  /** The selected task will inject Concordia's own MCP endpoint. */
  requiresPlatformMcp?: boolean;
  actionChannel?: 'mcp' | 'json';
}

const claudeArgs = [
  '--print', '--output-format', 'json', '--safe-mode', '--permission-mode', 'default',
  '--tools', '', '--disallowedTools', '*', '--strict-mcp-config', '--max-turns', '1',
  '--no-session-persistence', '--settings',
  JSON.stringify({ disableAllHooks: true, fallbackModel: [], switchModelsOnFlag: false }),
  probePrompt,
];

// Keep the existing model/provider/auth selection. Check the effective MCP list
// with the same overrides before starting exec; refuse if any server survives.
export const disabledFeatures = ['shell_tool', 'shell_snapshot', 'apps', 'hooks', 'plugins', 'multi_agent',
  'computer_use', 'browser_use', 'code_mode', 'image_generation'];
export const codexOptions = [
  '--no-daemon', ...disabledFeatures.flatMap(feature => ['--disable', feature]),
  '-c', 'notify=[]',
  '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
];
const codexArgs = [
  ...codexOptions, '--ask-for-approval', 'on-request', 'exec',
  '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json', probePrompt,
];

// Codex 0.172 merges `-c mcp_servers={...}` into the servers from the user's or a
// trusted project's config.toml instead of replacing them, so each configured server
// is disabled by name. A later table assignment re-enables them: these overrides must
// follow any `mcp_servers=` argument. Codex splits override keys on dots and does not
// accept quoted segments, so only bare names can be disabled.
export const platformMcpServer = 'concordia';
const bareServerName = /^[A-Za-z0-9_-]{1,64}$/;

export function codexMcpDisables(names: readonly string[]): string[] {
  return names.flatMap(name => ['-c', 'mcp_servers.' + name + '.enabled=false']);
}

interface ListedServer { name: string; enabled: boolean }
function isListedServer(value: unknown): value is ListedServer {
  return typeof value === 'object' && value !== null
    && typeof (value as ListedServer).name === 'string' && typeof (value as ListedServer).enabled === 'boolean';
}

function listedMcpServers(result: ProcessResult): ListedServer[] {
  let servers: unknown;
  try { servers = JSON.parse(result.stdout); } catch { /* Reject an unknown schema. */ }
  if (result.exitCode !== 0 || !Array.isArray(servers) || !servers.every(isListedServer)) {
    throw new CliDiagnosticError('Codex CLI 未能列出本次调用的 MCP 服务，已停止。请核对版本和本机策略。');
  }
  return servers;
}

export function modelArgs(model?: string): string[] {
  if (model === undefined) return [];
  if (!model.trim() || model.length > 200 || model.startsWith('-') || Array.from(model).some(c => c.charCodeAt(0) < 32)) {
    throw new CliDiagnosticError('CLI 模型名无效。');
  }
  return ['--model', model];
}

async function inWorkspace<T>(options: CliOptions, work: (cwd: string) => Promise<T>) {
  const env = options.env ?? process.env;
  if (options.cwd !== undefined) {
    if (!isAbsolute(options.cwd)) throw new CliDiagnosticError('CLI 工作目录必须是绝对路径。');
    return work(await resolveCliDirectory(options.cwd, env));
  }
  const cwd = await mkdtemp(join(await resolveCliDirectory(tmpdir(), env), 'concordia-probe-'));
  try { return await work(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

async function prepare(kind: CliKind, options: CliOptions, cwd: string) {
  if (kind !== 'claude' && kind !== 'codex') throw new CliDiagnosticError('不支持的 CLI 类型。');
  const { childEnv, billingEnvironment } = prepareEnvironment(options.env ?? process.env, options.passEnv);
  const executable = await resolveExecutable(kind, childEnv, options.executable, options.env ?? process.env);
  const invoke = async (args: string[], timeoutMs = 15_000) => {
    try {
      return await runProcess(executable, args, { cwd, env: childEnv, signal: options.signal, timeoutMs });
    } catch (error) {
      if (options.signal?.aborted) throw new CliDiagnosticError('CLI 执行已取消。');
      if (error instanceof Error && error.message === '进程运行超时') throw new CliDiagnosticError('CLI 执行超时。','transient');
      throw new CliDiagnosticError('CLI 无法在当前权限、PATH 和输出限制内执行。请检查其绝对路径、运行依赖和进程隔离支持。');
    }
  };
  const readVersion = await invoke(['--version']);
  const pattern = kind === 'claude'
    ? /^(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?) \(Claude Code\)$/im
    : /^codex-cli (\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)$/im;
  const version = readVersion.stdout.trim().match(pattern)?.[1];
  if (readVersion.exitCode !== 0 || !version) throw new CliDiagnosticError('无法识别官方 CLI 版本。');
  const help = await invoke(kind === 'claude' ? ['--help'] : ['exec', '--help']);
  const baseArgs = kind === 'claude' ? claudeArgs : codexArgs;
  let args = options.model === undefined ? baseArgs : [...baseArgs.slice(0, -1), ...modelArgs(options.model), probePrompt];
  const rootHelp = kind === 'codex' ? await invoke(['--help']) : help;
  const helpText = help.stdout + '\n' + rootHelp.stdout;
  const flags = args.filter(arg => arg.startsWith('--'));
  const missing = flags.filter(flag => !new RegExp(flag + '(?=[\\s,=<]|$)').test(helpText));
  // Claude Code 2.1.332 accepts --max-turns but hides it in root help.
  // With help first and no value, its argument parser exits before any task.
  if (kind === 'claude' && help.exitCode === 0 && missing.length === 1 && missing[0] === '--max-turns') {
    const probe = await invoke(['--help', '--max-turns']);
    const diagnostic = probe.stderr.replace(/\r?\n$/u, '');
    if (probe.exitCode === 1 && probe.stdout === '' && diagnostic === "error: option '--max-turns <turns>' argument missing") {
      missing.pop();
    }
  }
  if (help.exitCode !== 0 || rootHelp.exitCode !== 0 || missing.length) {
    throw new CliDiagnosticError('当前 CLI 帮助缺少校验所需参数，请核对版本。' + [...new Set(missing)].join(' '));
  }

  let disabledMcpServers: string[] = [];
  if (kind === 'codex') {
    const featureList = await invoke([...codexOptions, 'features', 'list']);
    const inactive = new Set(featureList.stdout.split(/\r?\n/)
      .map(line => /^(\w+)\s+.+\s+false\s*$/.exec(line)?.[1]));
    if (featureList.exitCode !== 0 || disabledFeatures.some(feature => !inactive.has(feature))) {
      throw new CliDiagnosticError('Codex CLI 无法确认只读校验所需的工具和扩展限制已生效。');
    }
    disabledMcpServers = listedMcpServers(await invoke([...codexOptions, 'mcp', 'list', '--json']))
      .map(server => server.name).sort();
    if (options.requiresPlatformMcp && disabledMcpServers.includes(platformMcpServer)) {
      throw new CliDiagnosticError('Codex 配置中已有名为 concordia 的 MCP 服务器，与平台动作通道重名。请在 Codex 配置中改名后重新预检。');
    }
    const unnamed = disabledMcpServers.filter(name => !bareServerName.test(name));
    if (unnamed.length) {
      throw new CliDiagnosticError('Codex 配置中有 ' + unnamed.length + ' 个 MCP 服务器的名称含点号或其他字符，无法按名称停用。'
        + '请在 Codex 配置中改为仅含字母、数字、下划线和连字符的名称后重新预检。');
    }
    const disables = codexMcpDisables(disabledMcpServers);
    const remaining = listedMcpServers(await invoke([...codexOptions, ...disables, 'mcp', 'list', '--json']));
    if (remaining.some(server => server.enabled)) {
      throw new CliDiagnosticError('Codex CLI 未能确认本次调用的 MCP 服务已全部停用，已停止。请核对版本和本机策略。');
    }
    args = [...codexOptions, ...disables, ...args.slice(codexOptions.length)];
  }
  const auth = await invoke(kind === 'claude' ? ['auth', 'status'] : ['login', 'status']);
  const diagnostic = {
    kind, executable, version, billingEnvironment, actionChannel: options.actionChannel ?? 'auto',
    cwd: options.cwd === undefined ? '新建的空临时目录' : cwd,
    ...(kind === 'claude' && { unmanagedConfirmed: options.confirmUnmanaged === true }),
    ...(kind === 'codex' && { disabledMcpServers }),
    ...parseAuth(kind, auth.stdout, auth.stderr, auth.exitCode),
    arguments: [...args],
  };
  const inspectionId = createHash('sha256').update(JSON.stringify(diagnostic)).digest('hex');
  return { diagnostic: { ...diagnostic, inspectionId }, invoke };
}

export function inspectCli(kind: CliKind, options: CliOptions = {}) {
  return inWorkspace(options, async cwd => (await prepare(kind, options, cwd)).diagnostic);
}

export async function runCliProbe(kind: CliKind, options: CliOptions & { approved: true; inspectionId: string }) {
  if (options.approved !== true) throw new CliDiagnosticError('执行一次真实 CLI 调用前需要用户明确批准。');
  return inWorkspace(options, async cwd => {
    const { diagnostic, invoke } = await prepare(kind, options, cwd);
    if (diagnostic.inspectionId !== options.inspectionId) {
      throw new CliDiagnosticError('CLI 预检信息与本次运行不一致，请重新预检并确认。');
    }
    if (kind === 'claude' && !diagnostic.unmanagedConfirmed) {
      throw new CliDiagnosticError('请先在 Claude Code 的 /status 核对 Setting sources。仅在没有 Managed settings 时按说明确认并重新预检。');
    }
    if (diagnostic.login === '未登录') throw new CliDiagnosticError('CLI 报告未登录，请在官方程序中完成登录。','auth');
    const result = await invoke(diagnostic.arguments, 60_000);
    if (result.exitCode !== 0) {
      throw nativeCliFailure(result.stderr + '\n' + result.stdout, result.exitCode);
    }
    return { ...diagnostic, ...parseProbeOutput(kind, result.stdout) };
  });
}
