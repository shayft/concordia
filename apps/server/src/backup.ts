import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { acquireDataDirectory } from './data-directory.ts';

const manifest = 'concordia-backup-v1.sha256';
const applicationRoots = new Set(['catalog.sqlite', 'worktrees.sqlite', 'objects', 'boards', 'worktrees', 'assignee-delivery']);
const dbFile = /^(?:catalog\.sqlite|worktrees\.sqlite|boards\/[^/]+\/workspace\.sqlite|assignee-delivery\/(?:delivery|worktrees)\.sqlite)$/u;
const sidecar = /-(?:shm|wal|journal)$/u;
const privatePath = /(?:^|[\\/])\.(?:claude|codex)(?:[\\/]|$)/iu;
const isManagedSidecar = (path: string) => sidecar.test(path) && dbFile.test(path.replace(sidecar, ''));

function checkLocation(path: string): void {
  if (!isAbsolute(path) || privatePath.test(path)) throw new Error('请指定独立、绝对的 Concordia 路径。');
}

async function digestFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function checkDatabase(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('数据库完整性校验失败。');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function copyState(source: string, target: string, snapshot: boolean) {
  const digest = createHash('sha256');
  async function visit(path: string): Promise<void> {
    const from = join(source, path), to = join(target, path);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) {
      // Git projects may contain symlinks. Copy only link metadata, never follow one.
      if (!/^(?:worktrees\/[^/]+|assignee-delivery\/(?:worktrees\/[^/]+|example-[^/]+))\//u.test(path)) throw new Error('应用数据不能指向外部文件。');
      await cp(from, to, { force: false, errorOnExist: true, verbatimSymlinks: true });
      digest.update(JSON.stringify([path, 'link', await readlink(to)]) + '\n');
    } else if (stat.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      digest.update(JSON.stringify([path, 'directory']) + '\n');
      for (const name of (await readdir(from)).sort()) {
        const child = path + '/' + name;
        if (!isManagedSidecar(child)) await visit(child);
      }
    } else if (stat.isFile()) {
      if (dbFile.test(path) && snapshot) {
        // Reject redirected WAL files before SQLite opens any of them.
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const side = await lstat(from + suffix).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') throw e;
            return null;
          });
          if (side && !side.isFile()) throw new Error('数据库旁文件类型无效。');
        }
        const db = checkDatabase(from);
        try { await backup(db, to); } finally { db.close(); }
      } else {
        await copyFile(from, to);
      }
      // Preserve executable bits for a restored project command while keeping backups private.
      if (process.platform !== 'win32') await chmod(to, 0o600 | (stat.mode & 0o100));
      const hash = await digestFile(to);
      if (/^(?:boards\/[^/]+\/|assignee-delivery\/)?objects\/[a-f0-9]{64}$/u.test(path) && hash !== basename(path)) {
        throw new Error('交付物内容与 SHA-256 名称不匹配。');
      }
      digest.update(JSON.stringify([path, 'file', hash]) + '\n');
    } else {
      throw new Error('数据目录中有无法备份的特殊文件。');
    }
  }
  if (!(await lstat(join(source, 'catalog.sqlite'))).isFile()) throw new Error('缺少 Concordia 目录库。');
  for (const name of (await readdir(source)).sort()) {
    if (applicationRoots.has(name)) await visit(name);
  }
  return digest.digest('hex');
}

/** An offline, local snapshot. A destination must be new, even after a failed attempt. */
export async function copyApplicationState(mode: 'create' | 'restore', source: string, target: string): Promise<void> {
  checkLocation(source);
  checkLocation(target);
  const from = await realpath(source);
  const to = join(await realpath(dirname(target)), basename(target));
  checkLocation(from);
  checkLocation(to);
  const rel = relative(from, to);
  if (!rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new Error('目标目录不能位于源目录内。');

  const existing = await lstat(to).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) throw new Error('目标目录已存在。');
  let lease: ReturnType<typeof acquireDataDirectory> | undefined;
  let staging: string | undefined;
  try {
    let expected: string | undefined;
    if (mode === 'restore') {
      const file = join(from, manifest);
      if (!(await lstat(file)).isFile()) throw new Error('备份清单无效。');
      expected = (await readFile(file, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error('备份摘要无效。');
    } else {
      if (!(await lstat(join(from, 'catalog.sqlite'))).isFile()) throw new Error('缺少目录库。');
      const lockPath = join(from, 'server-lock.sqlite');
      if (!(await lstat(lockPath)).isFile()) throw new Error('请选择应用已使用的数据目录。');
      lease = acquireDataDirectory(from);
    }
    staging = await mkdtemp(join(dirname(to), '.concordia-copy-'));
    const digest = await copyState(from, staging, mode === 'create');
    if (mode === 'create') await writeFile(join(staging, manifest), digest + '\n', { mode: 0o600, flag: 'wx' });
    else if (digest !== expected) throw new Error('备份摘要不匹配。');
    // Publish only a complete, verified directory on the same volume.
    await rename(staging, to);
    staging = undefined;
  } finally {
    lease?.release();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, source, destination, ...extra] = process.argv.slice(2);
  if ((mode !== 'create' && mode !== 'restore') || !source || !destination || extra.length) {
    process.stderr.write('用法：backup.ts create|restore <绝对源目录> <尚不存在的绝对目标目录>\n');
    process.exitCode = 2;
  } else {
    try { await copyApplicationState(mode, source, destination); process.stdout.write('数据复制和校验已完成。\n'); }
    catch {
      process.stderr.write('操作未完成。请检查服务是否已停止、路径及权限、数据库和内容完整性；保留原目录，勿启用不完整的目标。\n');
      process.exitCode = 1;
    }
  }
}
