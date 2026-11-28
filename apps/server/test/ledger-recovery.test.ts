import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore } from '@concordia/store';
import { copyApplicationState } from '../src/backup.ts';
import { acquireDataDirectory } from '../src/data-directory.ts';
import { startLocalServer } from '../src/local-server.ts';
import { git } from '../src/worktrees/git.ts';
import { browserSession } from './browser-session.ts';

let scratch: string, data: string, web: string;
let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;

async function start() {
  service = await startLocalServer(web, data);
  return browserSession(new URL(service.launchUrl));
}
async function stop() {
  await service?.close();
  service = undefined;
}
async function json(response: Promise<Response>) {
  const reply = await response;
  expect(reply.status).toBe(200);
  return reply.json();
}
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'concordia-ledger-recovery-'));
  data = join(scratch, 'data');
  web = join(scratch, 'web');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>Concordia</title>');
});
afterEach(async () => { await stop(); await rm(scratch, { recursive: true, force: true }); });

it('既有默认看板旁遗失目录库，重启不创建替代库；复原后仍保留上限及验收', async () => {
  let ui = await start();
  await json(ui.post('/api/demo/run', {}));
  await json(ui.post('/api/budgets/global/all', { maxCalls: 1 }, 'PUT'));
  const { acceptance } = await json(ui.get('/api/board'));
  expect(acceptance.integration).toBeTruthy();
  const budget = await json(ui.get('/api/budgets'));
  expect(budget.limits).toContainEqual({ scope: 'global', id: 'all', maxCalls: 1 });
  await stop();
  const file = join(data, 'catalog.sqlite'), saved = join(scratch, 'saved-catalog.sqlite');
  await rename(file, saved);
  await expect(start()).rejects.toThrow('目录库缺失');
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(copyApplicationState('create', data, join(scratch, 'copy'))).rejects.toThrow('目录库缺失');
  await expect(access(join(scratch, 'copy'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rename(saved, file);
  ui = await start();
  expect((await json(ui.get('/api/board'))).acceptance).toEqual(acceptance);
  expect(await json(ui.get('/api/budgets'))).toEqual(budget);
});

// Recreate the format-v1 manifest an older backup command wrote for a file tree.
// These fixtures contain only directories and ordinary files; no SQLite sidecars.
async function signLegacyFixture(dir: string) {
  const manifest = 'concordia-backup-v1.sha256';
  const digest = createHash('sha256');
  async function visit(relative: string) {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (path === manifest) continue;
      if (entry.isDirectory()) {
        digest.update(JSON.stringify([path, 'directory']) + '\n');
        await visit(path);
      } else {
        expect(entry.isFile()).toBe(true);
        const hash = createHash('sha256').update(await readFile(join(dir, path))).digest('hex');
        digest.update(JSON.stringify([path, 'file', hash]) + '\n');
      }
    }
  }
  await visit('');
  await writeFile(join(dir, manifest), digest.digest('hex') + '\n');
}

it('项目台账缺失时拒绝启动、创建备份以及恢复摘要仍正确的旧损坏备份', { timeout: 90_000 }, async () => {
  const repo = join(scratch, 'repo');
  await mkdir(repo);
  git(repo, ['init', '-b', 'main', '--template=']);
  await writeFile(join(repo, 'one.txt'), '合成数据');
  git(repo, ['add', '--', 'one.txt']);
  git(repo, ['commit', '-m', 'initial fixture']);
  let ui = await start();
  await json(ui.post('/api/worktrees/projects', { id: 'local', repository: repo, targetBranch: 'main', writeEnabled: true, commands: [] }));
  const tree = await json(ui.post('/api/worktrees/member', { projectId: 'local', taskId: 'one' }));
  await writeFile(join(tree.path, 'two.txt'), '已发布');
  const { sha } = await json(ui.post('/api/worktrees/publish', { treeId: tree.id }));
  await stop();
  const file = join(data, 'worktrees.sqlite'), saved = join(scratch, 'saved-worktrees.sqlite');
  const legacy = join(scratch, 'old-backup');
  await copyApplicationState('create', data, legacy);
  await rename(file, saved);
  await expect(start()).rejects.toThrow('工作树登记库缺失');
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(copyApplicationState('create', data, join(scratch, 'new-backup'))).rejects.toThrow('工作树登记库缺失');
  await expect(access(join(scratch, 'new-backup'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(legacy, 'worktrees.sqlite'));
  await signLegacyFixture(legacy);
  await expect(copyApplicationState('restore', legacy, join(scratch, 'restored'))).rejects.toThrow('工作树登记库缺失');
  await expect(access(join(scratch, 'restored'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rename(saved, file);
  ui = await start();
  const state = await json(ui.get('/api/worktrees/state'));
  expect(state.projects).toHaveLength(1);
  expect(state.trees).toContainEqual(expect.objectContaining({ id: tree.id, publishedShas: [sha] }));
  expect(await readFile(join(tree.path, 'two.txt'), 'utf8')).toBe('已发布');
});

it('既有版本绑定在工作树目录也丢失时仍阻止空库初始化', async () => {
  await mkdir(data, { mode: 0o700 });
  const catalog = openStore(join(data, 'catalog.sqlite'));
  try {
    catalog.prepare('INSERT INTO version_sources VALUES(?,?,?,?,?)').run('default', 'execution', 'abc', 'project', 'tree');
  } finally { catalog.close(); }
  await expect(start()).rejects.toThrow('工作树登记库缺失');
  for (const name of ['worktrees', 'worktrees.sqlite'])
    await expect(access(join(data, name))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('第一次启动在登记默认看板前退出时继续使用原看板', async () => {
  await start();
  await stop();
  const db = new DatabaseSync(join(data, 'catalog.sqlite'));
  try { db.exec('DELETE FROM workspaces'); } finally { db.close(); }
  const file = join(data, 'boards', 'default', 'workspace.sqlite');
  const board = new DatabaseSync(file);
  try { board.exec("INSERT INTO workflow_events(type,data) VALUES('fixture.marker','{}')"); } finally { board.close(); }
  const ui = await start();
  expect((await json(ui.get('/api/workspaces'))).active).toBe('default');
  await stop();
  const reopened = new DatabaseSync(file, { readOnly: true });
  try { expect(reopened.prepare("SELECT type FROM workflow_events WHERE type='fixture.marker'").get()?.type).toBe('fixture.marker'); }
  finally { reopened.close(); }
});


it('旧版首次启动可从仅有锁和空进程目录继续，并为尚无项目的旧目录库建立台账', async () => {
  const lease = acquireDataDirectory(data);
  try { await mkdir(join(lease.directory, 'processes')); } finally { lease.release(); }
  const ui = await start();
  expect((await json(ui.get('/api/workspaces'))).active).toBe('default');
  expect((await json(ui.get('/api/worktrees/state'))).trees).toEqual([]);
});

it('只有项目授权、还未建任务树的安装丢失台账也必须恢复', async () => {
  await start();
  await stop();
  const file = join(data, 'worktrees.sqlite');
  const treeDb = new DatabaseSync(file);
  try {
    treeDb.prepare('INSERT INTO projects(id,repository,target,writable,commands) VALUES(?,?,?,?,?)')
      .run('configured', join(scratch, 'example'), 'main', 0, '[]');
  } finally { treeDb.close(); }
  await rename(file, join(scratch, 'saved-ledger.sqlite'));
  expect(await readdir(join(data, 'worktrees'))).toEqual([]);
  await expect(start()).rejects.toThrow('工作树登记库缺失');
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['空 SQLite 文件', 'VACUUM'],
  ['其他应用的旧库', 'PRAGMA application_id=18; PRAGMA user_version=1'],
])('已有工作区被换成%s时，不能发布新备份或恢复清单正确的旧副本', async (_label, sql) => {
  await start();
  await stop();
  const legacy = join(scratch, 'legacy-backup');
  await copyApplicationState('create', data, legacy);
  for (const root of [data, legacy]) {
    const workspace = join(root, 'boards', 'default', 'workspace.sqlite');
    await rm(workspace);
    const foreign = new DatabaseSync(workspace);
    try {
      foreign.exec(sql);
    } finally {
      foreign.close();
    }
  }
  await signLegacyFixture(legacy);
  for (const [mode, from] of [
    ['create', data],
    ['restore', legacy],
  ] as const) {
    const to = join(scratch, mode);
    await expect(copyApplicationState(mode, from, to)).rejects.toThrow();
    await expect(access(to)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('匹配旧迁移记录的看板可通过备份检查并在恢复后迁移', async () => {
  await start();
  await stop();
  const relative = join('boards', 'default', 'workspace.sqlite');
  const workspace = join(data, relative);
  await rm(workspace);
  const old = new DatabaseSync(workspace);
  try {
    const migration = await readFile(
      new URL('../../../packages/store/migrations/001-bootstrap.sql', import.meta.url),
      'utf8',
    );
    old.exec(migration);
    old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(1, '001-bootstrap.sql');
    old.exec('PRAGMA user_version=1');
  } finally {
    old.close();
  }
  const copy = join(scratch, 'snapshot'),
    restored = join(scratch, 'restored');
  await copyApplicationState('create', data, copy);
  await copyApplicationState('restore', copy, restored);
  const upgraded = openStore(join(restored, relative), { mustExist: true });
  try {
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM workflow_state').get()?.n).toBe(0);
  } finally {
    upgraded.close();
  }
});
