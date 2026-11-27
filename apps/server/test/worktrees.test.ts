import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorktrees, type WorktreeService } from '../src/worktrees.ts';

let base: string, repo: string, data: string, service: WorktreeService;
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', shell: false }).trim();
const declaration = {
  name: 'test',
  executable: process.execPath,
  args: ['-e', "if (!require('fs').existsSync('new.txt')) process.exit(9)"],
};
const config = (writeEnabled: boolean) => ({
  id: 'demo',
  repository: repo,
  targetBranch: 'main',
  writeEnabled,
  commands: [declaration],
});
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'concordia worktrees ')));
  repo = join(base, 'repo');
  data = join(base, 'data');
  mkdirSync(repo);
  run(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'file.txt'), 'baseline');
  run(repo, 'add', '--', '.');
  run(
    repo,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@localhost',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'base',
  );
  service = openWorktrees(data);
});
afterEach(() => {
  service.close();
  rmSync(base, { recursive: true, force: true });
});

it('项目授权、成员隔离、不可变快照、逐项命令审批、目标分支合并与清理', async () => {
  service.configure(config(false));
  expect(() => service.member('demo', 'frontend')).toThrow();
  service.configure(config(true));
  const a = service.member('demo', 'frontend'),
    b = service.member('demo', 'backend');
  expect(a.path).not.toBe(b.path);
  expect(() => service.executionTree('demo', 'backend', a.id)).toThrow();
  service.write(a.id, 'new.txt', 'v1');
  const v1 = service.publishForTask('demo', 'frontend', a.id);
  service.write(a.id, 'new.txt', 'v2');
  service.publish(a.id);
  service.write(b.id, 'nested/api.txt', 'ok');
  expect(service.readPublication('demo', a.id, v1.sha, 'new.txt')).toBe('v1');
  const api = service.publish(b.id);
  const integration = service.integrate('demo', [v1, api]).tree;
  expect(service.read(integration.id, 'new.txt')).toBe('v1');
  expect(service.read(integration.id, 'nested/api.txt')).toBe('ok');
  expect(() => service.write(integration.id, 'new.txt', 'wrong')).toThrow();
  expect(() => service.requestCommand(integration.id, 'unregistered')).toThrow();
  expect(() => service.reviewMerge(integration.id)).toThrow();
  const request = service.requestCommand(integration.id, 'test');
  expect(await service.approveCommand(request.id)).toMatchObject({ passed: true, exitCode: 0 });
  await expect(service.approveCommand(request.id)).rejects.toThrow();
  const preview = service.reviewMerge(integration.id);
  expect(preview.diff).toContain('+v1');
  expect(existsSync(join(repo, 'new.txt'))).toBe(false);
  writeFileSync(join(repo, 'personal.txt'), 'keep');
  expect(service.approveMerge(preview.id).merged).toBe(false);
  unlinkSync(join(repo, 'personal.txt'));
  const next = service.reviewMerge(integration.id);
  expect(service.approveMerge(next.id).merged).toBe(true);
  expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('v1');
  expect(() => service.approveMerge(next.id)).toThrow();
  const foreign = join(base, 'foreign');
  run(repo, 'worktree', 'add', '--detach', foreign, 'HEAD');
  expect(() => service.remove(foreign)).toThrow();
  service.remove(a.id);
  expect(existsSync(a.path)).toBe(false);
  expect(existsSync(foreign)).toBe(true);
  expect(run(repo, 'rev-parse', a.branch)).not.toBe('');
  expect(run(repo, 'remote')).toBe('');
});

it('冲突保留原仓库并定位负责人；重开服务保留所有权与已发布版本', () => {
  service.configure(config(true));
  const a = service.member('demo', 'one'),
    b = service.member('demo', 'two');
  service.write(a.id, 'file.txt', 'first');
  service.write(b.id, 'file.txt', 'second');
  const versions = [service.publish(a.id), service.publish(b.id)];
  service.close();
  service = openWorktrees(data);
  const result = service.integrate('demo', versions);
  expect(result).toMatchObject({ ownerTaskId: 'two', conflicts: ['file.txt'], tree: { status: 'conflict' } });
  expect(() => service.reviewMerge(result.tree.id)).toThrow();
  expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('baseline');
});

it('只允许成员树中的普通文件，拒绝父目录、元数据、链接、硬链接和撤销的授权', () => {
  service.configure(config(true));
  const t = service.member('demo', 'files');
  const outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'safe'), 'keep');
  symlinkSync(outside, join(t.path, 'portal'), process.platform === 'win32' ? 'junction' : 'dir');
  linkSync(join(outside, 'safe'), join(t.path, 'hard'));
  for (const path of [
    '../outside/safe',
    'portal/safe',
    'hard',
    '.git',
    'foo/../../foo',
    'x:y',
    'dir\\..\\outside',
    '../.codex',
  ]) {
    expect(() => service.read(t.id, path)).toThrow();
    expect(() => service.write(t.id, path, 'bad')).toThrow();
  }
  expect(readFileSync(join(outside, 'safe'), 'utf8')).toBe('keep');
  service.configure(config(false));
  expect(() => service.write(t.id, 'new.txt', 'no')).toThrow();
});
