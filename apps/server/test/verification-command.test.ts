import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const windows = process.platform === 'win32';
let directory: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

const executable = (kind: string) => join(directory, kind + (windows ? '.exe' : ''));

async function installWindowsFixtures(systemRoot: string) {
  // .NET Framework is included with supported Windows desktop versions.
  const compiler = ['Framework64', 'Framework']
    .map(folder => join(systemRoot, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'))
    .find(path => existsSync(path));
  if (!compiler) throw new Error('Windows 测试夹具需要系统 .NET Framework 4.x 的 csc.exe。');
  const fixture = fileURLToPath(new URL('./fixtures/FakeCli.cs', import.meta.url));
  await execute(compiler, ['/nologo', '/target:exe', '/out:' + executable('claude'), fixture], {
    cwd: directory, windowsHide: true, shell: false,
  });
  await copyFile(executable('claude'), executable('codex'));
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'concordia-verify-'));
  cwd = join(directory, 'working dir');
  await mkdir(cwd);
  if (windows) {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error('Windows 测试需要系统的 SystemRoot。');
    env = { SystemRoot: systemRoot, TEMP: directory, TMP: directory, PATH: join(systemRoot, 'System32') };
    await installWindowsFixtures(systemRoot);
  } else {
    env = { TMPDIR: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    const node = await realpath(process.execPath);
    const fixture = await readFile(join(root, 'packages/runtimes/test/fixtures/fake-cli.cjs'), 'utf8');
    for (const kind of ['claude', 'codex']) {
      await writeFile(executable(kind), '#!' + node + '\n' + fixture, { mode: 0o700 });
    }
  }
  env.UNLISTED_DEMO = 'omit';
}, 30_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function verify(args: string[], environment = env) {
  return execute(process.execPath, ['--import', 'tsx', 'apps/server/src/verify.ts', ...args], {
    cwd: root, env: environment, shell: false, windowsHide: true, timeout: 45_000, encoding: 'utf8',
  });
}

it.each(['claude', 'codex'] as const)('%s 的验证命令在桌面 PATH 缺失时给出绝对路径诊断', async kind => {
  // Use a known empty directory so discovery cannot ever invoke an installed CLI.
  const flags = kind === 'claude' ? ['--confirm-unmanaged'] : [];
  await expect(verify(['inspect', kind, ...flags], { ...env, PATH: cwd }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/PATH.*绝对路径/u) });
});

it.each(['claude', 'codex'] as const)('%s 的绝对路径通过独立验证命令完成预检、批准和文本回显', async kind => {
  const flags = ['--executable', executable(kind), '--cwd', cwd];
  if (kind === 'claude') flags.push('--confirm-unmanaged');
  const inspected = await verify(['inspect', kind, ...flags]);
  const report = JSON.parse(inspected.stdout);
  expect(report).toMatchObject({ kind, executable: executable(kind), version: '1.2.3', login: '已登录', billing: '未知' });
  expect(report.inspectionId).toEqual(expect.any(String));
  const ran = await verify(['run', kind, '--approve-call', '--inspection', report.inspectionId, ...flags]);
  expect(JSON.parse(ran.stdout)).toMatchObject({ kind, executable: executable(kind), text: 'CONCORDIA_OK' });
}, 90_000);
