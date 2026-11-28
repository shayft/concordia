import { basename, dirname, join, resolve } from 'node:path';
import { existingDataDirectory, safeDataDirectory } from '../../packages/store/src/paths.ts';

export function existingDirectory(path) { return existingDataDirectory(resolve(path)); }

export function newDestination(value, createParents = false) {
  const full = resolve(value), name = basename(full);
  if (!name || ['.claude', '.codex'].includes(name.replace(/[. ]+$/u, '').toLowerCase()))
    throw new Error('请选择独立于 CLI 配置的目标目录。');
  const parent = createParents ? safeDataDirectory(dirname(full)) : existingDataDirectory(dirname(full));
  return join(parent, name);
}
