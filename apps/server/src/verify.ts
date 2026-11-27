import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCredential, validateGateway } from '@concordia/providers';
import { CliDiagnosticError, detectBillingEnvironment, inspectCli, runCliProbe } from '@concordia/runtimes';

const usage = `用法（从项目根目录运行）
  pnpm verify env
  pnpm verify inspect claude|codex [--executable 绝对路径] [--cwd 工作目录]
  pnpm verify run claude|codex --approve-call --inspection 预检ID [--executable 绝对路径] [--record]
  pnpm verify run gateway --base-url API根路径 --model 模型ID --credential keychain:条目 --approve-call

inspect 检查版本、权限参数和原生登录状态，生成与这次诊断绑定的 inspectionId。
run 启动一次 CLI 回显任务，或向网关发一次 POST。CLI 的内部网络重试由原生程序控制。
Claude 实跑前需在原生 /status 核对没有受管设置，并在 inspect 和 run 同时加 --confirm-unmanaged。
CLI 可用 --pass-env 变量名（可重复）逐项批准传入当前环境中的计费变量。
--record 仅保存经白名单净化的实际回显。Ctrl+C 取消当前验证。`;

class UsageError extends Error {}

function argumentsFor(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, 'confirm-unmanaged': { type: 'boolean' }, executable: { type: 'string' },
      cwd: { type: 'string' }, inspection: { type: 'string' }, 'approve-call': { type: 'boolean' }, record: { type: 'boolean' },
      'base-url': { type: 'string' }, model: { type: 'string' }, credential: { type: 'string' },
      'pass-env': { type: 'string', multiple: true },
    } });
  } catch {
    throw new UsageError('无法识别参数。运行 pnpm verify --help 查看用法。');
  }
}

async function saveRecording(kind: 'claude' | 'codex', version: string, content: string) {
  const numeric = version.match(/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/u)?.[0];
  if (!numeric) throw new UsageError('真实调用已结束，但无法识别版本号以保存回放。');
  const root = fileURLToPath(new URL('../../../packages/runtimes/fixtures/recorded/', import.meta.url));
  const dir = join(root, kind);
  const name = numeric + (kind === 'claude' ? '.json' : '.jsonl');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content.trimEnd() + '\n', { flag: 'wx', mode: 0o600 });
    return '已保存 ' + join('packages', 'runtimes', 'fixtures', 'recorded', kind, name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return '此 CLI 版本已有回放，已保留原文件。';
    throw new UsageError('真实调用已结束，但回放文件写入失败。请检查项目目录权限。');
  }
}

function print(result: unknown) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function main(signal: AbortSignal) {
  const { values, positionals } = argumentsFor(process.argv.slice(2));
  if (values.help || (!positionals.length && !Object.keys(values).length)) {
    process.stdout.write(usage + '\n');
    return;
  }
  const [command, target] = positionals;
  if (command === 'env' && positionals.length === 1 && !Object.keys(values).length) {
    print(detectBillingEnvironment(process.env));
    return;
  }
  if (positionals.length !== 2 || (command !== 'run' && command !== 'inspect'))
    throw new UsageError(usage);
  if (command === 'run' && !values['approve-call'])
    throw new UsageError('将启动 1 次 CLI 任务或发送 1 次网关请求，可能消耗额度或产生费用。若同意请添加 --approve-call。');

  if (target === 'gateway') {
    if (command !== 'run' || !values['base-url'] || !values.model || !values.credential
      || values['confirm-unmanaged'] || values.executable || values.cwd || values.inspection || values.record || values['pass-env']) throw new UsageError(usage);
    const result = await validateGateway({
      baseUrl: values['base-url'], model: values.model, credentialRef: values.credential,
    }, readCredential, signal);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if ((target !== 'claude' && target !== 'codex') || values['base-url'] || values.credential || values.model
    || (target !== 'claude' && values['confirm-unmanaged']))
    throw new UsageError(usage);
  const options = {
    signal, ...(values['confirm-unmanaged'] && { confirmUnmanaged: true }),
    ...(values.executable && { executable: values.executable }),
    ...(values.cwd && { cwd: values.cwd }), ...(values['pass-env'] && { passEnv: values['pass-env'] }),
  };
  if (command === 'inspect') {
    if (values.record || values.inspection || values['approve-call']) throw new UsageError(usage);
    print(await inspectCli(target, options));
    return;
  }
  if (!values.inspection) throw new UsageError('请先运行 inspect 并核对登录、计费和权限，再用 --inspection 传入该次预检 ID。');
  const { recording, ...result } = await runCliProbe(target, {
    ...options, approved: true, inspectionId: values.inspection,
  });
  print(result);
  if (values.record) process.stdout.write(await saveRecording(target, result.version, recording) + '\n');
}

const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await main(controller.signal);
} catch (error) {
  const safe = error instanceof UsageError || error instanceof CliDiagnosticError;
  process.stderr.write((safe ? error.message : '验证未完成，未记录原始错误。') + '\n');
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
