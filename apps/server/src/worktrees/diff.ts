import { worktreeFile } from '@concordia/runtimes/worktree-files';
import { git } from './git.ts';

const diffOptions = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

export function versionDiff(repo: string, base: string, sha: string) {
  return git(repo, [...diffOptions, base, sha, '--']);
}

// The working file is opened through the same pinned, ordinary-file boundary as
// read_file. Render one contiguous hunk, trimming common lines at both ends.
function hunk(path: string, before: string, after: string) {
  if (before === after) return '';
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = lines(before), right = lines(after);
  let start = 0, l = left.length, r = right.length;
  while (start < l && start < r && left[start] === right[start]) start++;
  while (l > start && r > start && left[l - 1] === right[r - 1]) { l--; r--; }
  const render = (part: string[], prefix: string) => part.map(line =>
    prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')).join('');
  return '--- a/' + path + '\n+++ b/' + path + '\n@@ -' + (l === start ? start : start + 1) + ',' +
    (l - start) + ' +' + (r === start ? start : start + 1) + ',' + (r - start) + ' @@\n' +
    render(left.slice(start,l), '-') + render(right.slice(start,r), '+');
}

export function workingDiff(path: string) {
  const staged = git(path, [...diffOptions, '--cached', 'HEAD', '--']);
  const entries = git(path, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
    .split('\0').filter(Boolean);
  if (entries.length > 512) throw new Error('变更文件太多，请在本机 Git 中查看。');
  const untracked: string[] = [];
  let diff = staged;
  for (const entry of entries) {
    const name = entry.slice(3), status = entry[1];
    if (status === ' ') continue;
    const isNew = entry.startsWith('?? ');
    if (isNew) untracked.push(name);
    let section: string;
    try {
      let previous = '';
      if (!isNew) {
        const index = git(path, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', name]);
        const blob = /^(?:100644|100755) ([a-f0-9]{40,64}) 0\t/.exec(index)?.[1];
        if (!blob || Number(git(path, ['cat-file', '-s', blob])) > 512 * 1024) throw new Error();
        previous = git(path, ['cat-file', 'blob', blob]);
      }
      const current = status === 'D' ? '' : worktreeFile(path, name);
      if (previous.includes('\0') || current.includes('\0')) throw new Error();
      section = hunk(name, previous, current) || '文件状态已改变：' + name + '\n';
    } catch {
      section = '无法安全显示此文件的文本差异：' + name + '\n';
    }
    diff += section;
    if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error('差异超过显示上限，请在本机 Git 中查看。');
  }
  return { diff, untracked };
}
