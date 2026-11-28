import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { safeDatabasePath } from './paths.ts';
import { databaseVersion, verifyBeforeOpening } from './database-identity.ts';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  { version: 1, name: '001-bootstrap.sql' },
  { version: 2, name: '002-connections.sql' },
  { version: 3, name: '003-workflow.sql' },
  { version: 4, name: '004-application.sql' },
  { version: 5, name: '005-code-bindings.sql' },
  { version: 6, name: '006-budget-ledger.sql' },
  { version: 7, name: '007-paused-pools.sql' },
  { version: 8, name: '008-plan-draft.sql' },
] as const;

function identifyStore(db: DatabaseSync): number {
  const version = databaseVersion(db, migrations.length);
  if (!version) return version;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get())
    throw new Error('已有数据库缺少 Concordia 迁移记录。');
  const rows = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  if (rows.length !== version || rows.some((row, i) =>
    row.version !== migrations[i].version || row.name !== migrations[i].name))
    throw new Error('已有数据库的 Concordia 迁移历史不匹配。');
  return version;
}

/** 在写事务内再次读取版本，允许多个启动进程先后尝试迁移。 */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = identifyStore(db);

    for (const { version, name } of migrations) {
      if (version <= current) continue;
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
      db.exec(`PRAGMA user_version = ${version}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 调用方负责选择私有数据目录、创建父目录，以及使用完毕时关闭数据库。 */
export function openStore(databasePath: string): DatabaseSync {
  const absolute = resolve(databasePath);
  const file = safeDatabasePath(dirname(absolute), basename(absolute));
  verifyBeforeOpening(file, identifyStore);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const mode = db.prepare('PRAGMA journal_mode = WAL').get();
    if (mode?.journal_mode !== 'wal') {
      throw new Error('此数据库无法启用 WAL，请选择本地磁盘上的普通文件。');
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
