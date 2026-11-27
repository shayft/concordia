import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { existingDataDirectory, safeDatabasePath, safeDataDirectory } from '@concordia/store/paths';
import { runProcess } from '@concordia/runtimes/process';
import { worktreeFile, worktreePathParts } from '@concordia/runtimes/worktree-files';
import { checkLocalConfig, git, gitResult, gitWorktrees, sameDirectory } from './git.ts';

const id = z.string().min(1).max(180);
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const command = z.strictObject({
  name: z.string().regex(/^[\w.-]{1,64}$/),
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(80),
});
export const projectSchema = z.strictObject({
  id,
  repository: z.string().min(1).max(4096),
  targetBranch: z.string().min(1).max(220),
  writeEnabled: z.boolean(),
  commands: z.array(command).max(32),
});
export const snapshotSchema = z
  .array(z.object({ treeId: z.uuid(), sha }))
  .min(1)
  .max(64);
type Project = z.infer<typeof projectSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type Row = Record<string, unknown>;
export interface WorktreeIssue {
  id: string;
  treeId: string;
  projectId: string;
  taskIds: string[];
  paths: string[];
  status: 'open';
}
type Kind = 'member' | 'integration';

function within(parent: string, path: string) {
  const rest = relative(parent, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep));
}
function checkRepoLocation(path: string, data: string) {
  if (
    within(path, data) ||
    within(data, path) ||
    within(path, homedir()) ||
    path.split(/[\\/]/).some((part) => ['.claude', '.codex'].includes(part.toLowerCase()))
  ) {
    throw new Error('仓库须独立于平台数据及 CLI 配置目录。');
  }
}
function clean(path: string) {
  return git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) === '';
}
function head(path: string) {
  return sha.parse(git(path, ['rev-parse', '--verify', 'HEAD^{commit}']).trim());
}
function target(project: Project) {
  return 'refs/heads/' + project.targetBranch;
}

export class WorktreeService {
  private db: DatabaseSync;
  private directory: string;
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  private closed = false;
  private onConflict?: (issue: WorktreeIssue) => void;
  private readonly recoveryDir: string;
  constructor(
    dataDirectory: string,
    onConflict?: (issue: WorktreeIssue) => void,
    recoveryDir = join(dataDirectory, 'processes'),
  ) {
    this.recoveryDir = recoveryDir;
    this.onConflict = onConflict;
    this.directory = safeDataDirectory(dataDirectory, 'worktrees');
    this.db = new DatabaseSync(safeDatabasePath(dataDirectory, 'worktrees.sqlite'));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (this.db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') {
      this.db.close();
      throw new Error('工作区数据库需要支持 WAL 的本地文件系统。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        this.db.exec(readFileSync(new URL('./001-worktrees.sql', import.meta.url), 'utf8'));
        this.db.exec('PRAGMA user_version=1');
      }
      if (version === 0 || version === 1) {
        this.db.exec(readFileSync(new URL('./002-conflict-issues.sql', import.meta.url), 'utf8'));
        this.db.exec('PRAGMA user_version=2');
      }
      if (version === 0 || version === 1 || version === 2) {
        this.db.exec(readFileSync(new URL('./003-task-scope.sql', import.meta.url), 'utf8'));
        this.db.exec('PRAGMA user_version=3');
      } else if (version !== 3) throw new Error('工作区数据库版本不受支持。');
      this.db.exec(
        "UPDATE approvals SET status='interrupted' WHERE status='running'; UPDATE trees SET status='interrupted' WHERE status IN ('creating','integrating'); COMMIT",
      );
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  async cancelAll(): Promise<void> {
    const active = [...this.running.values()];
    for (const item of active) item.controller.abort();
    await Promise.all(active.map((item) => item.done));
  }
  close(): void | Promise<void> {
    this.closing = true;
    const closeStore = () => {
      if (!this.closed) {
        this.closed = true;
        this.db.close();
      }
    };
    if (!this.running.size) return closeStore();
    return this.cancelAll().then(closeStore);
  }
  configure(input: Project) {
    if (this.closing) throw new Error('服务正在关闭。');
    const config = projectSchema.parse(input);
    if (!isAbsolute(config.repository)) throw new Error('请指定仓库的绝对路径。');
    checkRepoLocation(resolve(config.repository), this.directory);
    const repo = realpathSync.native(config.repository);
    checkRepoLocation(repo, this.directory);
    checkLocalConfig(repo);
    // Start from the actual repository root, never from a subdirectory or bare repository.
    if (!sameDirectory(git(repo, ['rev-parse', '--show-toplevel']).trimEnd(), repo))
      throw new Error('请选择 Git 工作副本根目录。');
    git(repo, ['check-ref-format', target(config)]);
    git(repo, ['rev-parse', '--verify', target(config) + '^{commit}']);
    if (
      config.targetBranch.startsWith('concordia/') ||
      new Set(config.commands.map((c) => c.name)).size !== config.commands.length ||
      config.commands.some(
        (c) =>
          !isAbsolute(c.executable) ||
          c.executable.includes('\0') ||
          c.args.some((arg) => arg.includes('\0')),
      )
    ) {
      throw new Error('目标分支、项目命令名称或可执行文件绝对路径无效。');
    }
    const existing = this.db.prepare('SELECT * FROM projects WHERE id=?').get(config.id);
    if (
      existing &&
      this.db.prepare('SELECT 1 FROM trees WHERE project=?').get(config.id) &&
      (!sameDirectory(String(existing.repository), repo) || existing.target !== config.targetBranch)
    )
      throw new Error('此项目已有 Git 交付记录，请为其他仓库或目标分支新建项目。');
    for (const row of this.db.prepare('SELECT id FROM trees WHERE project=?').all(config.id))
      this.running.get(String(row.id))?.controller.abort();
    this.db
      .prepare(
        'INSERT INTO projects VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository,target=excluded.target,writable=excluded.writable,commands=excluded.commands',
      )
      .run(
        config.id,
        repo,
        config.targetBranch,
        Number(config.writeEnabled),
        JSON.stringify(config.commands),
      );
    this.db
      .prepare(
        "UPDATE approvals SET status='revoked' WHERE status='pending' AND tree IN (SELECT id FROM trees WHERE project=?)",
      )
      .run(config.id);
    return this.project(config.id);
  }
  private project(key: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(key);
    if (!row) throw new Error('项目未配置。');
    return {
      id: key,
      repository: String(row.repository),
      targetBranch: String(row.target),
      writeEnabled: Boolean(row.writable),
      commands: JSON.parse(String(row.commands)),
    };
  }
  private view(row: Row) {
    return {
      id: String(row.id),
      projectId: String(row.project),
      scope: row.scope === null ? null : String(row.scope),
      taskId: row.task === null ? null : String(row.task),
      kind: row.kind as Kind,
      path: join(this.directory, String(row.id)),
      branch: String(row.branch),
      base: String(row.base),
      sha: row.sha === null ? null : String(row.sha),
      status: String(row.status),
      snapshot: JSON.parse(String(row.snapshot)) as Snapshot,
      conflicts: JSON.parse(String(row.conflicts)) as string[],
    };
  }
  private tree(key: string) {
    const row = this.db.prepare('SELECT * FROM trees WHERE id=?').get(key);
    if (!row) throw new Error('工作区未登记。');
    return this.view(row);
  }
  private verified(key: string, write = true) {
    if (this.closing) throw new Error('服务正在关闭。');
    const tree = this.tree(key);
    const project = this.project(tree.projectId);
    if (tree.status === 'removed' || (write && !project.writeEnabled) || this.running.has(key))
      throw new Error('工作区未获写入授权、已清理或正在执行命令。');
    checkLocalConfig(project.repository);
    existingDataDirectory(tree.path);
    const match = gitWorktrees(project.repository).find(
      (w) => w.branch === 'refs/heads/' + tree.branch && sameDirectory(w.path, tree.path),
    );
    if (
      !match ||
      !lstatSync(join(tree.path, '.git')).isFile() ||
      git(tree.path, ['symbolic-ref', 'HEAD']).trimEnd() !== match.branch ||
      !sameDirectory(
        git(tree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trimEnd(),
        git(project.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trimEnd(),
      )
    ) {
      throw new Error('工作区身份或分支已改变。');
    }
    return tree;
  }
  executionTree(projectId: string, taskId: string, treeId: string, scope?: string) {
    const tree = this.verified(treeId);
    if (
      tree.projectId !== projectId ||
      tree.scope !== (scope ?? null) ||
      tree.taskId !== taskId ||
      tree.kind !== 'member' ||
      tree.status !== 'ready'
    )
      throw new Error('工作区与执行任务不匹配。');
    return tree;
  }
  private create(
    project: Project,
    kind: Kind,
    taskId: string | null,
    snapshot: Snapshot,
    scope: string | null,
  ) {
    if (this.closing) throw new Error('服务正在关闭。');
    if (!project.writeEnabled) throw new Error('项目写入尚未授权。');
    checkLocalConfig(project.repository);
    const key = randomUUID();
    const branch = 'concordia/' + kind + '/' + key;
    const path = join(this.directory, key);
    const base = sha.parse(
      git(project.repository, ['rev-parse', '--verify', target(project) + '^{commit}']).trim(),
    );
    if (existsSync(path)) throw new Error('工作区目录已存在。');
    this.db
      .prepare(
        "INSERT INTO trees(id,project,task,kind,branch,base,status,snapshot,scope) VALUES (?,?,?,?,?,?,'creating',?,?)",
      )
      .run(key, project.id, taskId, kind, branch, base, JSON.stringify(snapshot), scope);
    try {
      git(project.repository, ['worktree', 'add', '-b', branch, '--', path, base]);
      this.db
        .prepare('UPDATE trees SET status=?,sha=? WHERE id=?')
        .run(kind === 'member' ? 'ready' : 'integrating', base, key);
    } catch (error) {
      this.db.prepare("UPDATE trees SET status='interrupted' WHERE id=?").run(key);
      throw error;
    }
    return this.verified(key);
  }
  member(projectId: string, taskId: string, scope?: string) {
    id.parse(taskId);
    const existing = this.db
      .prepare("SELECT id FROM trees WHERE project=? AND task=? AND scope IS ? AND status!='removed'")
      .get(projectId, taskId, scope ?? null);
    if (existing) {
      const tree = this.tree(String(existing.id));
      if (tree.status !== 'interrupted' || existsSync(tree.path))
        return this.executionTree(projectId, taskId, tree.id, scope);
      this.remove(tree.id);
    }
    return this.create(this.project(projectId), 'member', taskId, [], scope ?? null);
  }
  read(treeId: string, path: string) {
    const tree = this.verified(treeId, false);
    return worktreeFile(tree.path, path);
  }
  write(treeId: string, path: string, text: string) {
    const tree = this.verified(treeId);
    if (tree.kind !== 'member' || tree.status !== 'ready') throw new Error('只能写入成员自己的工作区。');
    worktreeFile(tree.path, path, text);
  }
  publishForTask(projectId: string, taskId: string, treeId: string, scope?: string) {
    this.executionTree(projectId, taskId, treeId, scope);
    return this.publish(treeId);
  }
  publish(treeId: string) {
    const tree = this.verified(treeId);
    if (tree.kind !== 'member' || tree.status !== 'ready') throw new Error('此工作区不能发布。');
    git(tree.path, ['add', '--all', '--', '.']);
    if (!clean(tree.path)) git(tree.path, ['commit', '-m', 'Concordia task delivery']);
    const commit = head(tree.path);
    git(tree.path, ['merge-base', '--is-ancestor', tree.base, commit]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO publications VALUES (?,?)').run(treeId, commit);
      this.db.prepare('UPDATE trees SET sha=? WHERE id=?').run(commit, treeId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { treeId, taskId: tree.taskId!, sha: commit };
  }
  readPublication(projectId: string, treeId: string, version: string, path: string) {
    sha.parse(version);
    worktreePathParts(path);
    if (
      this.tree(treeId).projectId !== projectId ||
      !this.db.prepare('SELECT 1 FROM publications WHERE tree=? AND sha=?').get(treeId, version)
    )
      throw new Error('未找到项目的已发布交付版本。');
    const repo = this.project(projectId).repository;
    checkLocalConfig(repo);
    const entry = git(repo, ['--literal-pathspecs', 'ls-tree', '-z', version, '--', path]);
    const match = /^(?:100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
    if (!match || Number(git(repo, ['cat-file', '-s', match[1]!]).trim()) > 512 * 1024)
      throw new Error('此版本中没有可读取的普通文本文件。');
    return git(repo, ['cat-file', 'blob', match[1]!]);
  }
  integrate(projectId: string, input: Snapshot) {
    const snapshot = snapshotSchema.parse(input);
    const project = this.project(projectId);
    const scope = this.tree(snapshot[0]!.treeId).scope;
    const tasks = new Set<string>();
    for (const item of snapshot) {
      const member = this.tree(item.treeId);
      if (
        member.projectId !== projectId ||
        member.scope !== scope ||
        member.kind !== 'member' ||
        !member.taskId ||
        tasks.has(member.taskId) ||
        !this.db.prepare('SELECT 1 FROM publications WHERE tree=? AND sha=?').get(item.treeId, item.sha)
      )
        throw new Error('版本快照含未发布、重复或不属于此项目的交付。');
      tasks.add(member.taskId);
    }
    const tree = this.create(project, 'integration', null, snapshot, scope);
    try {
      for (const item of snapshot) {
        if (!gitResult(tree.path, ['merge', '--no-ff', '--no-edit', '--no-overwrite-ignore', item.sha]).code)
          continue;
        const conflicts = git(tree.path, ['diff', '--name-only', '--diff-filter=U', '-z'])
          .split('\0')
          .filter(Boolean);
        if (!conflicts.length) throw new Error('联调合并未完成。');
        git(tree.path, ['merge', '--abort']);
        const taskIds = snapshot
          .slice(0, snapshot.indexOf(item) + 1)
          .filter((v) => {
            const owner = this.tree(v.treeId);
            return git(project.repository, ['diff', '--name-only', '-z', owner.base, v.sha, '--'])
              .split('\0')
              .some((path) => conflicts.includes(path));
          })
          .map((v) => this.tree(v.treeId).taskId!);
        const issue: WorktreeIssue = {
          id: tree.id,
          treeId: tree.id,
          projectId,
          taskIds,
          paths: conflicts,
          status: 'open',
        };
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db
            .prepare("UPDATE trees SET status='conflict',conflicts=? WHERE id=?")
            .run(JSON.stringify(conflicts), tree.id);
          this.db.prepare('INSERT INTO conflict_issues VALUES (?,?)').run(tree.id, JSON.stringify(taskIds));
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
        this.onConflict?.(issue);
        return { tree: this.tree(tree.id), conflicts, ownerTaskId: this.tree(item.treeId).taskId, issue };
      }
      this.db.prepare("UPDATE trees SET sha=?,status='ready' WHERE id=?").run(head(tree.path), tree.id);
      return { tree: this.tree(tree.id), conflicts: [], ownerTaskId: null };
    } catch (error) {
      this.db
        .prepare("UPDATE trees SET status='interrupted' WHERE id=? AND status='integrating'")
        .run(tree.id);
      throw error;
    }
  }
  private commandEvidence(treeId: string, commit: string) {
    const row = this.db
      .prepare(
        "SELECT id,name,status,result FROM approvals WHERE tree=? AND sha=? AND kind='command' AND status IN ('failed','complete','interrupted','running') ORDER BY rowid DESC LIMIT 1",
      )
      .get(treeId, commit);
    if (!row || row.status !== 'complete' || !JSON.parse(String(row.result)).passed)
      throw new Error('当前联调版本需要一条已批准并通过的项目命令记录。');
    return { id: String(row.id), name: String(row.name), result: JSON.parse(String(row.result)) };
  }
  private ticket(treeId: string, kind: 'merge' | 'command', name?: string) {
    const tree = this.verified(treeId);
    const project = this.project(tree.projectId);
    if (tree.status !== 'ready' || !clean(tree.path) || tree.sha !== head(tree.path))
      throw new Error('请先发布并确认工作区的当前版本。');
    const targetSha = sha.parse(git(project.repository, ['rev-parse', '--verify', target(project)]).trim());
    if (kind === 'merge' && (tree.kind !== 'integration' || targetSha !== tree.base))
      throw new Error('需要针对当前目标分支重新联调。');
    const evidence = kind === 'merge' ? this.commandEvidence(treeId, tree.sha) : undefined;
    const declaration = project.commands.find((c) => c.name === name);
    if (kind === 'command' && !declaration) throw new Error('项目未声明此命令。');
    const approvalId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO approvals(id,tree,kind,sha,target,name,command,status) VALUES(?,?,?,?,?,?,?,'pending')",
      )
      .run(
        approvalId,
        treeId,
        kind,
        tree.sha,
        targetSha,
        name ?? evidence?.id ?? null,
        declaration ? JSON.stringify(declaration) : null,
      );
    return this.approval(approvalId);
  }
  private approval(key: string) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=? AND status='pending'").get(key);
    if (!row) throw new Error('审批请求已处理或不存在。');
    const tree = this.tree(String(row.tree));
    const declaration = row.command
      ? (JSON.parse(String(row.command)) as z.infer<typeof command>)
      : undefined;
    return {
      id: key,
      treeId: tree.id,
      kind: String(row.kind),
      sha: String(row.sha),
      targetSha: String(row.target),
      ...(declaration ?? {}),
      ...(row.kind === 'merge'
        ? {
            checkId: String(row.name),
            check: this.db.prepare('SELECT id,name,result FROM approvals WHERE id=?').get(String(row.name)),
            diff: git(this.project(tree.projectId).repository, [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              String(row.target),
              String(row.sha),
              '--',
            ]),
          }
        : {}),
    };
  }
  reviewMerge(treeId: string) {
    return this.ticket(treeId, 'merge');
  }
  requestCommand(treeId: string, name: string) {
    return this.ticket(treeId, 'command', name);
  }
  private consume(key: string, kind: string) {
    const approval = this.approval(key);
    const tree = this.verified(approval.treeId);
    if (
      approval.kind !== kind ||
      tree.status !== 'ready' ||
      !clean(tree.path) ||
      head(tree.path) !== approval.sha
    )
      throw new Error('审批与工作区当前快照不匹配。');
    if (
      this.db.prepare("UPDATE approvals SET status='running' WHERE id=? AND status='pending'").run(key)
        .changes !== 1
    )
      throw new Error('审批已使用。');
    return { tree, approval, project: this.project(tree.projectId) };
  }
  approveMerge(key: string) {
    const { tree, approval, project } = this.consume(key, 'merge');
    const ref = target(project);
    const finish = (merged: boolean, reason?: string) => {
      const result = { merged, reason, branch: tree.branch, sha: approval.sha };
      this.db
        .prepare("UPDATE approvals SET status='complete',result=? WHERE id=?")
        .run(JSON.stringify(result), key);
      return result;
    };
    try {
      if (this.commandEvidence(tree.id, approval.sha).id !== approval.checkId)
        return finish(false, '联调记录已变更，请重新审查。');
      if (git(project.repository, ['rev-parse', '--verify', ref]).trim() !== approval.targetSha)
        return finish(false, '目标分支已更新，请重新联调。');
      git(project.repository, ['merge-base', '--is-ancestor', approval.targetSha, approval.sha]);
      const copies = gitWorktrees(project.repository).filter((w) => w.branch === ref);
      if (copies.length > 1) return finish(false, '目标分支被多个工作副本同时检出，仅交付待合并分支。');
      const checkedOut = copies[0];
      if (checkedOut) {
        checkLocalConfig(checkedOut.path);
        if (
          git(checkedOut.path, ['symbolic-ref', 'HEAD']).trimEnd() !== ref ||
          !sameDirectory(
            git(checkedOut.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trimEnd(),
            git(project.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trimEnd(),
          )
        ) {
          return finish(false, '目标工作副本身份已改变。');
        }
        if (!clean(checkedOut.path)) return finish(false, '目标工作副本有未提交改动，仅交付待合并分支。');
        git(checkedOut.path, ['merge', '--ff-only', '--no-overwrite-ignore', approval.sha]);
      } else git(project.repository, ['update-ref', ref, approval.sha, approval.targetSha]);
      return finish(true);
    } catch (error) {
      this.db.prepare("UPDATE approvals SET status='failed' WHERE id=?").run(key);
      throw error;
    }
  }
  async approveCommand(key: string) {
    const { tree, approval, project } = this.consume(key, 'command');
    const declaration = project.commands.find((c) => c.name === approval.name);
    if (
      !declaration ||
      declaration.executable !== approval.executable ||
      JSON.stringify(declaration.args) !== JSON.stringify(approval.args)
    )
      throw new Error('项目命令声明已改变。');
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.running.set(tree.id, { controller, done });
    const start = performance.now();
    try {
      const output = await runProcess(declaration.executable, declaration.args, {
        cwd: tree.path,
        signal: controller.signal,
        timeoutMs: 60_000,
        recoveryDir: this.recoveryDir,
        executionId: 'command-' + key,
        maxOutputBytes: 256 * 1024,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          LANG: 'C',
        },
      });
      const result = {
        exitCode: output.exitCode,
        passed: output.exitCode === 0,
        elapsedMs: Math.round(performance.now() - start),
      };
      this.db
        .prepare("UPDATE approvals SET status='complete',result=? WHERE id=?")
        .run(JSON.stringify(result), key);
      return result;
    } catch {
      this.db.prepare("UPDATE approvals SET status='failed' WHERE id=?").run(key);
      throw new Error('项目命令启动失败、被取消或超出时间/输出限制。');
    } finally {
      this.running.delete(tree.id);
      finish();
    }
  }
  cancelCommand(treeId: string) {
    this.running.get(treeId)?.controller.abort();
  }
  remove(key: string) {
    const tree = this.tree(key);
    if (tree.status === 'removed') return { branch: tree.branch };
    const repo = this.project(tree.projectId).repository;
    checkLocalConfig(repo);
    if (lstatSync(tree.path, { throwIfNoEntry: false })) {
      this.verified(key, false);
      // Git refuses to remove a dirty tree. Never force-delete a directory.
      git(repo, ['worktree', 'remove', '--', tree.path]);
    } else if (
      gitWorktrees(repo).some(
        (w) =>
          w.branch === 'refs/heads/' + tree.branch ||
          (basename(w.path).toLowerCase() === tree.id && sameDirectory(dirname(w.path), dirname(tree.path))),
      )
    ) {
      throw new Error('登记路径丢失或工作区已移动，请先核对 Git 工作区。');
    }
    // An absent path AND registration also covers a crash after git remove.
    this.db.prepare("UPDATE trees SET status='removed' WHERE id=?").run(key);
    this.db.prepare("UPDATE approvals SET status='revoked' WHERE tree=? AND status='pending'").run(key);
    return { branch: tree.branch };
  }
  issues(): WorktreeIssue[] {
    return this.db
      .prepare('SELECT tree,recipients FROM conflict_issues')
      .all()
      .map((row) => {
        const tree = this.tree(String(row.tree));
        return {
          id: tree.id,
          treeId: tree.id,
          projectId: tree.projectId,
          taskIds: JSON.parse(String(row.recipients)) as string[],
          paths: tree.conflicts,
          status: 'open' as const,
        };
      });
  }
  issueSnapshot(treeId: string): Snapshot {
    const issue = this.db
      .prepare('SELECT t.snapshot FROM trees t JOIN conflict_issues i ON i.tree=t.id WHERE t.id=?')
      .get(treeId);
    return issue ? (JSON.parse(String(issue.snapshot)) as Snapshot) : [];
  }
  state() {
    return {
      projects: this.db
        .prepare('SELECT id FROM projects')
        .all()
        .map((r) => this.project(String(r.id))),
      trees: this.db
        .prepare('SELECT * FROM trees ORDER BY rowid')
        .all()
        .map((r) => this.view(r)),
      issues: this.issues(),
      approvals: this.db
        .prepare("SELECT id,tree,kind,sha,target FROM approvals WHERE status='pending'")
        .all()
        .map((row) => {
          const tree = this.tree(String(row.tree));
          try {
            const repo = this.project(tree.projectId).repository;
            if (!existsSync(join(repo, '.git')) || !existsSync(join(tree.path, '.git'))) throw new Error();
            return { ...this.approval(String(row.id)), available: true };
          } catch {
            return {
              id: String(row.id),
              treeId: tree.id,
              kind: String(row.kind),
              sha: String(row.sha),
              targetSha: String(row.target),
              available: false,
              diagnostic: '项目或工作区暂不可读，请恢复后再审批。',
            };
          }
        }),
      results: this.db
        .prepare(
          "SELECT tree,name,status,result FROM approvals WHERE status!='pending' ORDER BY rowid DESC LIMIT 100",
        )
        .all()
        .map((r) => ({
          treeId: r.tree,
          name: r.name,
          status: r.status,
          result: r.result ? JSON.parse(String(r.result)) : null,
        })),
    };
  }
}

export const openWorktrees = (
  dataDirectory: string,
  onConflict?: (issue: WorktreeIssue) => void,
  recoveryDir?: string,
) => new WorktreeService(dataDirectory, onConflict, recoveryDir);
