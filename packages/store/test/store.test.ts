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
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(10);
      expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual([
        { version: 1, name: '001-bootstrap.sql' },
        { version: 2, name: '002-connections.sql' },
        { version: 3, name: '003-workflow.sql' },
        { version: 4, name: '004-application.sql' },
        { version: 5, name: '005-code-bindings.sql' },
        { version: 6, name: '006-budget-ledger.sql' },
        { version: 7, name: '007-paused-pools.sql' },
        { version: 8, name: '008-plan-draft.sql' },
        { version: 9, name: '009-plan-requests.sql' },
        { version: 10, name: '010-governance.sql' },
      ]);
    } finally {
      db.close();
    }
  }
});

it('遇到较新的数据版本时停止，不覆盖数据版本', () => {
  const future = new DatabaseSync(path);
  future.exec('PRAGMA user_version = 99');
  future.close();
  expect(() => openStore(path)).toThrow('数据库版本不受支持');
  const check = new DatabaseSync(path);
  try {
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(99);
  } finally {
    check.close();
  }
});
