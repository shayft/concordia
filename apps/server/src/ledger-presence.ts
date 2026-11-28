import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { verifyBeforeOpening } from '@concordia/store/database-identity';
import { openStore } from '@concordia/store';
import { existingDataDirectory, safeDatabasePath } from '@concordia/store/paths';

export class LedgerRecoveryError extends Error {}
export const catalogRecovery = '已有应用数据的目录库缺失或无效，请核对原目录或从完整备份恢复。';
export const worktreeRecovery = '已有项目的工作树登记库缺失或无效，请核对原目录或从完整备份恢复。';

function present(path: string) {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
function nonemptyDirectory(root: string, name: string) {
  return present(join(root, name)) && readdirSync(existingDataDirectory(root, name)).length > 0;
}
function hasSidecars(file: string) {
  return ['-wal', '-shm', '-journal'].some(suffix => present(file + suffix));
}

export function openCatalog(root: string) {
  const file = safeDatabasePath(root, 'catalog.sqlite');
  // An interrupted first launch may have acquired the lock and created an empty
  // process registry. Every durable directory below is created AFTER the catalog.
  const expected = ['boards', 'worktrees.sqlite', 'worktrees', 'assignee-delivery', 'objects', 'cli-work']
    .some(name => present(join(root, name))) || hasSidecars(file) || nonemptyDirectory(root, 'processes');
  if (expected && !present(file)) throw new LedgerRecoveryError(catalogRecovery);
  // Detect a lost worktree ledger before migrating this catalog or marking any
  // in-flight request interrupted. Existing WAL is inspected in a scratch copy.
  preflightWorktreeLedger(root, file);
  if (!expected) return openStore(file);
  try { return openStore(file, { mustExist: true }); }
  catch (cause) { throw new LedgerRecoveryError(catalogRecovery, { cause }); }
}

// A legacy catalog predating project support is allowed to create its first
// ledger. Once this installation has used the feature, opening must not create it.
export function worktreeLedgerExpected(root: string, owner?: DatabaseSync) {
  if (nonemptyDirectory(root, 'worktrees') || hasSidecars(join(root, 'worktrees.sqlite'))) return true;
  if (!owner) return false;
  if (hasRows(owner, 'version_sources') || hasRows(owner, 'delivery_runs')) return true;
  // Past releases created the worktree ledger before opening any registered board.
  return hasRows(owner, 'workspaces') && nonemptyDirectory(root, 'boards');
}


function hasRows(db: DatabaseSync, table: 'workspaces' | 'version_sources' | 'delivery_runs') {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined
    && db.prepare('SELECT 1 FROM ' + table + ' LIMIT 1').get() !== undefined;
}

export function preflightWorktreeLedger(root: string, ownerFile: string) {
  if (present(safeDatabasePath(root, 'worktrees.sqlite'))) return;
  if (worktreeLedgerExpected(root)) throw new LedgerRecoveryError(worktreeRecovery);
  verifyBeforeOpening(ownerFile, db => {
    if (worktreeLedgerExpected(root, db)) throw new LedgerRecoveryError(worktreeRecovery);
  });
}
