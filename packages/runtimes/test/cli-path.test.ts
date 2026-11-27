import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CliAgentRuntime } from '../src/agent-runtime.ts';
import { inspectCli } from '../src/cli.ts';
import { resolveExecutable } from '../src/environment.ts';
import { ExecutionMcpServer } from '../src/mcp.ts';
import { runProcess } from '../src/process.ts';

vi.mock('../src/process.ts', () => ({runProcess: vi.fn()}));

let base: string;
const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
const privateError = expect.objectContaining({kind:'permission'});
const dirLink = (target: string, alias: string) => symlink(target,alias,process.platform === 'win32' ? 'junction' : 'dir');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(),'concordia-path-'));
  vi.clearAllMocks();
});
afterEach(async () => { await rm(base,{recursive:true,force:true}); });

it.each(['.claude','.codex','.claude.json','.CLAUDE.json.backup'])('预检在检查或启动程序前排除 %s', async segment => {
  const root = join(base,segment);
  // Intentionally absent. The diagnostic must come from the path policy.
  await expect(inspectCli('codex',{cwd:root,executable:process.execPath,env:{}})).rejects.toThrow(privateError);
  await expect(resolveExecutable('codex',{},join(root,name))).rejects.toThrow(privateError);
  expect(runProcess).not.toHaveBeenCalled();
});

it('私有目录存在于链接链中即停止，即使最终目标在公开位置', async () => {
  const credentialDir = join(base,'.codex');
  const alias = join(base,'alias');
  const publicBin = join(base,'public-bin');
  await mkdir(credentialDir);
  await mkdir(publicBin);
  await writeFile(join(publicBin,name),'', {mode:0o700});
  await dirLink(publicBin,join(credentialDir,'out'));
  await dirLink(join(credentialDir,'out'),alias);
  await expect(resolveExecutable('codex',{},join(alias,name))).rejects.toThrow(privateError);
  await expect(inspectCli('codex',{cwd:alias,env:{}})).rejects.toThrow(privateError);
  const runtime = new CliAgentRuntime({kind:'codex',connectionId:'connection',env:{}},new ExecutionMcpServer(async () => null),new Map());
  const input = {executionId:'execution',memberId:'member',taskId:'task',prompt:'test',permission:'read-only' as const,mcpOrigin:'http://127.0.0.1'};
  await expect(runtime.run({...input,cwd:alias},() => {})).rejects.toThrow(privateError);
  await expect(runtime.run({...input,cwd:publicBin,authorizedWorktree:alias},() => {})).rejects.toThrow(privateError);
  expect(runProcess).not.toHaveBeenCalled();
});

it('PATH 自动跳过私有目录，且程序检查保留环境覆盖的私有根目录', async () => {
  const hidden = join(base,'selected-config');
  const publicBin = join(base,'bin');
  await mkdir(publicBin);
  await writeFile(join(publicBin,name),'', {mode:0o700});
  const env = {CODEX_HOME:hidden, PATH:[hidden,publicBin].join(delimiter)};
  expect(await resolveExecutable('codex',env)).toBe(await realpath(join(publicBin,name)));
  await expect(resolveExecutable('codex',{...env,PATH:hidden})).rejects.toThrow(privateError);
  await expect(inspectCli('codex',{cwd:base,env,executable:join(hidden,name)})).rejects.toThrow(privateError);
  expect(runProcess).not.toHaveBeenCalled();
});

it('多重硬链接的可执行文件无法证明不与认证文件共用，拒绝启动', async () => {
  const config = join(base,'.codex');
  await mkdir(config);
  const target = join(config,'auth.json');
  await writeFile(target,'', {mode:0o700});
  const executable = join(base,name);
  await link(target,executable);
  await expect(resolveExecutable('codex',{},executable)).rejects.toThrow(/硬链接/);
});

it.skipIf(process.platform === 'win32')('支持 Claude 官方原生安装的相对链接，预检固定到版本文件', async () => {
  const local = join(base,'.local');
  const bin = join(local,'bin');
  const versions = join(local,'share','claude','versions');
  await mkdir(bin,{recursive:true});
  await mkdir(versions,{recursive:true});
  const target = join(versions,'1.2.3');
  await writeFile(target,'',{mode:0o700});
  await symlink('../share/claude/versions/1.2.3',join(bin,'claude'));
  expect(await resolveExecutable('claude',{PATH:bin})).toBe(await realpath(target));
});

it('系统临时目录指向私有目录时不创建探针工作目录', async () => {
  const config = join(base,'.claude');
  await mkdir(config);
  const alias = join(base,'temp');
  await dirLink(config,alias);
  try {
    for (const variable of ['TMPDIR','TEMP','TMP']) vi.stubEnv(variable,alias);
    await expect(inspectCli('codex',{env:{},executable:process.execPath})).rejects.toThrow(privateError);
    expect(runProcess).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it.skipIf(process.platform === 'win32')('公开 bin 中指入私有目录的文件链接在 PATH 中也不可执行', async () => {
  const bin = join(base,'bin');
  await mkdir(bin);
  // A missing target avoids ever creating simulated credentials.
  await symlink('../.codex/config.toml',join(bin,'codex'));
  await expect(resolveExecutable('codex',{PATH:bin})).rejects.toThrow(privateError);
});
