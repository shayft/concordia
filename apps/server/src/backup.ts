import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readdir, readlink, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { assertSingleFile, existingDataDirectory, privateTemporaryDirectory, safeDatabasePath } from '@concordia/store/paths';
import { acquireDataDirectory } from './data-directory.ts';
import { catalogRecovery, LedgerRecoveryError, rehearsalRecovery, worktreeRecovery } from './ledger-presence.ts';
import { verifyBackupReferences } from './backup-integrity.ts';
import { BackupManifestError, readBackupManifest, verifyBackupManifest, writeBackupManifest } from './backup-manifest.ts';

const applicationRoots = new Set(['catalog.sqlite', 'worktrees.sqlite', 'objects', 'boards', 'worktrees', 'assignee-delivery']);
const dbFile = /^(?:catalog\.sqlite|worktrees\.sqlite|boards\/[^/]+\/workspace\.sqlite|assignee-delivery\/(?:delivery|worktrees)\.sqlite)$/u;
const sidecar = /-(?:shm|wal|journal)$/u;
const privatePath = /(?:^|[\\/])\.(?:claude|codex)(?:[\\/]|$)/iu;
const isManagedSidecar = (path: string) => sidecar.test(path) && dbFile.test(path.replace(sidecar, ''));

class PendingProcessRecovery extends Error {}

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

async function copyState(source: string, target: string, snapshot: boolean, preserveExecutable: boolean) {
  const digest = createHash('sha256');
  const executableFiles: string[] | null = process.platform === 'win32' ? null : [];
  async function skipSidecar(path: string) {
    if (!isManagedSidecar(path)) return false;
    const main = path.replace(sidecar, '');
    if (main.endsWith('worktrees.sqlite') || main.endsWith('/delivery.sqlite')) {
      const file = await lstat(join(source, main)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!file) throw new LedgerRecoveryError(main.endsWith('/delivery.sqlite') ? rehearsalRecovery : worktreeRecovery);
    }
    return true;
  }
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
        if (!(await skipSidecar(child))) await visit(child);
      }
    } else if (stat.isFile()) {
      if (dbFile.test(path) && snapshot) {
        const db = checkDatabase(safeDatabasePath(source, ...path.split('/')));
        try { await backup(db, to); } finally { db.close(); }
      } else {
        // The backup never reads files shared with an uncontrolled inode name.
        assertSingleFile(from);
        await copyFile(from, to);
      }
      if (executableFiles) {
        const execute = preserveExecutable ? stat.mode & 0o100 : 0;
        if (execute) executableFiles.push(path);
        await chmod(to, 0o600 | execute);
      }
      const hash = await digestFile(to);
      if (/^(?:boards\/[^/]+\/|assignee-delivery\/)?objects\/[a-f0-9]{64}$/u.test(path) && hash !== basename(path)) {
        throw new Error('交付物内容与 SHA-256 名称不匹配。');
      }
      digest.update(JSON.stringify([path, 'file', hash]) + '\n');
    } else {
      throw new Error('数据目录中有无法备份的特殊文件。');
    }
  }
  const catalog = await lstat(join(source, 'catalog.sqlite')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!catalog?.isFile()) throw new LedgerRecoveryError(catalogRecovery);
  for (const name of (await readdir(source)).sort()) {
    if (!(await skipSidecar(name)) && applicationRoots.has(name)) await visit(name);
  }
  return { contentHash: digest.digest('hex'), executableFiles: executableFiles?.sort() ?? null };
}

/** An offline, local snapshot. A destination must be new, even after a failed attempt. */
export async function copyApplicationState(mode: 'create' | 'restore', source: string, target: string): Promise<void> {
  checkLocation(source);
  checkLocation(target);
  const from = existingDataDirectory(source);
  const to = join(existingDataDirectory(dirname(target)), basename(target));
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
    const expected = mode === 'restore' ? await readBackupManifest(from) : undefined;
    if (mode === 'create') {
      const lockPath = join(from, 'server-lock.sqlite');
      if (!(await lstat(lockPath)).isFile()) throw new Error('请选择应用已使用的数据目录。');
      lease = acquireDataDirectory(from);
      const records = join(from, 'processes');
      if (await lstat(records).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      })) {
        const names = await readdir(existingDataDirectory(records));
        if (names.some(name => name.endsWith('.json')))
          throw new PendingProcessRecovery('应用仍有待核对的进程登记。请先在原数据目录启动、完成核对并正常停服。');
      }
    }
    staging = privateTemporaryDirectory(dirname(to), '.concordia-copy-');
    const preserveExecutable = expected?.version !== 2 || expected.executableFiles !== null;
    const contents = await copyState(from, staging, mode === 'create', preserveExecutable);
    if (expected) verifyBackupManifest(expected, contents);
    else await writeBackupManifest(staging, contents);
    verifyBackupReferences(staging);
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
    catch (error) {
      const diagnostic = error instanceof PendingProcessRecovery || error instanceof LedgerRecoveryError || error instanceof BackupManifestError ? error.message
        : '请检查服务是否已停止、路径及权限、数据库和内容完整性；保留原目录，勿启用不完整的目标。';
      process.stderr.write('操作未完成。' + diagnostic + '\n');
      process.exitCode = 1;
    }
  }
}
