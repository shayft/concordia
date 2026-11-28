import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore } from '../src/index.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concordia-migrations-'));
  file = join(dir, 'data.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const migrations = new URL('../migrations/', import.meta.url);
const scripts = readdirSync(migrations).filter(f => /^\d{3}-.*\.sql$/u.test(f)).sort();
function oldStore(version: number) {
  const db = new DatabaseSync(file);
  for (const [index, filename] of scripts.slice(0, version).entries()) {
    db.exec(readFileSync(new URL(filename, migrations), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index + 1, filename);
    db.exec('PRAGMA user_version=' + (index + 1));
  }
  db.exec("CREATE TABLE retained_note(value TEXT); INSERT INTO retained_note VALUES ('保留旧数据')");
  return db;
}
function snapshot() {
  return readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name))]);
}

it.each(scripts.slice(0, -1).map((_, n) => n + 1))('版本 %i 的已登记旧库保留数据并完整升级', version => {
  oldStore(version).close();
  const upgraded = openStore(file);
  try {
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(scripts.length);
    expect(upgraded.prepare('SELECT value FROM retained_note').get()?.value).toBe('保留旧数据');
    expect(upgraded.prepare('SELECT name FROM schema_migrations ORDER BY version').all().map(row => row.name)).toEqual(scripts);
  } finally { upgraded.close(); }
});

it.each(['foreign', 'future', 'wrong-history', 'wal'])('无写拒绝 %s 数据库，包含版本、日志模式及旁文件', kind => {
  const db = kind === 'wrong-history' ? oldStore(1) : new DatabaseSync(file);
  let open = true;
  try {
    if (kind === 'future') db.exec('PRAGMA user_version=123');
    if (kind === 'wal') db.exec('PRAGMA journal_mode=WAL');
    if (kind === 'wrong-history') db.exec("UPDATE schema_migrations SET name='other.sql'");
    else db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('保持不变')");
    if (kind !== 'wal') { db.close(); open = false; }
    const before = snapshot();
    expect(() => openStore(file)).toThrow();
    expect(snapshot()).toEqual(before);
  } finally { if (open) db.close(); }
});

it('识别成功后迁移中途失败，回滚本次所有表与版本', () => {
  const db = oldStore(1);
  db.exec('CREATE TABLE connections(private_note TEXT)');
  db.close();
  expect(() => openStore(file)).toThrow();
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(check.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(1);
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE name='quota_pools'").get()).toBeUndefined();
    expect(check.prepare('SELECT value FROM retained_note').get()?.value).toBe('保留旧数据');
  } finally { check.close(); }
});
