import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { CliDiagnosticError } from './errors.ts';

const windows = process.platform === 'win32';
const separator = windows ? /[\\/]+/u : /\/+/u;
const privateName = /^(?:\.claude|\.codex)(?:\.json(?:\..*)?)?$/iu;

function blocked() {
  return new CliDiagnosticError('CLI 可执行文件和工作目录必须位于本地，且与 CLI 的配置和认证文件分开。', 'permission');
}

function check(path: string, env: NodeJS.ProcessEnv) {
  if (!isAbsolute(path) || path.includes('\0') || (windows && !/^[a-z]:[\\/]/iu.test(path))) throw blocked();
  const parts = path.slice(parse(path).root.length).split(separator);
  for (const part of parts) {
    if (part === '.' || part === '..') continue;
    if (privateName.test(part.replace(/[. ]+$/u, '')) ||
        (windows && (part.includes(':') || /[. ]$/u.test(part)))) throw blocked();
  }
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    const location = env[name];
    if (location && isAbsolute(location)) {
      const tail = relative(location, path);
      if (tail === '' || (tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail))) throw blocked();
    }
  }
}

// Follow one symlink/junction at a time and check its target *before* examining
// descendants. Checking only the final realpath would overlook a chain through
// a private directory that points back to a public executable.
export async function resolveCliPath(path: string, env: NodeJS.ProcessEnv) {
  check(path, env);
  let current = parse(path).root;
  let parts = path.slice(current.length).split(separator).filter(Boolean);
  let links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const candidate = join(current, part);
    check(candidate, env);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new CliDiagnosticError('CLI 路径的链接链过长。', 'permission');
      let target = await readlink(candidate);
      // Node may return a Win32 namespace prefix for an ordinary local junction.
      if (windows && /^\\\\\?\\[a-z]:\\/iu.test(target)) target = target.slice(4);
      const absolute = isAbsolute(target);
      if (windows && !absolute && /^[a-z]:/iu.test(target)) throw blocked();
      check(absolute ? target : current + sep + target, env);
      if (absolute) current = parse(target).root;
      parts = [...(absolute ? target.slice(current.length) : target).split(separator).filter(Boolean), ...parts];
    } else {
      if (parts.length && !info.isDirectory()) throw new CliDiagnosticError('CLI 路径包含非目录项。');
      // Expand short Windows names before descending into another component.
      current = windows ? await realpath(candidate) : candidate;
      check(current, env);
    }
  }
  return current;
}

export async function resolveCliDirectory(path: string, env: NodeJS.ProcessEnv) {
  try {
    const dir = await resolveCliPath(path, env);
    if ((await stat(dir)).isDirectory()) return dir;
  } catch (error) {
    if (error instanceof CliDiagnosticError) throw error;
  }
  throw new CliDiagnosticError('CLI 工作目录不存在、不是目录或无法访问。');
}
