import { CliDiagnosticError } from './errors.ts';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export type CliKind = 'claude' | 'codex';

const inherited = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
]);

// Diagnose by name even when a variable is empty. Only named opt-ins may be passed.
const billingNames = [
  /^ANTHROPIC_(?:API_KEY|AUTH_TOKEN|CUSTOM_HEADERS|BASE_URL|MODEL|DEFAULT_\w+|(?:BEDROCK|VERTEX|FOUNDRY)_\w+)$/i,
  /^CLAUDE_(?:CONFIG_DIR|CODE_(?:OAUTH_TOKEN|USE_(?:BEDROCK|VERTEX|FOUNDRY|MANTLE)|SKIP_\w+_AUTH))$/i,
  /^OPENAI_(?:API_KEY|BASE_URL|API_BASE|ORGANIZATION|ORG_ID|PROJECT(?:_ID)?)$/i,
  /^(?:CODEX_(?:HOME|API_KEY|ACCESS_TOKEN)|AZURE_OPENAI_\w+)$/i,
  /^AWS_(?:(?:DEFAULT_)?PROFILE|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|(?:DEFAULT_)?REGION|BEARER_TOKEN_BEDROCK|CONFIG_FILE|SHARED_CREDENTIALS_FILE|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN)$/i,
  /^(?:GOOGLE_(?:APPLICATION_CREDENTIALS|CLOUD_PROJECT|API_KEY)|GEMINI_API_KEY|VERTEX_REGION)$/i,
];
// Also flag conventionally named credentials used by custom providers, without
// allowing an unreviewed variable to change the CLI's execution environment.
const otherCredential = /^[A-Z_][A-Z0-9_]*(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_CREDENTIALS)$/i;
function supported(name: string) { return billingNames.some(pattern => pattern.test(name)); }

export function detectBillingEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return Object.keys(env).filter(name => supported(name) || otherCredential.test(name)).sort()
    .map(name => ({ name, source: '当前进程环境' as const }));
}

export function prepareEnvironment(env: NodeJS.ProcessEnv, passEnv: readonly string[] = []) {
  const billingEnvironment = detectBillingEnvironment(env).map(item => ({ ...item, passed: passEnv.includes(item.name) }));
  const permitted = new Set(billingEnvironment.map(item => item.name).filter(name =>
    supported(name) && !/^CLAUDE_CODE_SKIP_.*_AUTH$/i.test(name)));
  if (passEnv.some(name => !permitted.has(name))) {
    throw new CliDiagnosticError('只可按名称选择当前环境中受支持的计费或认证变量。');
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(env)) {
    const normalized = process.platform === 'win32' ? name.toUpperCase() : name;
    if (inherited.has(normalized) || passEnv.includes(name)) childEnv[normalized] = env[name];
  }
  return { childEnv, billingEnvironment };
}

export async function resolveExecutable(kind: CliKind, env: NodeJS.ProcessEnv, configured?: string) {
  if (configured !== undefined && !isAbsolute(configured)) throw new CliDiagnosticError('请为 CLI 配置绝对路径。');
  const windows = process.platform === 'win32';
  if (windows && configured && !/\.exe$/i.test(configured)) {
    throw new CliDiagnosticError('Windows 需要官方原生 .exe 路径，命令脚本无法直接启动。');
  }
  const basename = windows ? kind + '.exe' : kind;
  const candidates = configured ? [configured] : (env.PATH ?? '').split(delimiter)
    .filter(dir => isAbsolute(dir)).map(dir => join(dir, basename));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Missing and inaccessible entries are both possible in desktop PATHs.
    }
  }
  if (configured) throw new CliDiagnosticError('指定的 CLI 路径不存在、不可执行或不是文件。请检查配置的绝对路径。');
  throw new CliDiagnosticError('当前 PATH 中找不到 ' + basename + '。请安装官方 CLI 或配置其可执行文件的绝对路径。');
}
