import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { safeDatabasePath, safeDataDirectory } from '@concordia/store/paths';
export { safeDatabasePath, safeDataDirectory };

export function defaultDataDirectory(): string {
  if (process.env.CONCORDIA_DATA_DIR) return resolve(process.env.CONCORDIA_DATA_DIR);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Concordia');
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Concordia');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'concordia');
}

export function acquireDataDirectory(path: string) {
  const directory = safeDataDirectory(path);
  // The OS releases the exclusive transaction even if the server is killed.
  const lock = new DatabaseSync(safeDatabasePath(directory, 'server-lock.sqlite'));
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch {
    lock.close();
    throw new Error('已有服务占用该数据目录。');
  }
  return { directory, release: () => lock.close() };
}
