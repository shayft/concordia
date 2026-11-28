import type { DatabaseSync } from 'node:sqlite';
import { databaseVersion } from '@concordia/store/database-identity';

export function identifyWorktreeDatabase(db: DatabaseSync) {
  const version = databaseVersion(db, 4);
  if (!version) return version;
  const tables = ['projects', 'trees', 'publications', 'approvals'];
  if (version >= 2) tables.push('conflict_issues');
  const present = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  if (tables.some(name => !present.has(name)) ||
      (version >= 3 && !db.prepare("SELECT 1 FROM pragma_table_info('trees') WHERE name='scope'").get()))
    throw new Error('已有数据库未包含匹配的 Concordia 工作树表。');
  if (version >= 4 && db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('approvals') WHERE name IN ('acceptance','run_order')").get()?.count !== 2)
    throw new Error('工作树数据库缺少审批证据字段。');
  return version;
}
