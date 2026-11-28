import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore } from '@concordia/store';
import { openWorktrees } from '../src/worktrees/service.ts';
import { copyApplicationState } from '../src/backup.ts';
import { acquireDataDirectory } from '../src/data-directory.ts';

let root: string;
let source: string;
let snapshot: string;
let restored: string;
const contents = '验收时核对的成果';
const hash = createHash('sha256').update(contents).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'concordia-recovery-'));
  source = join(root, 'source');
  snapshot = join(root, 'snapshot');
  restored = join(root, 'restored');
  const lock = acquireDataDirectory(source);
  try {
    const db = openStore(join(source, 'catalog.sqlite'));
    db.prepare('INSERT INTO quota_pools VALUES (?, ?)').run('qa', JSON.stringify({ id: 'qa', name: 'QA', maxConcurrent: 1 }));
    db.close();
    const board = join(source, 'boards', 'demo');
    await mkdir(join(board, 'objects'), { recursive: true });
    const workflow = openStore(join(board, 'workspace.sqlite'));
    workflow.prepare('INSERT INTO workflow_events(type,data) VALUES (?,?)').run('version.published', JSON.stringify({ contentRef: hash }));
    workflow.close();
    await writeFile(join(board, 'objects', hash), contents);
    // A real initialized project layout has a worktree ledger alongside its checkouts.
    await openWorktrees(source).close();
    await mkdir(join(source, 'worktrees', 'task'), { recursive: true });
    await writeFile(join(source, 'worktrees', 'task', 'project.txt'), '用户尚未提交的代码');
  } finally { lock.release(); }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('恢复已提交的 SQLite/WAL、事件、内容对象和未提交的 worktree 文件', async () => {
  const catalog = openStore(join(source, 'catalog.sqlite'));
  try {
    catalog.prepare('INSERT INTO quota_pools VALUES (?, ?)').run('two', JSON.stringify({ id: 'two', name: 'Two', maxConcurrent: 2 }));
    await access(join(source, 'catalog.sqlite-wal'));
    await copyApplicationState('create', source, snapshot);
  } finally { catalog.close(); }
  await copyApplicationState('restore', snapshot, restored);
  const db = openStore(join(restored, 'catalog.sqlite'));
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM quota_pools').get()?.n).toBe(2); } finally { db.close(); }
  const board = openStore(join(restored, 'boards/demo/workspace.sqlite'));
  try { expect(board.prepare('SELECT type FROM workflow_events').get()?.type).toBe('version.published'); } finally { board.close(); }
  expect(await readFile(join(restored, 'boards/demo/objects', hash), 'utf8')).toBe(contents);
  expect(await readFile(join(restored, 'worktrees/task/project.txt'), 'utf8')).toBe('用户尚未提交的代码');
  await expect(access(join(snapshot, 'server-lock.sqlite'))).rejects.toThrow();
});

it('演练的数据库、示例仓库和内容也位于快照中，运行时 PID 现场除外', async () => {
  const demo = join(source, 'assignee-delivery');
  await mkdir(join(demo, 'example-test', '.git'), {recursive:true});
  await writeFile(join(demo, 'example-test', '.git', 'HEAD'), 'ref: refs/heads/main');
  const ledger = openStore(join(demo, 'delivery.sqlite'));
  ledger.exec("CREATE TABLE rehearsal (phase TEXT); INSERT INTO rehearsal VALUES ('ready')");
  ledger.close();
  await mkdir(join(source, 'processes'));
  await writeFile(join(source, 'processes', 'placeholder'), '模拟运行登记');
  await copyApplicationState('create', source, snapshot);
  await copyApplicationState('restore', snapshot, restored);
  expect(await readFile(join(restored,'assignee-delivery/example-test/.git/HEAD'),'utf8')).toBe('ref: refs/heads/main');
  const db = openStore(join(restored, 'assignee-delivery/delivery.sqlite'));
  try { expect(db.prepare('SELECT phase FROM rehearsal').get()?.phase).toBe('ready'); } finally { db.close(); }
  await expect(access(join(restored,'processes'))).rejects.toThrow();
});

it('拒绝占用中的目录、重叠目录和覆盖旧备份', async () => {
  const lock = acquireDataDirectory(source);
  try { await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('占用'); } finally { lock.release(); }
  await expect(copyApplicationState('create', source, join(source,'nested'))).rejects.toThrow();
  await mkdir(snapshot);
  await writeFile(join(snapshot, 'keep'), contents);
  await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow();
  expect(await readFile(join(snapshot, 'keep'), 'utf8')).toBe(contents);
});

it('遇到损坏的内容或篡改后的备份时，目标不发布', async () => {
  const file = join(source, 'boards/demo/objects', hash);
  await writeFile(file, '损坏');
  await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('SHA-256');
  await expect(access(snapshot)).rejects.toThrow();
  await writeFile(file, contents);
  await copyApplicationState('create', source, snapshot);
  await writeFile(join(snapshot, 'worktrees/task/project.txt'), '篡改');
  await expect(copyApplicationState('restore', snapshot, restored)).rejects.toThrow('摘要');
  await expect(access(restored)).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')('备份只保留 worktree 链接本身，拒绝应用文件符号链接', async () => {
  const link = 'worktrees/task/link';
  await symlink('outside-missing', join(source, link));
  await copyApplicationState('create', source, snapshot);
  await copyApplicationState('restore', snapshot, restored);
  expect((await lstat(join(restored,link))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(restored,link))).toBe('outside-missing');

  const boardObjects = join(source, 'boards/demo/objects');
  await rm(boardObjects, {recursive:true});
  await symlink(join(root,'missing'), boardObjects);
  await expect(copyApplicationState('create', source, join(root,'unsafe'))).rejects.toThrow('外部文件');
});

it('源目录缺少已登记的工作区时拒绝发布', async () => {
  const catalog = openStore(join(source, 'catalog.sqlite'));
  catalog.exec("INSERT INTO workspaces VALUES ('missing','旧工作区',0)");
  catalog.close();
  await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('已登记的工作区');
  await expect(access(snapshot)).rejects.toThrow();
});

it('检查活动状态、历史事件及已归档计划内部的正文引用', async () => {
  const { emptyState } = await import('@concordia/core/state');
  const dir = join(source, 'boards/demo');
  const db = openStore(join(dir, 'workspace.sqlite'));
  const missing = createHash('sha256').update('尚不存在的正文').digest('hex');
  const archive = JSON.stringify({ ...emptyState(), plans: [missing] });
  const ref = createHash('sha256').update(archive).digest('hex');
  try {
    await writeFile(join(dir, 'objects', ref), archive);
    const save = db.prepare('INSERT OR REPLACE INTO workflow_state VALUES(1,?)');
    save.run(JSON.stringify({ ...emptyState(), archives: [{ id: 'previous', title: '已归档', ref }] }));
    await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('内容对象');
    save.run(JSON.stringify({ ...emptyState(), tasks: [{ progressRef: missing }] }));
    await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('内容对象');
    save.run(JSON.stringify(emptyState()));
    await rm(join(dir, 'objects', hash));
    await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('内容对象');
    await expect(access(snapshot)).rejects.toThrow();
  } finally { db.close(); }
});

it('崩溃遗留登记阻止备份，原机核对并清除后允许备份', async () => {
  const dir = join(source, 'processes');
  await mkdir(dir);
  const record = join(dir, '35c03b8a-e901-4505-8704-88ca79947ae5.json');
  await writeFile(record, '{}');
  await expect(copyApplicationState('create', source, snapshot)).rejects.toThrow('待核对');
  expect(await readFile(record, 'utf8')).toBe('{}');
  await expect(access(snapshot)).rejects.toThrow();
  await rm(record);
  await copyApplicationState('create', source, snapshot);
});
