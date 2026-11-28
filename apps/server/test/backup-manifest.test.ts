import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openStore } from '@concordia/store';
import { readBackupManifest, verifyBackupManifest, writeBackupManifest } from '../src/backup-manifest.ts';
import { copyApplicationState } from '../src/backup.ts';

it('在没有 POSIX mode 的目标上也校验来源清单的执行位，区分未知权限和空列表', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'concordia-manifest-'));
  try {
    const contentHash = 'a'.repeat(64);
    await writeBackupManifest(directory, { contentHash, executableFiles: ['worktrees/task/check'] });
    const record = await readBackupManifest(directory);
    if (record.version !== 2) throw new Error('预期新版清单。');
    const windowsCopy = { contentHash, executableFiles: null };
    expect(() => verifyBackupManifest(record, windowsCopy)).not.toThrow();
    for (const executableFiles of [[], null]) {
      expect(() => verifyBackupManifest({ ...record, executableFiles }, windowsCopy)).toThrow('摘要');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('从模拟 Windows 来源恢复到 Unix 时清除介质附加的执行位', async () => {
  const root = await mkdtemp(join(tmpdir(), 'concordia-windows-manifest-'));
  try {
    const snapshot = join(root, 'snapshot'), restored = join(root, 'restored');
    await mkdir(snapshot);
    const database = join(snapshot, 'catalog.sqlite');
    openStore(database).close();
    await chmod(database, 0o700);
    const hash = createHash('sha256').update(await readFile(database)).digest('hex');
    const contentHash = createHash('sha256').update(JSON.stringify(['catalog.sqlite', 'file', hash]) + '\n').digest('hex');
    await writeBackupManifest(snapshot, { contentHash, executableFiles: null });
    await copyApplicationState('restore', snapshot, restored);
    expect((await lstat(join(restored, 'catalog.sqlite'))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
