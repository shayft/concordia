import { browserSession } from './browser-session.ts';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { State, WorkflowEvent } from '@concordia/core/state';
import { git } from '../src/worktrees/git.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/restore-service.mjs', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const backup = fileURLToPath(new URL('../src/backup.ts', import.meta.url));

function environment(scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    ProgramFiles: process.env.ProgramFiles,
    ComSpec: process.env.ComSpec,
    WINDIR: process.env.WINDIR,
    HOME: scratch,
    USERPROFILE: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  };
}

async function launch(web: string, data: string, scratch: string) {
  const child = fork(fixture, [web, data], {
    execArgv: ['--import', 'tsx'],
    cwd: root,
    env: environment(scratch),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    const payload = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(20_000) }).then(
        ([value]) => value as { launchUrl: string },
      ),
      exited.then(() => {
        throw new Error('测试服务在完成启动前退出。');
      }),
    ]);
    const url = new URL(payload.launchUrl);
    async function close() {
      if (!child.connected) {
        await exited;
        return;
      }
      child.send('stop');
      // Closing a failed fixture must never leave a test-owned server running.
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        const [code] = await exited;
        if (code !== 0) throw new Error('测试服务未正常停服。');
      } finally {
        clearTimeout(timeout);
      }
    }
    return { url, close };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }
}

async function session(url: URL) {
  const client = await browserSession(url);
  const request = (path: string, body?: unknown) => body === undefined ? client.get(path) : client.post(path, body);
  async function json<T>(path: string, body?: unknown): Promise<T> {
    const response = await request(path, body);
    if (!response.ok) throw new Error(`测试请求 ${path} 返回 ${response.status}。`);
    return (await response.json()) as T;
  }
  return { cookie: client.cookie, request, json };
}

function schemaVersions(path: string, workspaceId: string) {
  return [
    'catalog.sqlite',
    'worktrees.sqlite',
    'boards/default/workspace.sqlite',
    'boards/' + workspaceId + '/workspace.sqlite',
  ].map((relative) => {
    const db = new DatabaseSync(join(path, relative), { readOnly: true });
    try {
      return Number(db.prepare('PRAGMA user_version').get()?.user_version);
    } finally {
      db.close();
    }
  });
}

it(
  '正式服务停服、CLI 备份和异地恢复后，新进程保留两块看板、验收版本及历史，并拒绝旧会话与错位工作树',
  { timeout: 90_000 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'concordia restore lifecycle '));
    const web = join(scratch, 'web');
    const source = join(scratch, 'original data');
    const snapshot = join(scratch, 'offline backup');
    const restored = join(scratch, 'different restored path');
    const retired = join(scratch, 'retired original data');
    let service: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      await mkdir(join(web, 'assets'), { recursive: true });
      await writeFile(join(web, 'index.html'), '<!doctype html><title>Concordia</title>');
      const repo = join(scratch, 'outside managed data');
      await mkdir(repo);
      git(repo, ['init', '-b', 'main', '--template=']);
      await writeFile(join(repo, 'base.txt'), '原始内容');
      git(repo, ['add', '--', 'base.txt']);
      git(repo, ['commit', '-m', 'fixture baseline']);
      const target = git(repo, ['rev-parse', 'HEAD']).trimEnd();
      service = await launch(web, source, scratch);
      const before = await session(service.url);
      const { active } = await before.json<{ active: string }>('/api/workspaces', { name: '备份演练工作区' });
      await before.json('/api/demo/run', {});
      const board = await before.json<State>('/api/board');
      expect(board.acceptance?.integration).toBeTruthy();
      const version = board.acceptance!.integration;
      const artifact = await before.json<{ content: string }>('/api/versions/' + version);
      expect(artifact.content).toContain('模拟');
      const events = await before.json<WorkflowEvent[]>('/api/history');
      expect(events.at(-1)?.type).toBe('plan.accepted');
      await before.json('/api/worktrees/projects', {
        id: 'project',
        repository: repo,
        targetBranch: 'main',
        writeEnabled: true,
        commands: [],
      });
      const tree = await before.json<{ id: string; path: string; branch: string }>('/api/worktrees/member', {
        projectId: 'project',
        taskId: 'api',
      });
      await writeFile(join(tree.path, 'uncommitted.txt'), '未提交的草稿');
      await service.close();
      service = undefined;

      const sourceVersions = schemaVersions(source, active);
      expect(sourceVersions.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
      // Invoke tsx's actual CLI executable with the arguments from the operations guide.
      const execute = promisify(execFile);
      const steps = [
        ['create', source, snapshot],
        ['restore', snapshot, restored],
      ] as const;
      for (const [mode, from, to] of steps) {
        const { stdout } = await execute(process.execPath, [tsx, backup, mode, from, to], {
          cwd: root,
          env: environment(scratch),
          timeout: 30_000,
          shell: false,
        });
        expect(stdout.trim()).toBe('数据复制和校验已完成。');
      }
      expect(schemaVersions(restored, active)).toEqual(sourceVersions);
      // Remove the old absolute location from view. Successful reads must come from
      // the restored service's databases and content objects.
      await rename(source, retired);
      service = await launch(web, restored, scratch);
      expect(
        (await fetch(service.url.origin + '/api/board', { headers: { cookie: before.cookie } })).status,
      ).toBe(401);
      const after = await session(service.url);
      expect(await after.json('/api/workspaces')).toMatchObject({ active });
      const current = await after.json<State>('/api/board');
      expect(current.acceptance).toEqual(board.acceptance);
      expect(current.versions).toEqual(board.versions);
      expect(current.executions.map((e) => [e.id, e.status])).toEqual(
        board.executions.map((e) => [e.id, e.status]),
      );
      expect(await after.json('/api/history')).toEqual(events);
      expect(await after.json('/api/versions/' + version)).toEqual(artifact);
      await after.json('/api/workspaces/default/select', {});
      expect((await after.json<State>('/api/board')).spec).toBeNull();
      await after.json('/api/workspaces/' + active + '/select', {});
      expect((await after.json<State>('/api/board')).acceptance).toEqual(board.acceptance);

      // Git worktree metadata in the separate repository still names the old
      // data directory. A restored copy is readable but cannot publish as that tree.
      expect(await readFile(join(restored, 'worktrees', tree.id, 'uncommitted.txt'), 'utf8')).toBe(
        '未提交的草稿',
      );
      expect((await after.request('/api/worktrees/publish', { treeId: tree.id })).status).toBe(409);
      expect(git(repo, ['rev-parse', 'HEAD']).trimEnd()).toBe(target);
      expect(git(repo, ['rev-parse', tree.branch]).trimEnd()).toBe(target);
      expect(await readFile(join(retired, 'worktrees', tree.id, 'uncommitted.txt'), 'utf8')).toBe(
        '未提交的草稿',
      );
    } finally {
      try {
        await service?.close();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  },
);
