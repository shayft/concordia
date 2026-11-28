import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { identifyStore } from '@concordia/store';
import { verifyBeforeOpening } from '@concordia/store/database-identity';
import { ContentStore } from '@concordia/store/content';
import { existingDataDirectory, safeDatabasePath } from '@concordia/store/paths';
import type { State } from '@concordia/core/state';
import { acquireDataDirectory } from './data-directory.ts';
import { backupManifestNames } from './backup-manifest.ts';

class RetentionError extends Error {}
function fail(message: string): never { throw new RetentionError(message); }
const isDigest = /^[a-f0-9]{64}$/;
const day = 86_400_000;
const lastReviewedMigration = 10;
const stat = (file: string) => lstatSync(file, { bigint: true });
const fileIdentity = (file: string) => {
  const s = stat(file);
  if (!s.isFile() || s.nlink !== 1n) fail('内容对象不是独立普通文件，已停止清理。');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('/');
};
const exists = (file: string) => !!lstatSync(file, { throwIfNoEntry: false });
const catalogName = 'catalog.sqlite';
const boardName = 'workspace.sqlite';
const sqliteEntries = (name: string) => ['', '-wal', '-shm', '-journal'].map(suffix => name + suffix);
const boardLayout = new Set(['objects', ...sqliteEntries(boardName)]);
const applicationLayout = new Set([
  'boards', 'objects', 'worktrees', 'assignee-delivery', 'cli-work', 'processes',
  ...sqliteEntries(catalogName), ...sqliteEntries('server-lock.sqlite'), ...sqliteEntries('worktrees.sqlite'),
]);

function verifySchema(db: DatabaseSync) {
  db.exec('PRAGMA trusted_schema=OFF');
  const version = identifyStore(db);
  if (version < 4 || version > lastReviewedMigration) fail('此数据库迁移版本尚未验证可清理。');
  // Match actual tables against the recorded release, without migrating user data.
  const baseline = new DatabaseSync(':memory:');
  try {
    for (const row of db.prepare('SELECT name FROM schema_migrations ORDER BY version').iterate()) {
      const migration = new URL('../../../packages/store/migrations/' + row.name, import.meta.url);
      baseline.exec(readFileSync(migration, 'utf8'));
    }
    const schema = "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name";
    if (JSON.stringify(baseline.prepare(schema).all()) !== JSON.stringify(db.prepare(schema).all()))
      fail('实际数据库结构与发行版迁移不一致，已保留内容。');
  } finally { baseline.close(); }
}

function openSnapshot(directory: string, name: string) {
  const file = safeDatabasePath(directory, name);
  if (!exists(file)) fail('缺少已登记的数据库，无法确认保留范围。');
  // Verify unknown files in a scratch/immutable snapshot before a writable open can recover a journal.
  verifyBeforeOpening(file, verifySchema);
  const uri = pathToFileURL(file);
  uri.searchParams.set('mode', 'rw');
  const db = new DatabaseSync(uri.href);
  try {
    // IMMEDIATE excludes standalone SQLite writers and sees their previously committed WAL frames.
    db.exec('BEGIN IMMEDIATE; PRAGMA query_only=ON');
    verifySchema(db);
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
      fail('数据库完整性检查失败。');
    return db;
  } catch (error) { db.close(); throw error; }
}

type Reason = '工作区记录' | '规划结果' | '目录库记录' | '其他内容中的引用' | '保留期内' | '无法确认根记录' | '未引用且已到期';
interface Entry { hash: string; bytes: number; modified: string; reason: Reason }
interface Options { dataDir: string; workspace: string; keepDays?: number; confirm?: string }

function report(root: string, catalog: DatabaseSync, board: DatabaseSync, workspace: string, keepDays: number, confirm?: string) {
  const boardRoot = existingDataDirectory(root, 'boards', workspace);
  const directory = existingDataDirectory(boardRoot, 'objects');
  const store = new ContentStore(boardRoot);
  const names = readdirSync(directory).sort();
  // Unexpected state containers may introduce a new source of references, even when migrations match.
  const uncertain = names.filter(name => !isDigest.test(name)).length
    + readdirSync(boardRoot).filter(name => !boardLayout.has(name)).length
    + readdirSync(root).filter(name => !applicationLayout.has(name)).length;
  const retained = new Map<string, Reason>();
  const files = new Map(names.filter(name => isDigest.test(name)).map(name => [name, fileIdentity(join(directory, name))]));
  // All native application object references are SHA-256 text. Scanning values
  // and keys also retains hashes in old untyped receipts, new proposals and drafts.
  function mark(value: string, reason: Reason) {
    for (const match of value.matchAll(/[a-f0-9]{64,}/ig)) {
      const run = match[0].toLowerCase();
      for (let i = 0; i + 64 <= run.length; i++) {
        const hash = run.slice(i, i + 64);
        if (files.has(hash) && !retained.has(hash)) retained.set(hash, reason);
      }
    }
  }
  function markDocument(value: string, reason: Reason) {
    mark(value, reason);
    if (/\\u[\da-f]{4}/i.test(value)) {
      try { mark(JSON.stringify(JSON.parse(value)), reason); } catch { /* Ordinary artifact text. */ }
    }
  }
  function required(ref: unknown, reason: Reason) {
    if (typeof ref !== 'string' || !files.has(ref)) fail('缺少已登记的正文，无法证明哪些内容可回收。');
    retained.set(ref, reason);
  }
  const inventory = {
    plans: 0, tasks: 0, executions: 0, artifactVersions: 0, questions: 0, messages: 0,
    proposals: 0, archivedPlans: 0, historyEvents: 0, planningRequests: 0, planningResults: 0, hasDraft: false
  };
  const archiveQueue: string[] = [];
  const archives = new Set<string>();
  function verifyState(raw: string) {
    const state = JSON.parse(raw) as State;
    inventory.plans += state.plans.length;
    inventory.tasks += state.tasks.length;
    inventory.executions += state.executions.length;
    inventory.artifactVersions += state.versions.length;
    inventory.questions += state.questions.length;
    inventory.messages += state.messages.length;
    inventory.proposals += state.proposals?.length ?? 0;
    for (const ref of state.plans) required(ref, '工作区记录');
    for (const task of state.tasks) if (task.progressRef !== undefined) required(task.progressRef, '工作区记录');
    for (const run of state.executions) {
      required(run.contextRef, '工作区记录');
      if (run.resultRef !== undefined) required(run.resultRef, '工作区记录');
    }
    for (const version of state.versions) required(version.contentRef, '工作区记录');
    for (const receipt of Object.values(state.receipts ?? {})) {
      required(receipt.fingerprint, '工作区记录');
      if (receipt.resultRef !== undefined) required(receipt.resultRef, '工作区记录');
    }
    for (const ref of Object.values(state.conflicts ?? {})) required(ref, '工作区记录');
    for (const item of state.archives ?? []) {
      required(item.ref, '工作区记录');
      if (!archives.has(item.ref)) { archives.add(item.ref); archiveQueue.push(item.ref); }
    }
  }

  const head = board.prepare('SELECT data FROM workflow_state WHERE singleton=1').get();
  if (head) verifyState(String(head.data));
  for (let i = 0; i < archiveQueue.length; i++) verifyState(store.get(archiveQueue[i]));
  inventory.archivedPlans = archives.size;
  if (Number(board.prepare('PRAGMA user_version').get()!.user_version) >= 8)
    inventory.hasDraft = Boolean(board.prepare("SELECT 1 FROM plan_draft WHERE length(text)>0").get());
  for (const row of board.prepare('SELECT data FROM workflow_events').iterate()) {
    inventory.historyEvents++;
    const event = JSON.parse(String(row.data));
    if (event.contentRef !== undefined) required(event.contentRef, '工作区记录');
  }
  const catalogVersion = Number(catalog.prepare('PRAGMA user_version').get()!.user_version);
  inventory.planningRequests = Number(catalog.prepare('SELECT count(*) AS n FROM plan_requests WHERE workspace=?').get(workspace)!.n);
  if (catalogVersion >= 9) {
    for (const row of catalog.prepare('SELECT result_ref FROM plan_requests WHERE workspace=? AND result_ref IS NOT NULL').iterate(workspace)) {
      required(row.result_ref, '规划结果');
      inventory.planningResults++;
    }
  }

  function markDatabase(db: DatabaseSync, reason: Reason) {
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").iterate()) {
      // Schema was matched with trusted migrations above.
      for (const row of db.prepare('SELECT * FROM "' + String(name).replaceAll('"', '""') + '"').iterate()) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') markDocument(value, reason);
          if (value instanceof Uint8Array) fail('记录含无法核对的二进制内容，已停止清理。');
        }
      }
    }
  }
  markDatabase(board, '工作区记录');
  markDatabase(catalog, '目录库记录');
  // Scan every object, even an unreachable one. On this pass its children are
  // retained, so an unreferenced parent can disappear without losing dependencies.
  for (const hash of files.keys()) markDocument(store.get(hash), '其他内容中的引用');
  const cutoff = Date.now() - keepDays * day;
  const entries: Entry[] = [];
  for (const hash of files.keys()) {
    const s = stat(join(directory, hash));
    const reason = retained.get(hash) ?? (uncertain || !head ? '无法确认根记录' : Number(s.mtimeMs) > cutoff ? '保留期内' : '未引用且已到期');
    entries.push({ hash, bytes: Number(s.size), modified: new Date(Number(s.mtimeMs)).toISOString(), reason });
  }
  const candidates = entries.filter(entry => entry.reason === '未引用且已到期');
  const dir = stat(directory);
  const digest = createHash('sha256').update(JSON.stringify({
    root, workspace, keepDays, dev: String(dir.dev), ino: String(dir.ino), files: [...files], entries, uncertain,
  })).digest('hex');
  if (confirm !== undefined) {
    if (confirm !== digest) fail('清理预览与当前数据不一致，请重新预览。');
    for (const { hash } of candidates) {
      const current = stat(existingDataDirectory(root, 'boards', workspace, 'objects'));
      if (dir.ino !== current.ino || dir.dev !== current.dev || files.get(hash) !== fileIdentity(join(directory, hash)))
        fail('清理期间目录或对象已更换，请重新预览。');
      unlinkSync(join(directory, hash));
    }
  }
  return {
    workspace, keepDays, previewId: digest, inventory, entries, unknownEntries: uncertain, eligible: candidates.length,
    eligibleBytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0), removed: confirm === undefined ? 0 : candidates.length
  };
}

export function workspaceRetention({ dataDir, workspace, keepDays = 30, confirm }: Options) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace) || !Number.isSafeInteger(keepDays) || keepDays < 1 || keepDays > 36500)
    fail('工作区标识或保留天数无效。');
  if (confirm !== undefined && !isDigest.test(confirm)) fail('清理需要有效的预览编号。');
  const root = existingDataDirectory(dataDir);
  if (Object.values(backupManifestNames).some(name => exists(join(root, name))) || !exists(join(root, catalogName)) || !exists(join(root, 'server-lock.sqlite')))
    fail('请选择已启动过且已正常停服的应用数据目录。');
  const lease = acquireDataDirectory(root);
  try {
    if (exists(join(root, 'processes')) && readdirSync(existingDataDirectory(root, 'processes')).some(name => name.endsWith('.json')))
      fail('仍有待核对的进程登记，请先完成恢复并正常停服。');
    const catalog = openSnapshot(root, catalogName);
    try {
      if (!catalog.prepare('SELECT id FROM workspaces WHERE id=?').get(workspace)) fail('工作区未登记。');
      const selected = existingDataDirectory(root, 'boards', workspace);
      const directory = stat(selected);
      for (const other of catalog.prepare('SELECT id FROM workspaces WHERE id<>?').iterate(workspace)) {
        const sibling = stat(existingDataDirectory(root, 'boards', String(other.id)));
        if (directory.ino === sibling.ino && directory.dev === sibling.dev) fail('工作区目录身份重复，已保留内容。');
      }
      const board = openSnapshot(selected, boardName);
      try { return report(root, catalog, board, workspace, keepDays, confirm); }
      finally { board.close(); }
    } finally { catalog.close(); }
  } finally { lease.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true, options: {
        'data-dir': { type: 'string' }, workspace: { type: 'string' }, 'keep-days': { type: 'string' }, confirm: { type: 'string' },
      }
    });
    const [mode] = positionals;
    if (positionals.length !== 1 || !['preview', 'clean'].includes(mode) || !values['data-dir'] || !values.workspace ||
      (mode === 'clean') !== (values.confirm !== undefined) || (values['keep-days'] && !/^\d+$/.test(values['keep-days'])))
      fail('用法：retention.ts preview|clean --data-dir 绝对路径 --workspace 标识 [--keep-days 天数]，clean 还须传 --confirm 预览编号。');
    console.log(JSON.stringify(workspaceRetention({
      dataDir: values['data-dir']!, workspace: values.workspace!,
      keepDays: Number(values['keep-days'] ?? 30), confirm: values.confirm
    }), null, 2));
  } catch (error) {
    console.error(error instanceof RetentionError ? error.message : '无法独占或完整核对应用数据，请核对停服状态、目录权限和完整备份。');
    process.exitCode = 1;
  }
}
