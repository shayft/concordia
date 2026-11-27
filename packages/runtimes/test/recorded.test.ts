import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worktreeFile } from '../src/worktree-files.ts';
import { existingDataDirectory } from '../../store/src/paths.ts';
import { expect, it } from 'vitest';
import { parseProbeOutput } from '../src/output.ts';
import type { CliKind } from '../src/environment.ts';

function isCanonicalReplay(kind: CliKind, source: string) {
  const result = parseProbeOutput(kind, source);
  return result.text === 'CONCORDIA_OK' && result.recording === source.replaceAll('\r\n', '\n');
}

const examples = {
  claude: '{"type":"result","subtype":"success","is_error":false,"result":"CONCORDIA_OK"}\n',
  codex: '{"type":"turn.started"}\n' +
    '{"type":"item.completed","item":{"type":"agent_message","text":"CONCORDIA_OK"}}\n' +
    '{"type":"turn.completed"}\n',
};

for (const kind of ['claude', 'codex'] as const) {
  it(kind + ' 模拟回放在 Windows 换行下仍严格检查字段和格式', () => {
    const source = examples[kind].replaceAll('\n', '\r\n');
    expect(isCanonicalReplay(kind, source)).toBe(true);
    expect(isCanonicalReplay(kind, source.replace('"type":', '"extra":true,"type":'))).toBe(false);
    expect(isCanonicalReplay(kind, source.replace('\r\n', ' \r\n'))).toBe(false);
  });
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
      expect(isCanonicalReplay(kind, source)).toBe(true);
    });
  }
}
