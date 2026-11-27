// Only platform file primitives live here. The caller supplies a verified,
// service-owned worktree root and authorizes the operation before entry.
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as flags,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, sep, toNamespacedPath } from 'node:path';
import koffi from 'koffi';

const limit = 512 * 1024;
const invalid = () => new Error('文件不在允许的工作区内，或文件类型不受支持。');

export function worktreePathParts(path: string) {
  if (path.length > 2048) throw invalid();
  const parts = path.split('/');
  for (const part of parts) {
    if (
      !/^[\p{L}\p{N}\p{M}_. ()@+-]{1,200}$/u.test(part) ||
      /[. ]$|\p{Default_Ignorable_Code_Point}/u.test(part) ||
      /^(\.git|\.claude|\.codex)$/i.test(part) ||
      /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i.test(part)
    )
      throw invalid();
  }
  return parts;
}

function checkFile(fd: number) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw invalid();
  return stat;
}

function readText(fd: number) {
  checkFile(fd);
  const bytes = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (!count) break;
    offset += count;
  }
  if (offset > limit) throw invalid();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
}

function posixTools() {
  const lib = koffi.load(null);
  return {
    open: lib.func('int openat(int, const char *, int, ...)'),
    mkdir: lib.func('int mkdirat(int, const char *, uint32_t)'),
    publishNew(parent: number, source: string, destination: string): number {
      if (process.platform === 'darwin') {
        const rename = lib.func('int renameatx_np(int, const char *, int, const char *, unsigned int)');
        return rename(parent, source, parent, destination, 4); // RENAME_EXCL
      }
      const rename = lib.func('int renameat2(int, const char *, int, const char *, unsigned int)');
      return rename(parent, source, parent, destination, 1); // RENAME_NOREPLACE
    },
    rename: lib.func('int renameat(int, const char *, int, const char *)'),
    unlink: lib.func('int unlinkat(int, const char *, int)'),
  };
}
let posix: ReturnType<typeof posixTools> | undefined;

// A recording pins the entire canonical package path from the filesystem root.
interface ExclusiveCreate { existingParents: string[] }
function posixFile(root: string, parts: string[], text?: string, create?: ExclusiveCreate): string {
  const api = (posix ??= posixTools());
  const directory = flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW;
  let parent = openSync(root, directory);
  try {
    const existing = create?.existingParents ?? [];
    const parents = [...existing, ...parts.slice(0, -1)];
    for (const [index, part] of parents.entries()) {
      let next: number = api.open(parent, part, directory);
      if (next < 0 && koffi.errno() === 2 && text !== undefined && index >= existing.length) {
        api.mkdir(parent, part, 0o700); // Another writer may have created it.
        next = api.open(parent, part, directory);
      }
      if (next < 0) throw invalid();
      closeSync(parent);
      parent = next;
    }
    const name = parts.at(-1)!;
    let mode = create ? 0o600 : 0o644;
    if (!create) {
      const fd: number = api.open(parent, name, flags.O_RDONLY | flags.O_NONBLOCK | flags.O_NOFOLLOW);
      if (fd >= 0) {
        try {
          if (text === undefined) return readText(fd);
          mode = checkFile(fd).mode & 0o777;
        } finally {
          closeSync(fd);
        }
      } else if (text === undefined || koffi.errno() !== 2) throw invalid();
    }

    const temp = '.concordia-' + randomUUID();
    const out: number = api.open(
      parent,
      temp,
      flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW,
      'int',
      0o600,
    );
    if (out < 0) throw invalid();
    try {
      try {
        writeFileSync(out, text!);
        fchmodSync(out, mode);
      } finally {
        closeSync(out);
      }
      // Publishing with an exclusive rename leaves either a complete recording or no recording.
      if (create) {
        if (api.publishNew(parent, temp, name) === 0) return 'created';
        if (koffi.errno() === 17) return 'exists'; // EEXIST
        throw invalid();
      }
      if (api.rename(parent, temp, parent, name) !== 0) throw invalid();
    } finally {
      api.unlink(parent, temp, 0);
    }
    return '';
  } finally {
    closeSync(parent);
  }
}

function windowsTools() {
  const lib = koffi.load('kernel32.dll');
  return {
    open: lib.func(
      'void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)',
    ),
    moveNew: lib.func('int __stdcall MoveFileW(str16, str16)'),
    attributes: lib.func('int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)'),
    close: lib.func('int __stdcall CloseHandle(void *)'),
  };
}
let windows: ReturnType<typeof windowsTools> | undefined;

function windowsFile(root: string, parts: string[], text?: string, create?: ExclusiveCreate): string {
  const api = (windows ??= windowsTools());
  const pins: bigint[] = [];
  function pin(path: string, directory: boolean) {
    // No FILE_SHARE_DELETE: all inspected parents stay pinned through the operation.
    const handle: bigint = api.open(toNamespacedPath(path), 0x80, 3, null, 3, 0x02200000, null);
    if (!handle || BigInt.asIntN(64, handle) === -1n) throw invalid();
    pins.push(handle);
    const info = Buffer.alloc(8);
    if (!api.attributes(handle, 9, info, info.length)) throw invalid(); // FileAttributeTagInfo
    const attr = info.readUInt32LE();
    if (attr & 0x400 || Boolean(attr & 0x10) !== directory) throw invalid();
  }
  try {
    let parent = root;
    pin(parent, true);
    const existing = create?.existingParents ?? [];
    const parents = [...existing, ...parts.slice(0, -1)];
    for (const [index, part] of parents.entries()) {
      parent = join(parent, part);
      if (text !== undefined && index >= existing.length) {
        try {
          mkdirSync(parent);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw invalid();
        }
      }
      pin(parent, true);
    }
    const path = join(parent, parts.at(-1)!);
    if (!create && lstatSync(path, { throwIfNoEntry: false })) {
      pin(path, false);
      const fd = openSync(path, 'r');
      try {
        if (text === undefined) return readText(fd);
        checkFile(fd);
      } finally {
        closeSync(fd);
      }
      api.close(pins.pop()); // Atomic replacement never follows the final link.
    } else if (text === undefined) throw invalid();
    const temp = join(parent, '.concordia-' + randomUUID());
    const out = openSync(temp, 'wx', 0o600);
    try {
      try {
        writeFileSync(out, text!);
      } finally {
        closeSync(out);
      }
      if (create) {
        // MoveFileW never replaces an existing name, including a junction or link.
        if (api.moveNew(toNamespacedPath(temp), toNamespacedPath(path))) return 'created';
        if (lstatSync(path, { throwIfNoEntry: false })) return 'exists';
        throw invalid();
      }
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    return '';
  } finally {
    for (const handle of pins.reverse()) api.close(handle);
  }
}

export function worktreeFile(root: string, path: string, text?: string): string {
  if (text !== undefined && Buffer.byteLength(text) > limit) throw invalid();
  const parts = worktreePathParts(path);
  try {
    return process.platform === 'win32' ? windowsFile(root, parts, text) : posixFile(root, parts, text);
  } catch {
    throw invalid();
  }
}

/** Publish a complete recording once. The caller supplies a canonical, existing package root. */
export function createExclusiveFile(root: string, path: string, text: string): boolean {
  if (!isAbsolute(root) || Buffer.byteLength(text) > limit) throw invalid();
  const volume = parse(root).root;
  const create = { existingParents: root.slice(volume.length).split(sep).filter(Boolean) };
  const parts = worktreePathParts(path);
  const access = process.platform === 'win32' ? windowsFile : posixFile;
  try {
    return access(volume, parts, text, create) === 'created';
  } catch {
    throw invalid();
  }
}
