import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, link, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDataDirectory, safeDatabasePath, safeDataDirectory, defaultDataDirectory } from '../src/data-directory.ts';

import { privateDataDirectory } from '@concordia/store/paths';

let root: string, data: string, outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'concordia-private-root-'));
  data = join(root, 'data'); outside = join(root, 'outside');
  privateDataDirectory(data); await mkdir(outside);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('应用管理的数据库与数据目录', () => {
  it('创建独立父目录，保留不存在的数据库供 SQLite 初始化', async () => {
    const path = safeDatabasePath(data, 'boards', 'qa', 'workspace.sqlite');
    expect((await lstat(safeDataDirectory(data, 'boards', 'qa'))).isDirectory()).toBe(true);
    await expect(lstat(path)).rejects.toThrow();
    expect(() => safeDatabasePath(data, '..', 'bad.sqlite')).toThrow();
    expect(() => safeDatabasePath(data, 'nested/file.sqlite')).toThrow();
    expect(() => safeDataDirectory(data, '.codex')).toThrow();
    expect(() => safeDataDirectory(data, '.claude')).toThrow();
  });
  it('拒绝祖先链接、最终目录链接及 Windows 目录联接', async () => {
    const alias = join(data, 'linked');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => safeDataDirectory(alias, 'missing')).toThrow();
    expect(() => safeDatabasePath(data, 'linked', 'missing.sqlite')).toThrow();
    await expect(lstat(join(outside,'missing'))).rejects.toThrow();
    await expect(lstat(join(outside,'missing.sqlite'))).rejects.toThrow();
  });
  it('数据库、每种 SQLite 旁文件、服务锁均拒绝硬链接', async () => {
    const sentinel = join(outside,'ordinary-file');
    await writeFile(sentinel,'保留原内容');
    for (const name of ['catalog.sqlite','catalog.sqlite-wal','catalog.sqlite-shm','catalog.sqlite-journal',
      'server-lock.sqlite','server-lock.sqlite-journal']) {
      const alias = join(data, name);
      await link(sentinel, alias);
      expect(() => name.startsWith('server-lock') ? acquireDataDirectory(data) : safeDatabasePath(data,'catalog.sqlite')).toThrow();
      expect(await readFile(sentinel,'utf8')).toBe('保留原内容');
      await rm(alias);
    }
  });
  it.skipIf(process.platform === 'win32')('拒绝文件符号链接，包含悬空的 WAL 和 journal', async () => {
    for (const name of ['catalog.sqlite','catalog.sqlite-wal','catalog.sqlite-journal']) {
      const alias = join(data,name);
      await symlink(join(outside,'missing'),alias);
      expect(()=>safeDatabasePath(data,'catalog.sqlite')).toThrow();
      await rm(alias);
    }
    await expect(lstat(join(outside,'missing'))).rejects.toThrow();
  });
  it('服务锁随服务关闭释放', () => {
    const first=acquireDataDirectory(data);
    try { expect(()=>acquireDataDirectory(data)).toThrow('占用'); } finally { first.release(); }
    acquireDataDirectory(data).release();
  });
});

it('自定义路径必须为绝对路径', () => {
  vi.stubEnv('CONCORDIA_DATA_DIR', './relative-data');
  try { expect(() => defaultDataDirectory()).toThrow('绝对路径'); }
  finally { vi.unstubAllEnvs(); }
  expect(() => acquireDataDirectory('./relative-data')).toThrow();
});

it.skipIf(process.platform === 'win32')('既有共享数据根不被接管或修改', async () => {
  await chmod(data, 0o750);
  const before = (await lstat(data)).mode;
  expect(() => acquireDataDirectory(data)).toThrow('仅允许该用户');
  expect((await lstat(data)).mode).toBe(before);
  await expect(lstat(join(data, 'server-lock.sqlite'))).rejects.toThrow();
});

it.skipIf(process.platform !== 'darwin')('macOS 的扩展 ACL 可使 mode 0700 的目录也被拒绝', async () => {
  const changed = spawnSync('/bin/chmod', ['+a', 'everyone allow list,search', data], { shell: false });
  expect(changed.status).toBe(0);
  expect(() => acquireDataDirectory(data)).toThrow();
  await expect(lstat(join(data, 'server-lock.sqlite'))).rejects.toThrow();
});

it.skipIf(process.platform !== 'win32')('Windows 私有目录通过，添加 Everyone 读权限后拒绝且保留原 ACL', async () => {
  const shared = join(root, 'shared');
  privateDataDirectory(shared);
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const run = (args: string[]) => spawnSync(exe, args, { shell: false, encoding: 'utf8' });
  expect(run([shared, '/grant', '*S-1-1-0:(OI)(CI)(RX)']).status).toBe(0);
  const before = run([shared]);
  expect(before.status).toBe(0);
  expect(() => acquireDataDirectory(shared)).toThrow('Windows');
  expect(run([shared]).stdout).toBe(before.stdout);
  await expect(lstat(join(shared, 'server-lock.sqlite'))).rejects.toThrow();
});
