import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseProbeOutput } from '../src/output.ts';

for (const kind of ['claude', 'codex'] as const) {
  const dir = new URL('../fixtures/recorded/' + kind + '/', import.meta.url);
  let files: string[] = [];
  try { files = await readdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const extension = kind === 'claude' ? '.json' : '.jsonl';
  const recordings = files.filter(name => name.endsWith(extension));
  if (!recordings.length) it.skip(kind + ' 尚无授权真实调用的回放样本', () => {});
  for (const name of recordings) {
    it(kind + ' 已录制样本 ' + name, async () => {
      const source = await readFile(new URL(name, dir), 'utf8');
      const result = parseProbeOutput(kind, source);
      expect(result.text).toBe('CONCORDIA_OK');
      expect(result.recording).toBe(source);
    });
  }
}
