import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ContentStore } from '../src/content.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concordia-content-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('摘要、文件类型与链接数经过校验，写入已有摘要也验证对象', () => {
  const store = new ContentStore(dir);
  const ref = store.put('正文'),
    object = join(dir, 'objects', ref);
  expect(store.get(ref)).toBe('正文');
  writeFileSync(object, '损坏');
  expect(() => store.put('正文')).toThrow('摘要不匹配');
  unlinkSync(object);
  const outside = join(dir, 'fixture');
  writeFileSync(outside, '正文');
  linkSync(outside, object);
  expect(() => store.get(ref)).toThrow('独立普通文件');
});
it('拒绝被替换为目录链接的对象目录', () => {
  const store = new ContentStore(dir);
  store.put('正文');
  const objects = join(dir, 'objects'),
    moved = join(dir, 'moved');
  renameSync(objects, moved);
  symlinkSync(moved, objects, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => store.put('新正文')).toThrow('内容目录');
  expect(() => new ContentStore(dir)).toThrow();
});
it('目录即使在相同名称重新建立也会被识别出来', () => {
  const store = new ContentStore(dir),
    objects = join(dir, 'objects');
  renameSync(objects, join(dir, 'old'));
  mkdirSync(objects);
  expect(() => store.put('正文')).toThrow('内容目录');
});
