import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrivateDirectoryError } from '@concordia/store/private-directory';
import { privateDataDirectory, safeDatabasePath, safeDataDirectory } from '@concordia/store/paths';
export { safeDatabasePath, safeDataDirectory };

export function defaultDataDirectory(): string {
  if (process.env.CONCORDIA_DATA_DIR) {
    const path = process.env.CONCORDIA_DATA_DIR;
    if (!isAbsolute(path)) throw new PrivateDirectoryError('自定义数据目录必须使用绝对路径。');
    return path;
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Concordia');
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Concordia');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'concordia');
}

export function acquireDataDirectory(path: string) {
  const directory = privateDataDirectory(path);
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
