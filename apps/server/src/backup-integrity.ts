import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { State } from '@concordia/core/state';

// The staging copy contains self-contained SQLite backup files, with no pending WAL.
// Immutable read access leaves no -wal/-shm files in the directory being published.
function inspect(file: string, check: (db: DatabaseSync) => void) {
  const uri = pathToFileURL(file);
  uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('数据库完整性校验失败。');
    check(db);
  } finally { db.close(); }
}
function table(db: DatabaseSync, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
}

function verifyWorkflow(directory: string, db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) < 3) return;
  const objects = join(directory, 'objects');
  const checked = new Set<string>();
  const archives = new Set<string>();
  function object(ref: string) {
    if (typeof ref !== 'string' || !/^[0-9a-f]{64}$/u.test(ref)) throw new Error('内容引用无效。');
    if (!checked.has(ref)) {
      if (!lstatSync(join(objects, ref), { throwIfNoEntry: false })?.isFile())
        throw new Error('备份缺少已登记的内容对象。');
      checked.add(ref);
    }
    return join(objects, ref);
  }
  function verifyState(raw: string) {
    const state = JSON.parse(raw) as State;
    for (const ref of state.plans) object(ref);
    for (const row of state.tasks) if (row.progressRef !== undefined) object(row.progressRef);
    for (const row of state.executions) {
      object(row.contextRef);
      if (row.resultRef !== undefined) object(row.resultRef);
    }
    for (const row of state.versions) object(row.contentRef);
    for (const row of Object.values(state.receipts ?? {})) {
      object(row.fingerprint);
      if (row.resultRef !== undefined) object(row.resultRef);
    }
    for (const ref of Object.values(state.conflicts ?? {})) object(ref);
    for (const row of state.archives ?? []) {
      const path = object(row.ref);
      if (archives.has(row.ref)) continue;
      archives.add(row.ref);
      verifyState(readFileSync(path, 'utf8'));
    }
  }
  const state = db.prepare('SELECT data FROM workflow_state WHERE singleton=1').get();
  if (state) verifyState(String(state.data));
  for (const row of db.prepare('SELECT data FROM workflow_events').iterate()) {
    const event = JSON.parse(String(row.data)) as { contentRef?: string };
    if (event.contentRef !== undefined) object(event.contentRef);
  }
}

export function verifyBackupReferences(root: string) {
  const boards = join(root, 'boards');
  const available = new Set(lstatSync(boards, { throwIfNoEntry: false })
    ? readdirSync(boards, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []);
  inspect(join(root, 'catalog.sqlite'), db => {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 4) {
      for (const row of db.prepare('SELECT id FROM workspaces').iterate()) {
        if (!available.has(String(row.id))) throw new Error('备份缺少已登记的工作区。');
      }
    }
    verifyWorkflow(root, db);
  });
  for (const id of available) {
    const dir = join(boards, id);
    const file = join(dir, 'workspace.sqlite');
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('备份缺少工作区数据库。');
    inspect(file, db => verifyWorkflow(dir, db));
  }
  for (const file of [join(root, 'worktrees.sqlite'), join(root, 'assignee-delivery', 'delivery.sqlite'),
    join(root, 'assignee-delivery', 'worktrees.sqlite')]) {
    if (lstatSync(file, { throwIfNoEntry: false }))
      inspect(file, db => { if (table(db, 'workflow_state')) verifyWorkflow(dirname(file), db); });
  }
}
