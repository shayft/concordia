import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

function checkPath(path: string): void {
  const parts = path.split(/[\\/]+/u);
  if (!isAbsolute(path) || path.includes('\0') || /^[\\/]{2}[?.][\\/]/u.test(path) ||
      parts.some(part => ['.claude','.codex'].includes(part.replace(/[. ]+$/u, '').toLowerCase()))) {
    throw new Error('请选择独立于 CLI 配置的本机应用目录。');
  }
}

function checkSegment(value: string): void {
  if (!value || value === '.' || value === '..' || /[\\/:\0]/u.test(value) ||
      (process.platform === 'win32' && (/[. ]$/u.test(value) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)))) {
    throw new Error('应用数据路径组成部分无效。');
  }
}

function ensureDirectory(path: string, create: boolean): void {
  let info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) {
    if (!create) throw new Error('指定的应用目录不存在。');
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    info = lstatSync(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('应用数据路径含目录链接或非目录项。');
}

/** Return the physical application path. Validate parents before accessing children. */
function directory(root: string, segments: string[], create: boolean): string {
  checkPath(root);
  for (const segment of segments) checkSegment(segment);
  const full = resolve(root, ...segments);
  checkPath(full);
  let path = parse(full).root;
  for (const segment of full.slice(path.length).split(sep).filter(Boolean)) {
    checkSegment(segment);
    path = join(path, segment);
    // macOS ships /var and /tmp as OS aliases; verify the canonical destination.
    if (process.platform === 'darwin' && (path === '/tmp' || path === '/var') &&
        realpathSync(path) === '/private' + path) path = '/private' + path;
    ensureDirectory(path, create);
    // Expand existing Windows short names before traversing the next component.
    if (process.platform === 'win32') {
      path = realpathSync.native(path);
      checkPath(path);
    }
  }
  return path;
}

export function safeDataDirectory(root: string, ...segments: string[]): string {
  return directory(root, segments, true);
}

export function existingDataDirectory(root: string): string {
  return directory(root, [], false);
}

/** Reject symlinks, junctions, devices, directories, and files sharing another inode name. */
export function assertSingleFile(path: string): void {
  checkPath(path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
    throw new Error('应用数据必须使用独立的普通文件。');
  }
}

export function safeDatabasePath(root: string, ...segments: string[]): string {
  const name = segments.pop();
  if (!name) throw new Error('缺少数据库文件名。');
  checkSegment(name);
  const directory = safeDataDirectory(root, ...segments);
  const path = join(directory, name);
  for (const suffix of ['', '-wal', '-shm', '-journal']) assertSingleFile(path + suffix);
  return path;
}
