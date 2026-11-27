import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExclusiveFile } from '../src/worktree-files.ts';

const recording = 'fixtures/recorded/codex/0.0.1.jsonl';
let directory: string;
let packageRoot: string;
let other: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'concordia-recording-')));
  packageRoot = join(directory, 'runtimes');
  other = join(directory, 'other');
  mkdirSync(packageRoot);
  mkdirSync(other);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('首次录制创建子目录和完整文件，再录同版本保留原件', () => {
  expect(createExclusiveFile(packageRoot, recording, 'first\n')).toBe(true);
  expect(createExclusiveFile(packageRoot, recording, 'second\n')).toBe(false);
  const file = join(packageRoot, recording);
  expect(readFileSync(file, 'utf8')).toBe('first\n');
  expect(statSync(file).nlink).toBe(1);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(packageRoot, 'fixtures', 'recorded', 'codex'))).toEqual(['0.0.1.jsonl']);
});

it('程序包或录制目录含目录链接时拒绝创建，也不创建缺少的程序包根', () => {
  const alias = join(directory, 'alias');
  const missing = join(directory, 'missing');
  symlinkSync(packageRoot, alias, 'junction');
  symlinkSync(other, join(packageRoot, 'fixtures'), 'junction');
  expect(() => createExclusiveFile(alias, 'alias-result', 'body')).toThrow();
  expect(() => createExclusiveFile(packageRoot, recording, 'body')).toThrow();
  expect(() => createExclusiveFile(missing, recording, 'body')).toThrow();
  expect(readdirSync(other)).toEqual([]);
  expect(readdirSync(packageRoot)).toEqual(['fixtures']);
  expect(readdirSync(directory)).not.toContain('missing');
});

it('最终位置已被硬链接占用时，保留文件与原内容', () => {
  const content = join(other, 'file');
  const target = join(packageRoot, 'fixtures', 'recorded', 'codex');
  mkdirSync(target, { recursive: true });
  writeFileSync(content, 'original');
  linkSync(content, join(target, '0.0.1.jsonl'));
  expect(createExclusiveFile(packageRoot, recording, 'new')).toBe(false);
  expect(readFileSync(content, 'utf8')).toBe('original');
  expect(readdirSync(target)).toEqual(['0.0.1.jsonl']);
});
