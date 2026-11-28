import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '@concordia/store';
import { existingDataDirectory, safeDatabasePath, safeDataDirectory } from '@concordia/store/paths';

/** Contains only fixed recovery instructions suitable for the startup terminal. */
export class WorkspaceRecoveryError extends Error {}

export function openWorkspaceStore(root: string, id: string, create: boolean) {
  if (create) {
    const dir = safeDataDirectory(root, 'boards', id);
    if (readdirSync(dir).length) throw new WorkspaceRecoveryError('新工作区目录已有数据，请核对工作区登记。');
    return { dir, boardDb: openStore(safeDatabasePath(dir, 'workspace.sqlite')) };
  }
  try {
    const dir = existingDataDirectory(root, 'boards', id);
    const boardDb = openStore(safeDatabasePath(dir, 'workspace.sqlite'), { mustExist: true });
    return { dir, boardDb };
  } catch (cause) {
    throw new WorkspaceRecoveryError('已登记工作区的数据库缺失或无法打开，请核对原目录或从备份恢复。', { cause });
  }
}

export function initialWorkspace<T extends { close(): void }>(
  catalog: DatabaseSync, root: string, open: (id: string, create: boolean) => T,
): T {
  const active = catalog.prepare('SELECT id FROM workspaces WHERE active=1').get();
  if (active) return open(String(active.id), false);
  if (catalog.prepare('SELECT 1 FROM workspaces LIMIT 1').get() ||
      catalog.prepare('SELECT 1 FROM workflow_state LIMIT 1').get())
    throw new WorkspaceRecoveryError('工作区目录已有数据但缺少活动登记，请核对原目录或从备份恢复。');

  // A legacy catalog without workspaces can initialize its first board. If the
  // first launch stopped after creating a valid default DB, adopt that same DB.
  let create = true;
  if (lstatSync(join(root, 'boards'), { throwIfNoEntry: false })) {
    const entries = readdirSync(existingDataDirectory(root, 'boards'));
    if (entries.some(name => name !== 'default'))
      throw new WorkspaceRecoveryError('已有工作区目录缺少登记，请核对原目录或从备份恢复。');
    create = entries.length === 0;
  }
  const board = open('default', create);
  try {
    catalog.prepare("INSERT INTO workspaces VALUES('default','默认工作区',1)").run();
    return board;
  } catch (error) {
    board.close();
    throw error;
  }
}
