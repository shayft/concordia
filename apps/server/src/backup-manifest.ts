import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSingleFile } from '@concordia/store/paths';
import { z } from 'zod';

export const backupManifestNames = {
  v1: 'concordia-backup-v1.sha256',
  v2: 'concordia-backup-v2.json',
} as const;

const checksum = z.string().regex(/^[0-9a-f]{64}$/u);
const v2Schema = z.strictObject({
  version: z.literal(2),
  sha256: checksum,
  // Windows cannot report POSIX owner execute bits, even for .exe files.
  executableFiles: z.array(z.string()).nullable(),
});
type Manifest = z.infer<typeof v2Schema> | { version: 1; sha256: string };
export interface SnapshotContents { contentHash: string; executableFiles: string[] | null }
export class BackupManifestError extends Error {}

function digest(contents: SnapshotContents): string {
  return createHash('sha256').update(JSON.stringify([
    'concordia-backup-v2', contents.contentHash, contents.executableFiles,
  ])).digest('hex');
}

export async function writeBackupManifest(directory: string, contents: SnapshotContents) {
  const record = { version: 2, sha256: digest(contents), executableFiles: contents.executableFiles };
  await writeFile(join(directory, backupManifestNames.v2), JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
}

export async function readBackupManifest(directory: string): Promise<Manifest> {
  const path = join(directory, backupManifestNames.v2);
  const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (exists) {
    assertSingleFile(path);
    return v2Schema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  const legacy = join(directory, backupManifestNames.v1);
  assertSingleFile(legacy);
  return { version: 1, sha256: checksum.parse((await readFile(legacy, 'utf8')).trim()) };
}

export function verifyBackupManifest(manifest: Manifest, copied: SnapshotContents) {
  if (manifest.version === 1) {
    if (manifest.sha256 !== copied.contentHash) throw new BackupManifestError('备份摘要不匹配。');
    return;
  }
  if (manifest.executableFiles && copied.executableFiles &&
      JSON.stringify(manifest.executableFiles) !== JSON.stringify(copied.executableFiles))
    throw new BackupManifestError('备份中的文件执行权限已改变。请从保留 Unix 执行权限的备份介质重新复制。');
  // On Windows the checksum still covers the recorded POSIX metadata; the local
  // filesystem cannot independently verify it or grant those mode bits.
  if (manifest.sha256 !== digest({ contentHash: copied.contentHash, executableFiles: manifest.executableFiles }))
    throw new BackupManifestError('备份摘要不匹配。');
}
