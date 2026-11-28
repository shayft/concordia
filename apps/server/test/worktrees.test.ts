import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openWorktrees, type WorktreeService } from '../src/worktrees.ts';
import { git as platformGit, sameDirectory } from '../src/worktrees/git.ts';

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

it('项目授权、成员隔离、不可变快照、逐项命令审批、目标分支合并与清理', { timeout: 60_000 }, async () => {
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

it('冲突保留原仓库并定位负责人；重开服务保留所有权与已发布版本', { timeout: 60_000 }, () => {
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
  expect(service.state().issues).toEqual([
    expect.objectContaining({ taskIds: ['one', 'two'], paths: ['file.txt'] }),
  ]);
  expect(() => service.reviewMerge(result.tree.id)).toThrow();
  expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('baseline');
});

it('只允许成员树中的普通文件，拒绝父目录、元数据、链接、硬链接和撤销的授权', { timeout: 60_000 }, () => {
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
    '.git\ufe0f',
    'COM¹.txt',
  ]) {
    expect(() => service.read(t.id, path)).toThrow();
    expect(() => service.write(t.id, path, 'bad')).toThrow();
  }
  expect(readFileSync(join(outside, 'safe'), 'utf8')).toBe('keep');
  service.configure(config(false));
  expect(() => service.write(t.id, 'new.txt', 'no')).toThrow();
});

it('关闭服务时中止已获批的项目命令，并在关闭 SQLite 之前登记失败', { timeout: 60_000 }, async () => {
  const project = config(true);
  project.commands = [
    { name: 'test', executable: process.execPath, args: ['-e', 'setInterval(()=>{},100)'] },
  ];
  service.configure(project);
  const tree = service.member('demo', 'cancel');
  const approval = service.requestCommand(tree.id, 'test');
  const result = expect(service.approveCommand(approval.id)).rejects.toThrow('取消');
  await service.close();
  await result;
  service = openWorktrees(data);
  expect(service.state().results).toContainEqual(
    expect.objectContaining({ treeId: tree.id, status: 'failed' }),
  );
});

it('同项目的两份计划和旧手工树在同名任务上互相隔离', { timeout: 60_000 }, () => {
  service.configure(config(true));
  const manual = service.member('demo', 'shared');
  const a = service.member('demo', 'shared', 'board-a/plan');
  const b = service.member('demo', 'shared', 'board-b/plan');
  expect(new Set([manual.id, a.id, b.id]).size).toBe(3);
  expect(() => service.executionTree('demo', 'shared', a.id, 'board-b/plan')).toThrow();
  expect(() => service.publishForTask('demo', 'shared', manual.id, 'board-a/plan')).toThrow();
  expect(service.member('demo', 'shared', 'board-a/plan').id).toBe(a.id);
  const another = service.member('demo', 'other', 'board-b/plan');
  const av = service.publishForTask('demo', 'shared', a.id, 'board-a/plan'),
    other = service.publish(another.id);
  expect(() => service.integrate('demo', [av, other])).toThrow();
});

it('仓库离线时仍能打开其他项目、读取冲突快照，并保留不可批准的票据', { timeout: 60_000 }, async () => {
  service.configure(config(true));
  const left = service.member('demo', 'left'),
    right = service.member('demo', 'right');
  service.write(left.id, 'file.txt', 'left');
  service.write(right.id, 'file.txt', 'right');
  service.write(left.id, 'new.txt', 'yes');
  const leftVersion = service.publish(left.id),
    rightVersion = service.publish(right.id);
  const conflict = service.integrate('demo', [leftVersion, rightVersion]).tree;
  const cleanTree = service.integrate('demo', [leftVersion]).tree;
  expect((await service.approveCommand(service.requestCommand(cleanTree.id, 'test').id)).passed).toBe(true);
  const pending = service.reviewMerge(cleanTree.id);
  const other = join(base, 'other');
  mkdirSync(other);
  run(other, 'init', '-q', '-b', 'main');
  run(other, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '--allow-empty', '-qm', 'base');
  service.configure({ ...config(true), id: 'other', repository: other });
  renameSync(repo, repo + '-offline');
  expect(service.issues()[0]?.id).toBe(conflict.id);
  expect(service.issueSnapshot(conflict.id)).toEqual(
    [leftVersion, rightVersion].map(({ treeId, sha }) => ({ treeId, sha })),
  );
  expect(service.state().approvals).toContainEqual(
    expect.objectContaining({ id: pending.id, available: false }),
  );
  expect(() => service.approveMerge(pending.id)).toThrow();
  expect(service.member('other', 'still-here').status).toBe('ready');
});

it('平台 Git 使用普通文件屏蔽外部全局配置和项目预提交钩子', { timeout: 60_000 }, () => {
  expect(platformGit(repo, ['config', '--global', '--name-only', '--list']).trim()).toBe('');
  const defaults = platformGit(repo, ['config', '--get', 'core.hooksPath']).trim();
  expect(readFileSync(defaults, 'utf8')).toMatch(/^# Concordia/);
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 72\n');
  chmodSync(hook, 0o755);
  service.configure(config(true));
  const member = service.member('demo', 'hook-check');
  service.write(member.id, 'new.txt', 'ordinary change');
  expect(service.publish(member.id).sha).not.toBe(member.base);
});

it('以文件系统身份校验目录，拒绝其他目录和链接，接受 Windows 路径大小写差异', () => {
  const alias = process.platform === 'win32' ? repo.toUpperCase() : realpathSync.native(repo);
  expect(sameDirectory(repo, alias)).toBe(true);
  expect(sameDirectory(repo, data)).toBe(false);
  const link = join(base, 'alias-root');
  symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => sameDirectory(repo, link)).toThrow();
  service.configure({ ...config(true), repository: alias });
  expect(service.member('demo', 'identity').status).toBe('ready');
});

it('成员差异分别显示暂存、工作文件及已发布版本，只读访问不会改变索引或分支', () => {
  service.configure(config(true));
  const tree = service.member('demo', 'diff', 'scope');
  service.write(tree.id, 'file.txt', 'published');
  const published = service.publish(tree.id);
  service.write(tree.id, 'file.txt', 'staged');
  run(tree.path, 'add', '--', 'file.txt');
  service.write(tree.id, 'file.txt', 'unstaged');
  service.write(tree.id, 'new.txt', 'untracked');
  const before = run(tree.path, 'status', '--porcelain');
  service.configure(config(false));
  const working = service.memberDiff(tree.id, undefined, 'scope');
  expect(working.untracked).toEqual(['new.txt']);
  for (const line of ['+staged', '+unstaged', '+untracked']) expect(working.diff).toContain(line);
  expect(service.memberDiff(tree.id, published.sha, 'scope').diff).toContain('+published');
  expect(() => service.memberDiff(tree.id, undefined, 'other')).toThrow();
  expect(() => service.memberDiff(tree.id, tree.base, 'scope')).toThrow();
  expect(run(tree.path, 'status', '--porcelain')).toBe(before);
  expect(run(tree.path, 'rev-parse', 'HEAD')).toBe(published.sha);
});
