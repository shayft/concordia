import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startLocalServer } from '../src/local-server.ts';
import { git } from '../src/worktrees/git.ts';
import { browserSession } from './browser-session.ts';

let launcher: string, fixtureHome: string;
vi.mock('../../../packages/runtimes/src/process.ts', async (original) => {
  const actual = await original<typeof import('../../../packages/runtimes/src/process.ts')>();
  return {
    ...actual,
    runProcess: (path: string, args: string[], options: Parameters<typeof actual.runProcess>[2]) => {
      if (path !== process.execPath) throw new Error('回归只允许启动假 CLI。');
      return actual.runProcess(path, [launcher, 'codex', ...args], {
        ...options,
        env: { ...options?.env, HOME: fixtureHome, USERPROFILE: fixtureHome },
      });
    },
  };
});

it('撤回项目写入等待原生写进程退出，同期另一项目仍可写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'concordia revoke '));
  let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    fixtureHome = join(root, 'fake-home');
    await mkdir(fixtureHome);
    const web = join(root, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<title>撤权回归</title>');
    launcher = join(root, 'writer.mjs');
    const standard = new URL('../../../packages/runtimes/test/fixtures/agent-cli.mjs', import.meta.url).href;
    await writeFile(
      launcher,
      [
        "import {existsSync,writeFileSync} from 'node:fs';",
        'const args=process.argv.slice(3);',
        "if (args.includes('exec') && !args.includes('--help')) {",
        "  if (!args.includes('workspace-write')) process.exit(15);",
        "  writeFileSync('writer.pid',String(process.pid));",
        "  setInterval(()=>{if(existsSync('continue-check')) writeFileSync('continued','yes')},25);",
        '} else await import(' + JSON.stringify(standard) + ');',
      ].join('\n'),
    );
    app = await startLocalServer(web, join(root, 'data'));
    const ui = await browserSession(new URL(app.launchUrl));
    async function post<T>(path: string, body: unknown) {
      const response = await ui.post('/api/' + path, body);
      if (!response.ok) throw new Error('测试请求 ' + path + ' 返回 ' + response.status);
      return (await response.json()) as T;
    }
    const projects = ['one', 'two'] as const;
    const trees = new Map<string, { id: string; path: string }>();
    for (const id of projects) {
      const repo = join(root, id);
      await mkdir(repo);
      git(repo, ['init', '-b', 'main', '--template=']);
      git(repo, ['commit', '--allow-empty', '-m', 'base']);
      await post('connections', { id, name: id, kind: 'codex', enabled: true, executable: process.execPath });
      await post('members', { id, name: id, role: '测试', connectionId: id });
      await post('worktrees/projects', {
        id,
        repository: repo,
        targetBranch: 'main',
        writeEnabled: true,
        commands: [],
      });
    }
    await post('spec/apply', {
      expectedRevision: 0,
      approved: true,
      spec: {
        id: 'plan',
        goal: '撤回一个项目的写入',
        title: '撤权',
        acceptance: ['两项目独立'],
        agents: projects.map((id) => ({ id, name: id, role: 'member', connection: id })),
        slots: [{ id: 'output', title: '产出' }],
        tasks: projects.map((id, i) => ({ id, title: id, owner: id, produces: i === 0 ? ['output'] : [] })),
        requiredSlots: ['output'],
      },
    });
    for (const id of projects) {
      const tree = await post<{ id: string; path: string }>('worktrees/member', {
        projectId: id,
        taskId: id,
      });
      trees.set(id, tree);
      const opts = { treeId: tree.id, projectId: id };
      const { inspectionId } = await post<{ inspectionId: string }>('tasks/' + id + '/inspect', opts);
      await post('tasks/' + id + '/run', { mode: 'live', approved: true, inspectionId, ...opts });
    }
    await vi.waitFor(
      () => expect(projects.every((id) => existsSync(join(trees.get(id)!.path, 'writer.pid')))).toBe(true),
      { timeout: 20_000, interval: 50 },
    );
    const first = trees.get('one')!.path,
      second = trees.get('two')!.path;
    const pid = Number(await readFile(join(first, 'writer.pid'), 'utf8'));
    await post('worktrees/projects', {
      id: 'one',
      repository: join(root, 'one'),
      targetBranch: 'main',
      writeEnabled: false,
      commands: [],
    });
    expect(() => process.kill(pid, 0)).toThrow();
    for (const path of [first, second]) await writeFile(join(path, 'continue-check'), '');
    await vi.waitFor(() => expect(existsSync(join(second, 'continued'))).toBe(true));
    expect(existsSync(join(first, 'continued'))).toBe(false);
    const board = (await (await ui.get('/api/board')).json()) as { tasks: { id: string; status: string }[] };
    expect(board.tasks).toContainEqual(expect.objectContaining({ id: 'one', status: 'cancelled' }));
    expect(board.tasks).toContainEqual(expect.objectContaining({ id: 'two', status: 'running' }));
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  }
}, 90_000);
