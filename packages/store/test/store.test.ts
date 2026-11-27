import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore } from '../src/index.ts';

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'concordia-store-'));
  path = join(directory, 'concordia.sqlite');
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));

it('在本地文件启用 WAL，重复启动只执行迁移一次', () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openStore(path);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual([
        { version: 1, name: '001-bootstrap.sql' },
      ]);
    } finally {
      db.close();
    }
  }
});

it('遇到较新的数据版本时停止，不覆盖数据版本', () => {
  const future = new DatabaseSync(path);
  future.exec('PRAGMA user_version = 2');
  future.close();
  expect(() => openStore(path)).toThrow('数据库版本不受支持');
  const check = new DatabaseSync(path);
  try {
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  } finally {
    check.close();
  }
});
