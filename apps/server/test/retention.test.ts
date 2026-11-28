import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyState } from '@concordia/core/state';
import { openStore } from '@concordia/store';
import { ContentStore } from '@concordia/store/content';
import { privateTemporaryDirectory, safeDataDirectory } from '@concordia/store/paths';
import { backupManifestNames } from '../src/backup-manifest.ts';
import { acquireDataDirectory } from '../src/data-directory.ts';
import { workspaceRetention } from '../src/retention.ts';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';

let root: string, boardDir: string, otherDir: string, files: ContentStore;
const state = (ref: string) => ({ ...emptyState(), plans: [ref] });
function changeState(board: string, value: object) {
  const db = openStore(join(board, 'workspace.sqlite'));
  try { db.prepare('INSERT OR REPLACE INTO workflow_state VALUES(1,?)').run(JSON.stringify(value)); }
  finally { db.close(); }
}
function old(value: string) {
  const id = files.put(value);
  const when = new Date(Date.now() - 90 * 86_400_000);
  utimesSync(join(boardDir, 'objects', id), when, when);
  return id;
}
const preview = (confirm?: string) => workspaceRetention({ dataDir: root, workspace: 'default', confirm });
beforeEach(() => {
  root = privateTemporaryDirectory(tmpdir(), 'concordia-retention-');
  acquireDataDirectory(root).release();
  const catalog = openStore(join(root, 'catalog.sqlite'));
  try { catalog.exec("INSERT INTO workspaces VALUES('default','A',1),('other','B',0)"); }
  finally { catalog.close(); }
  boardDir = safeDataDirectory(root, 'boards', 'default');
  otherDir = safeDataDirectory(root, 'boards', 'other');
  files = new ContentStore(boardDir);
  changeState(boardDir, emptyState());
  changeState(otherDir, emptyState());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('保留归档图、事件、提议、规划结果、对象间引用及近期对象，仅回收批准的工作区孤儿', () => {
  const inArchive = old('旧计划');
  const archive = old(JSON.stringify(state(inArchive)));
  const proposal = old('提议详情');
  const fromEvent = old('历史事件正文');
  const planned = old('负责人生成的草案');
  const viaDraft = old('草案的内嵌引用');
  const escaped = old('历史 Unicode 转义的文本引用');
  const viaObject = old('发布引用');
  const published = old('说明材料 ' + viaObject);
  const stage = old('只有本工作区此副本未使用');
  const elsewhere = new ContentStore(otherDir).put('只有本工作区此副本未使用');
  expect(elsewhere).toBe(stage);
  changeState(otherDir, state(elsewhere));
  const recent = files.put('尚未到期');
  changeState(boardDir, { ...state(published), archives: [{ id: 'old', title: '归档', ref: archive }], proposals: [{ executionId: 'proposal', action: { note: proposal } }] });
  const board = openStore(join(boardDir, 'workspace.sqlite'));
  board.prepare('INSERT INTO workflow_events(type,data) VALUES(?,?)').run('execution.late', JSON.stringify({ contentRef: fromEvent }));
  const encoded = escaped.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  board.prepare('UPDATE plan_draft SET text=?').run('{"object":"' + encoded + '","draft":"' + viaDraft + '"}');
  board.close();
  const catalog = openStore(join(root, 'catalog.sqlite'));
  catalog.prepare('INSERT INTO plan_requests(id,workspace,member,connection,started,status,result_ref) VALUES(?,?,?,?,?,?,?)')
    .run('req', 'default', 'owner', 'model', 1, 'proposed', planned);
  catalog.close();
  const before = preview();
  expect(before.inventory).toMatchObject({
    archivedPlans: 1, historyEvents: 1, planningRequests: 1, planningResults: 1,
    proposals: 1, hasDraft: true
  });
  expect(before.entries.filter(f => f.reason === '未引用且已到期').map(f => f.hash)).toEqual([stage]);
  expect(before.entries.find(f => f.hash === planned)?.reason).toBe('规划结果');
  expect(before.entries.find(f => f.hash === recent)?.reason).toBe('保留期内');
  expect(JSON.stringify(before)).not.toContain('负责人生成的草案');
  expect(files.get(stage)).toBeTruthy();
  // A change to either the catalog's references or the candidate file invalidates old approval.
  const updated = old('另一个孤儿');
  expect(() => preview(before.previewId)).toThrow(/重新预览/);
  const current = preview();
  expect(preview(current.previewId).removed).toBe(2);
  expect(existsSync(join(boardDir, 'objects', stage))).toBe(false);
  expect(existsSync(join(boardDir, 'objects', updated))).toBe(false);
  expect(new ContentStore(otherDir).get(elsewhere)).toBeTruthy();
  expect(preview().eligible).toBe(0);
  expect(() => preview(current.previewId)).toThrow();
  expect(files.get(escaped)).toBeTruthy();
}, 60_000);

it('缺少归档、未知迁移或数据库写者在场时保持现场', () => {
  const target = old('旧内容');
  const expected = preview();
  const lease = acquireDataDirectory(root);
  try { expect(() => preview(expected.previewId)).toThrow(); } finally { lease.release(); }
  const busy = openStore(join(boardDir, 'workspace.sqlite'));
  busy.exec('BEGIN IMMEDIATE');
  try { expect(() => preview(expected.previewId)).toThrow(); } finally { busy.close(); }
  const extra = openStore(join(boardDir, 'workspace.sqlite'));
  try {
    extra.exec('CREATE TABLE not_in_this_release (body TEXT)');
    expect(() => preview(expected.previewId)).toThrow(/实际数据库结构/);
    extra.exec('DROP TABLE not_in_this_release');
  } finally { extra.close(); }
  changeState(boardDir, { ...emptyState(), archives: [{ id: 'missing', ref: '0'.repeat(64) }] });
  expect(() => preview(expected.previewId)).toThrow(/缺少已登记的正文/);
  const db = openStore(join(boardDir, 'workspace.sqlite'));
  db.exec('PRAGMA user_version=999');
  db.close();
  expect(() => preview(expected.previewId)).toThrow();
  expect(files.get(target)).toBe('旧内容');
}, 60_000);

it('备份、未识别的文件、硬链接与未完成的进程登记均不会被清理', () => {
  const target = old('独立对象');
  const expected = preview();
  for (const name of Object.values(backupManifestNames)) {
    writeFileSync(join(root, name), 'test');
    expect(() => preview(expected.previewId)).toThrow(/数据目录/);
    rmSync(join(root, name));
  }
  writeFileSync(join(boardDir, 'objects', '.unfinished'), '部分写入');
  expect(preview()).toMatchObject({ unknownEntries: 1, eligible: 0 });
  expect(() => preview(expected.previewId)).toThrow();
  rmSync(join(boardDir, 'objects', '.unfinished'));
  for (const unexpected of [join(boardDir, 'prototype-store'), join(root, 'future-registry')]) {
    mkdirSync(unexpected);
    expect(preview()).toMatchObject({ eligible: 0, unknownEntries: 1 });
    expect(() => preview(expected.previewId)).toThrow();
    rmSync(unexpected, { recursive: true });
  }
  const outside = join(root, 'external');
  linkSync(join(boardDir, 'objects', target), outside);
  expect(() => preview(expected.previewId)).toThrow(/普通文件/);
  rmSync(outside);
  mkdirSync(join(root, 'processes'));
  writeFileSync(join(root, 'processes', 'pending.json'), '{}');
  expect(() => preview()).toThrow(/进程/);
  expect(files.get(target)).toBe('独立对象');
}, 60_000);

it('离线命令默认预览，清理必须提供同一工作区有效编号', () => {
  const target = old('终端验证');
  const argv = ['--import', 'tsx', 'apps/server/src/retention.ts'];
  const options = ['--data-dir', root, '--workspace', 'default', '--keep-days', '45'];
  const invoke = (mode: string, extra: string[] = []) => execFileSync(process.execPath, [...argv, mode, ...options, ...extra], { stdio: 'pipe', encoding: 'utf8' });
  const plan = JSON.parse(invoke('preview'));
  expect(plan).toMatchObject({ keepDays: 45, eligible: 1, removed: 0 });
  expect(() => invoke('clean')).toThrow();
  expect(files.get(target)).toBeTruthy();
  expect(JSON.parse(invoke('clean', ['--confirm', plan.previewId])).removed).toBe(1);
}, 60_000);

it('读取已提交但尚在 WAL 的规划引用，不接受过期清理预览', () => {
  const ref = old('WAL 里的规划结果');
  const before = preview();
  const catalog = openStore(join(root, 'catalog.sqlite'));
  try {
    catalog.exec('PRAGMA wal_autocheckpoint=0');
    catalog.prepare("INSERT INTO plan_requests(id,workspace,member,connection,started,status,result_ref) VALUES('wal','default','m','c',1,'proposed',?)")
      .run(ref);
    expect(existsSync(join(root, 'catalog.sqlite-wal'))).toBe(true);
    expect(() => preview(before.previewId)).toThrow(/重新预览/);
    expect(preview().entries.find(e => e.hash === ref)?.reason).toBe('规划结果');
  } finally { catalog.close(); }
  expect(files.get(ref)).toBeTruthy();
}, 60_000);

it('按原有迁移识别第八版工作区，旧版本数据与目录库分开验证', () => {
  const catalog = openStore(join(root, 'catalog.sqlite'));
  catalog.exec("INSERT INTO workspaces VALUES('legacy','历史',0)");
  catalog.close();
  const directory = safeDataDirectory(root, 'boards', 'legacy');
  const content = new ContentStore(directory);
  const id = content.put('历史计划');
  const file = join(directory, 'workspace.sqlite');
  const db = new DatabaseSync(file);
  try {
    const migrations = new URL('../../../packages/store/migrations/', import.meta.url);
    const names = readdirSync(migrations).filter(n => n.endsWith('.sql')).sort().slice(0, 8);
    for (const [index, name] of names.entries()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(index + 1, name);
      db.exec('PRAGMA user_version=' + String(index + 1));
    }
    db.prepare('INSERT INTO workflow_state VALUES(1,?)').run(JSON.stringify(state(id)));
  } finally { db.close(); }
  expect(workspaceRetention({ dataDir: root, workspace: 'legacy' })).toMatchObject({ eligible: 0, inventory: { plans: 1 } });
  const verified = new DatabaseSync(file, { readOnly: true });
  try { expect(verified.prepare('PRAGMA user_version').get()!.user_version).toBe(8); }
  finally { verified.close(); }
}, 60_000);

it('服务模拟交付停机后能回收孤儿，重启后保有完整交付快照', async () => {
  const data = privateTemporaryDirectory(root, 'app-');
  const web = safeDataDirectory(root, 'web');
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<title>Concordia</title>');
  const first = await startLocalServer(web, data);
  let delivered: unknown;
  try {
    const client = await browserSession(new URL(first.launchUrl));
    const demo = await client.post('/api/demo/run', {});
    expect(demo.status).toBe(200);
    delivered = (await demo.json()).acceptedSnapshot;
    expect(delivered).toBeTruthy();
    expect(() => workspaceRetention({ dataDir: data, workspace: 'default' })).toThrow();
  } finally { await first.close(); }
  const board = join(data, 'boards', 'default');
  const expired = new ContentStore(board).put('这段过期草稿没有发布');
  const then = new Date(Date.now() - 180 * 86_400_000);
  utimesSync(join(board, 'objects', expired), then, then);
  const options = { dataDir: data, workspace: 'default' };
  const approved = workspaceRetention(options);
  expect(approved.unknownEntries).toBe(0);
  expect(approved.entries.filter(e => e.reason === '未引用且已到期').map(e => e.hash)).toEqual([expired]);
  expect(workspaceRetention({ ...options, confirm: approved.previewId }).removed).toBe(1);
  const reopened = await startLocalServer(web, data);
  try {
    const client = await browserSession(new URL(reopened.launchUrl));
    const current = await client.get('/api/board');
    expect(current.status).toBe(200);
    expect((await current.json()).acceptedSnapshot).toEqual(delivered);
  } finally { await reopened.close(); }
}, 60_000);
