import type { DatabaseSync } from 'node:sqlite';
import { databaseVersion } from '@concordia/store/database-identity';

export function identifyWorktreeDatabase(db: DatabaseSync) {
  const version = databaseVersion(db, 4);
  if (!version) return version;
  const expected: [string, string][] = [
    ['projects', 'id,repository,target,writable,commands'],
    ['trees', 'id,project,task,kind,branch,base,sha,status,snapshot,conflicts' + (version >= 3 ? ',scope' : '')],
    ['publications', 'tree,sha'],
    ['approvals', 'id,tree,kind,sha,target,name,command,status,result' + (version >= 4 ? ',acceptance,run_order' : '')],
  ];
  if (version >= 2) expected.push(['conflict_issues', 'tree,recipients']);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  for (const [name, columns] of expected) {
    if (!tables.has(name)) throw new Error('已有数据库未包含匹配的 Concordia 工作树表。');
    // Resolving the projection verifies all columns used by this schema revision
    // before opening a writable connection. No project rows or paths are exposed.
    db.prepare('SELECT ' + columns + ' FROM ' + name + ' LIMIT 0');
  }
  return version;
}
