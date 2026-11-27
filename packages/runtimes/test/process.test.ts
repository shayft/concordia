import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { activeProcessGroups, runProcess } from '../src/process.ts';

const fixture = fileURLToPath(new URL('./process-tree.mjs', import.meta.url));
const scratch: string[] = [];
const running = new Set<AbortController>();

afterEach(async () => {
  for (const controller of running) controller.abort();
  running.clear();
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待假进程状态超时');
    await delay(20);
  }
}

async function hasExited(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw err;
  }
  // Some container PID 1 implementations only reap orphans at shutdown.
  // Linux Z means the process has already exited and cannot execute code.
  if (process.platform !== 'linux') return false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

it.each(['cancel', 'early'])('收回关闭了输出管道的三代进程 (%s)', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'concordia tree '));
  scratch.push(directory);
  const controller = new AbortController();
  running.add(controller);
  const testStart = Date.now();
  const result = runProcess(process.execPath, [fixture, directory, '0', mode], {
    signal: controller.signal, timeoutMs: 7000, graceMs: 250,
  });
  const outcome = mode === 'cancel'
    ? expect(result).rejects.toThrow('取消')
    : expect(result).resolves.toMatchObject({ exitCode: 23 });
  await waitFor(() => stat(join(directory, 'leaf-ready')).then(() => true, () => false));
  const [owner] = activeProcessGroups();
  expect(owner?.pid).toBeGreaterThan(0);
  expect(owner?.startedAtMs).toBeGreaterThanOrEqual(testStart - 5);
  expect(owner?.startedAtMs).toBeLessThanOrEqual(Date.now() + 5);
  const pids = await Promise.all([0, 1, 2].map(async depth => Number(await readFile(join(directory, 'pid-' + depth), 'utf8'))));
  if (mode === 'cancel') controller.abort();
  await outcome;
  expect(activeProcessGroups()).toHaveLength(0);
  const stopped = (await readFile(join(directory, 'stopping'), 'utf8')).trim().split(/\s+/);
  // The leaf handles the initial signal but keeps running until forced cleanup.
  expect(stopped).toContain('2');
  if (mode === 'cancel') expect(stopped).toEqual(expect.arrayContaining(['0', '1']));
  for (const pid of pids) await waitFor(() => hasExited(pid));
}, 10_000);

it('不经 shell 传递包含空格、引号和元字符的参数，保留退出码', async () => {
  const literal = '空 格 & | " $HOME ()';
  const actual = await runProcess(process.execPath, [
    '-e', "process.stdout.write(process.argv[1]); process.stderr.write('err'); process.exitCode = 17", literal,
  ]);
  expect(actual).toEqual({ stdout: literal, stderr: 'err', exitCode: 17 });
});

it('在启动前取消时拒绝执行', async () => {
  await expect(runProcess(process.execPath, ['-v'], { signal: AbortSignal.abort() })).rejects.toThrow('取消');
});

it('超时后进行进程树清理', async () => {
  await expect(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
    timeoutMs: 300, graceMs: 20,
  })).rejects.toThrow('超时');
});

it('stdout 与 stderr 合计超限时停止，只返回固定诊断', async () => {
  const result = runProcess(process.execPath, ['-e', "process.stdout.write('abc'); process.stderr.write('def')"], {
    maxOutputBytes: 5, graceMs: 20,
  });
  await expect(result).rejects.toThrow(/^进程输出超过限制$/);
});

it('程序不存在时仅返回启动诊断', async () => {
  await expect(runProcess(join(tmpdir(), 'concordia-absent-executable'), [], { graceMs: 20 })).rejects.toThrow(/^无法启动受控进程/);
});

it('调用方强制退出后，管理器通过 IPC 断开回收树', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'concordia owner '));
  scratch.push(directory);
  const runModule = new URL('../src/process.ts', import.meta.url).href;
  const client = spawn(process.execPath, [
    '--input-type=module', '-e',
    'const [module, fixture, dir] = process.argv.slice(1); const { runProcess } = await import(module); await runProcess(process.execPath, [fixture, dir, "0", "cancel"]);',
    runModule, fixture, directory,
  ], { shell: false, stdio: 'ignore' });
  try {
    await waitFor(() => stat(join(directory, 'leaf-ready')).then(() => true, () => false));
    const pids = await Promise.all([0, 1, 2].map(async depth => Number(await readFile(join(directory, 'pid-' + depth), 'utf8'))));
    client.kill('SIGKILL');
    for (const pid of pids) await waitFor(() => hasExited(pid));
    expect(await readFile(join(directory, 'stopping'), 'utf8')).toContain('2');
  } finally {
    if (!client.killed) client.kill('SIGKILL');
  }
}, 10_000);

it('管理器本身被外力终止时明确报告清理结果未知', async () => {
  await expect(runProcess(process.execPath, [
    '-e', "process.kill(process.ppid, 'SIGKILL'); process.exit(23)",
  ])).rejects.toThrow('无法确认清理结果');
  expect(activeProcessGroups()).toHaveLength(0);
});
