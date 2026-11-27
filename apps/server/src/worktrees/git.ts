import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existingDataDirectory } from '@concordia/store/paths';

// Git for Windows uses its own pathname layer. A regular file works on all
// platforms and cannot be traversed as an executable hook directory.
const defaults = fileURLToPath(new URL('./git.defaults', import.meta.url)).replaceAll('\\', '/');

const candidates =
  process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .filter(isAbsolute)
          .map((folder) => join(folder, 'git.exe')),
      ]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
const gitExecutable = candidates.find((path) => existsSync(path));

export function gitResult(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: defaults,
    GIT_ATTR_NOSYSTEM: '1',
    SystemDrive: process.env.SystemDrive,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    USERPROFILE: process.env.USERPROFILE,
    ProgramFiles: process.env.ProgramFiles,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'none',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  if (!gitExecutable) throw new Error('找不到系统 Git，请安装 Git 并重新启动。');
  const result = spawnSync(
    gitExecutable,
    [
      '-c',
      'core.hooksPath=' + defaults,
      '-c',
      'core.attributesFile=' + defaults,
      '-c',
      'core.excludesFile=' + defaults,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.longpaths=true',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'merge.autoStash=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'gc.auto=0',
      '-c',
      'user.name=Concordia',
      '-c',
      'user.email=concordia@localhost',
      ...args,
    ],
    {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20_000,
    },
  );
  if (result.error || result.status === null) throw new Error('Git 操作超时、输出超限或程序不可用。');
  const stderr = result.stderr;
  const reason = /dubious ownership|safe.directory/i.test(stderr)
    ? '仓库归属不受信任'
    : /config|unable to access|permission denied/i.test(stderr)
      ? '配置或路径不可访问'
      : /unknown option|usage:|unsupported|invalid argument/i.test(stderr)
        ? '路径或参数不受支持'
        : /home not set|home directory/i.test(stderr)
          ? '运行环境不完整'
          : '仓库或工作副本状态不允许操作';
  return { code: result.status, output: result.stdout, reason };
}

export function git(cwd: string, args: string[]) {
  const result = gitResult(cwd, args);
  if (result.code !== 0) {
    const fixedNames = [
      'config',
      'init',
      'status',
      'worktree',
      'rev-parse',
      'commit',
      'merge',
      'add',
      'diff',
      'branch',
      'ls-tree',
      'cat-file',
      'symbolic-ref',
      'merge-base',
      'check-ref-format',
      'update-ref',
    ];
    const verb = args.find((arg) => fixedNames.includes(arg)) ?? 'command';
    throw new Error(`Git ${verb} 未完成（退出码 ${result.code}，${result.reason}）。`);
  }
  return result.output;
}

export function gitWorktrees(repo: string) {
  return git(repo, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      return {
        path: fields[0]!.slice('worktree '.length),
        branch: fields.find((value) => value.startsWith('branch '))?.slice(7),
      };
    });
}

function checkedGitDirectory(path: string) {
  // Preserve the ban on CLI directories and directory links independently of
  // path spelling. Windows may report long names, 8.3 aliases or different case.
  return realpathSync.native(existingDataDirectory(path));
}

export function sameDirectory(a: string, b: string) {
  const left = statSync(checkedGitDirectory(a), { bigint: true });
  const right = statSync(checkedGitDirectory(b), { bigint: true });
  if (
    !left.isDirectory() ||
    !right.isDirectory() ||
    left.ino <= 0n ||
    right.ino <= 0n ||
    left.dev <= 0n ||
    right.dev <= 0n
  ) {
    throw new Error('文件系统未提供可核对的目录身份。');
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function checkMetadata(path: string, max: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
    throw new Error('Git 元数据不是受支持的普通文件。');
}
function readMetadata(path: string, max: number) {
  checkMetadata(path, max);
  return readFileSync(path, 'utf8');
}

export function checkLocalConfig(repo: string) {
  repo = checkedGitDirectory(repo);
  const marker = join(repo, '.git');
  const type = lstatSync(marker);
  let gitDir = marker;
  if (!type.isDirectory()) {
    const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readMetadata(marker, 8192));
    if (!pointer) throw new Error('Git 工作区标识无效。');
    gitDir = resolve(repo, pointer[1]!);
  }
  gitDir = checkedGitDirectory(gitDir);
  const sharedPointer = join(gitDir, 'commondir');
  const shared = existsSync(sharedPointer)
    ? checkedGitDirectory(resolve(gitDir, readMetadata(sharedPointer, 8192).trimEnd()))
    : gitDir;
  const config = join(shared, 'config');
  checkMetadata(config, 1024 * 1024);
  if (existsSync(join(shared, 'objects', 'info', 'alternates')))
    throw new Error('仓库使用外部对象存储，需要先自行审查。');
  if (!gitExecutable) throw new Error('找不到系统 Git。');
  // Inspect names only in this exact file before allowing Git to discover
  // the repository. Config values or external include files are not needed.
  const keys = git(dirname(gitExecutable), [
    'config',
    '--file',
    config,
    '--no-includes',
    '--name-only',
    '--list',
  ]).split('\n');
  if (
    keys.some((key) =>
      /^(include(if)?\.|filter\.|merge\..*\.driver$|diff\..*\.(textconv|command)$|extensions\.worktreeconfig$|core\.worktree$)/i.test(
        key,
      ),
    )
  ) {
    throw new Error('仓库含单独的配置、外部驱动或工作目录重定向，无法安全自动操作。');
  }
}
