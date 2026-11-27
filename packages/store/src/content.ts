import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { safeDataDirectory } from './paths.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const identityMatches = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const metadata = (path: string) => lstatSync(path, { bigint: true });

export class ContentStore {
  private directory: string;
  private identity: BigIntStats;
  constructor(dataDirectory: string) {
    this.directory = safeDataDirectory(resolve(dataDirectory), 'objects');
    this.identity = metadata(this.directory);
    this.checkDirectory();
  }
  private checkDirectory() {
    const now = metadata(this.directory);
    if (
      !now.isDirectory() ||
      !identityMatches(now, this.identity) ||
      realpathSync.native(this.directory) !== this.directory
    )
      throw new Error('内容目录已更换或不是普通目录');
  }
  get(ref: string): string {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('内容引用无效');
    this.checkDirectory();
    const path = join(this.directory, ref),
      before = metadata(path);
    if (!before.isFile() || before.nlink !== 1n) throw new Error('内容对象必须是独立普通文件');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      this.checkDirectory();
      if (!opened.isFile() || opened.nlink !== 1n || !identityMatches(before, opened))
        throw new Error('内容对象已被替换');
      const body = readFileSync(fd, 'utf8');
      if (hash(body) !== ref) throw new Error('内容摘要不匹配');
      return body;
    } finally {
      closeSync(fd);
    }
  }
  put(text: string): string {
    this.checkDirectory();
    const ref = hash(text);
    try {
      this.get(ref);
      return ref;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = join(this.directory, '.' + randomUUID());
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try {
        this.checkDirectory();
        writeFileSync(fd, text);
        fsyncSync(fd);
        const opened = fstatSync(fd, { bigint: true });
        const named = metadata(temporary);
        if (!named.isFile() || opened.nlink !== 1n || !identityMatches(opened, named))
          throw new Error('暂存内容已被替换');
      } finally {
        closeSync(fd);
      }
      this.checkDirectory();
      // SQLite serializes writers. Rename makes the complete object visible in a single step.
      renameSync(temporary, join(this.directory, ref));
    } catch (error) {
      this.checkDirectory();
      try {
        unlinkSync(temporary);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup;
      }
      throw error;
    }
    return ref;
  }
}
