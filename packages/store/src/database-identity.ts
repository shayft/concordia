import { constants, copyFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateTemporaryDirectory } from './paths.ts';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function databaseVersion(db: DatabaseSync, latest: number): number {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (!Number.isInteger(version) || version < 0 || version > latest)
    throw new Error('数据库版本不受支持，请使用与数据匹配的 Concordia 版本。');
  if (db.prepare('PRAGMA application_id').get()?.application_id !== 0)
    throw new Error('数据库属于其他应用。');
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get())
    throw new Error('已有数据库不是空库，无法确认为 Concordia 数据。');
  return version;
}

// Open existing files before changing journal mode or starting a write transaction.
// SQLite's immutable mode cannot see uncheckpointed WAL. Recover WAL/hot journals
// in a private scratch copy, so even an unrelated database keeps its original sidecars.
export function verifyBeforeOpening(path: string, identify: (db: DatabaseSync) => unknown) {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  const journals = ['-wal', '-journal'].filter(suffix =>
    (lstatSync(path + suffix, { throwIfNoEntry: false })?.size ?? 0) > 0);
  let scratch: string | undefined;
  let probe: DatabaseSync | undefined;
  try {
    if (journals.length) {
      scratch = privateTemporaryDirectory(tmpdir(), 'concordia-schema-');
      const database = join(scratch, 'inspection.sqlite');
      for (const suffix of ['', ...journals])
        copyFileSync(path + suffix, database + suffix, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      probe = new DatabaseSync(database);
    } else {
      const uri = pathToFileURL(path);
      uri.searchParams.set('immutable', '1');
      probe = new DatabaseSync(uri.href, { readOnly: true });
    }
    identify(probe);
  } finally {
    try { probe?.close(); } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
}
