import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { devNull } from 'node:os';

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
    GIT_CONFIG_GLOBAL: devNull,
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
      'core.hooksPath=' + devNull,
      '-c',
      'core.fsmonitor=false',
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
  return { code: result.status, output: result.stdout };
}

export function git(cwd: string, args: string[]) {
  const result = gitResult(cwd, args);
  if (result.code !== 0) throw new Error('Git 操作未完成，请检查仓库、分支及工作副本状态。');
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
  const privateCliPath = /(?:^|[\\/])\.(?:claude|codex)(?:[\\/]|$)/i;
  if (privateCliPath.test(path)) throw new Error('仓库管理目录指向 CLI 私有目录。');
  const canonical = realpathSync(path);
  if (privateCliPath.test(canonical) || !lstatSync(canonical).isDirectory())
    throw new Error('仓库管理目录无效。');
  return canonical;
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
  if (checkedGitDirectory(repo) !== repo) throw new Error('仓库位置已改变。');
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
