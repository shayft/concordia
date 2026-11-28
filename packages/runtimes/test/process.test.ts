import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { activeProcessGroups, recoverProcessGroups, startProcessRecovery, runProcess } from '../src/process.ts';

import { compileWindowsFixture } from './fixtures/compile-windows.ts';

const fixture = fileURLToPath(new URL('./process-tree.mjs', import.meta.url));
const expectedSignal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM';

async function treeCommand(directory: string, mode: string) {
  if (process.platform !== 'win32' || mode !== 'early') {
    return { executable: process.execPath, args: [fixture, directory, '0', mode] };
  }
  // A Node fixture cannot leave this tree alive after a Windows parent's exit:
  // libuv puts non-detached children into its own kill-on-close job.
  const executable = join(directory, 'WindowsProcessTree.exe');
  await compileWindowsFixture(new URL('./fixtures/WindowsProcessTree.cs', import.meta.url), executable);
  return { executable, args: [] };
}

const scratch: string[] = [];
const running = new Map<AbortController, ReturnType<typeof runProcess>>();

afterEach(async () => {
  for (const controller of running.keys()) controller.abort();
  // A failed assertion can reach this hook before its Job has been closed.
  await Promise.allSettled(running.values());
  running.clear();
  for (const directory of scratch.splice(0)) {
    // Windows may still deny unlink on an executable image after all tested
    // PIDs have exited. Keep bounded retries in teardown and surface the last error.
    await rm(directory, {
      recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50,
    });
  }
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
  const { executable, args } = await treeCommand(directory, mode);
  const testStart = Date.now();
  const result = runProcess(executable, args, {
    cwd: directory, signal: controller.signal, timeoutMs: 7000, graceMs: 250,
  });
  running.set(controller, result);
  const outcome = mode === 'cancel'
    ? expect(result).rejects.toThrow('取消')
    : expect(result).resolves.toMatchObject({ exitCode: 23 });
  await waitFor(() => stat(join(directory, 'leaf-ready')).then(() => true, () => false));
  const [owner] = activeProcessGroups();
  expect(owner?.pid).toBeGreaterThan(0);
  expect(owner?.startedAtMs).toBeGreaterThanOrEqual(testStart - 5);
  expect(owner?.startedAtMs).toBeLessThanOrEqual(Date.now() + 5);
  const pids = await Promise.all([0, 1, 2].map(async depth => Number(await readFile(join(directory, 'pid-' + depth), 'utf8'))));
  expect(await Promise.all(pids.map(hasExited))).toEqual([false, false, false]);
  if (mode === 'cancel') controller.abort();
  else await writeFile(join(directory, 'release-root'), '');
  await outcome;
  expect(activeProcessGroups()).toHaveLength(0);
  // Both surviving descendants must receive the graceful signal. A root
  // deliberately released before cleanup must retain its own exit code.
  const stopped = (await readdir(directory)).filter(name => name.startsWith('stopped-')).sort();
  expect(stopped).toEqual(mode === 'cancel' ? ['stopped-0', 'stopped-1', 'stopped-2'] : ['stopped-1', 'stopped-2']);
  for (const name of stopped) expect(await readFile(join(directory, name), 'utf8')).toBe(expectedSignal);
  for (const pid of pids) await waitFor(() => hasExited(pid));
  await waitFor(() => hasExited(owner!.pid));
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
    'const [module, fixture, dir] = process.argv.slice(1); const { runProcess } = await import(module); await runProcess(process.execPath, [fixture, dir, "0", "cancel"], {recoveryDir: dir, executionId:"interrupted-attempt"});',
    runModule, fixture, directory,
  ], { shell: false, stdio: 'ignore' });
  try {
    await waitFor(() => stat(join(directory, 'leaf-ready')).then(() => true, () => false));
    const pids = await Promise.all([0, 1, 2].map(async depth => Number(await readFile(join(directory, 'pid-' + depth), 'utf8'))));
    client.kill('SIGKILL');
    expect(await recoverProcessGroups(directory)).toEqual({ recovered:['interrupted-attempt'], unresolved:[] });
    expect(await recoverProcessGroups(directory)).toEqual({ recovered:[], unresolved:[] });
    for (const pid of pids) await waitFor(() => hasExited(pid));
    expect(await readFile(join(directory, 'stopped-2'), 'utf8')).toBe(expectedSignal);
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

it('提示通过 stdin 传达，正常退出时移除持久化进程登记',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'concordia lease ')); scratch.push(dir);
  const input='含中文与换行\n$unexpanded';
  const result=await runProcess(process.execPath,['-e',"process.stdin.pipe(process.stdout)"],{stdin:input,recoveryDir:dir,executionId:'ok'});
  expect(result.stdout).toBe(input);
  expect(await readdir(dir)).toEqual([]);
});

it('过期登记指向另一个活进程组时保留记录，绝不向该组发信',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'concordia stale ')); scratch.push(dir);
  const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',shell:false});
  try {
    const id=randomUUID();
    await writeFile(join(dir,id+'.json'),JSON.stringify({id,pid:other.pid,startedAtMs:1,executionId:'old'}));
    expect(await recoverProcessGroups(dir)).toEqual({recovered:[],unresolved:['old']});
    expect(await hasExited(other.pid!)).toBe(false);
  } finally { other.kill('SIGKILL'); }
},10000);

it('重新核对只处理初次遗留的登记，旧组退出后解除限制且不干扰新登记', async () => {
  const dir = await mkdtemp(join(tmpdir(),'concordia recheck '));
  scratch.push(dir);
  const other = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',shell:false});
  const register = async (executionId:string) => {
    const id = randomUUID();
    await writeFile(join(dir,id+'.json'),JSON.stringify({id,pid:other.pid,startedAtMs:1,executionId}));
    return id;
  };
  try {
    await register('old');
    const recovery = await startProcessRecovery(dir);
    expect(recovery.report()).toEqual({recovered:[],unresolved:['old']});
    const active = await register('new');
    const exit = once(other, 'exit');
    other.kill('SIGKILL');
    await exit;
    const reports = await Promise.all([recovery.recheck(), recovery.recheck()]);
    for (const report of reports) expect(report).toEqual({recovered:['old'],unresolved:[]});
    expect(await readdir(dir)).toEqual([active+'.json']);
  } finally { if (!other.killed) other.kill('SIGKILL'); }
}, 15_000);
