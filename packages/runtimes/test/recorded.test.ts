import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worktreeFile } from '../src/worktree-files.ts';
import { existingDataDirectory } from '../../store/src/paths.ts';
import { expect, it } from 'vitest';
import { parseProbeOutput } from '../src/output.ts';

for (const kind of ['claude', 'codex'] as const) {
  const packageRoot = existingDataDirectory(fileURLToPath(new URL('../', import.meta.url)));
  let dir = packageRoot;
  let missing = false;
  for (const component of ['fixtures', 'recorded', kind]) {
    dir = join(dir, component);
    if (!lstatSync(dir, { throwIfNoEntry: false })) { missing = true; break; }
    existingDataDirectory(dir);
  }
  const extension = kind === 'claude' ? '.json' : '.jsonl';
  const versioned = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu;
  const recordings = missing ? [] : readdirSync(dir).filter(name =>
    name.endsWith(extension) && versioned.test(name.slice(0, -extension.length))
  );
  if (!recordings.length) it.skip(kind + ' 尚无授权真实调用的回放样本', () => {});
  for (const name of recordings) {
    it(kind + ' 已录制样本 ' + name, () => {
      const source = worktreeFile(packageRoot, ['fixtures', 'recorded', kind, name].join('/'));
      const result = parseProbeOutput(kind, source);
      expect(result.text).toBe('CONCORDIA_OK');
      expect(result.recording === source).toBe(true);
    });
  }
}
