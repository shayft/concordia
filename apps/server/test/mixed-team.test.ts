import { browserSession } from './browser-session.ts';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { expect, it, vi } from 'vitest';
import type { Scheduler } from '@concordia/core/workflow';
import { startLocalServer } from '../src/local-server.ts';

// The service configures the real Node executable on each OS. Only its argv
// prefix is substituted to launch the same fake CLI through the real supervisor.
let launcher: string;
vi.mock('../../../packages/runtimes/src/process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../packages/runtimes/src/process.ts')>();
  return {
    ...actual,
    runProcess: (path: string, args: string[], options: Parameters<typeof actual.runProcess>[2]) => {
      if (path !== process.execPath) throw new Error('混合回归只允许启动假 CLI');
      return actual.runProcess(path, [launcher, 'codex', ...args], options);
    },
  };
});

it('已批准的批次在 CLI 的 MCP 发布事件后立即唤醒 API 审查卡，并验收同一版本快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'concordia-mixed-'));
  const requests: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mockApi = createServer(async (req, res) => {
    if (req.url === '/hold-cli') {
      await held;
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    requests.push(await text(req));
    const actions = [
      { type: 'publish_artifact', slotId: 'verdict', content: '已审阅接口约定' },
      { type: 'request_review', taskId: 'review' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = {
      choices: [{ index: 0, delta: { content: JSON.stringify({ actions }) }, finish_reason: 'stop' }],
    };
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    await once(mockApi, 'listening');
    const addr = mockApi.address();
    if (!addr || typeof addr === 'string') throw new Error('测试端口未绑定');
    const origin = 'http://127.0.0.1:' + addr.port;
    launcher = join(root, 'fixture.mjs');
    const fixture = new URL('../../../packages/runtimes/test/fixtures/agent-cli.mjs', import.meta.url).href;
    await writeFile(
      launcher,
      [
        'await import(' + JSON.stringify(fixture) + ');',
        'const args=process.argv.slice(3);',
        'if(args.includes("exec") && !args.includes("--help")) await fetch(' +
          JSON.stringify(origin + '/hold-cli') +
          ',{signal:AbortSignal.timeout(30000)});',
      ].join('\n'),
    );
    const web = join(root, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<title>mixed team</title>');
    app = await startLocalServer(web, join(root, 'data'));
    const launch = new URL(app.launchUrl);
    const client = await browserSession(launch);
    const post = async (path: string, body: unknown) => {
      const result = await client.post(path, body);
      expect(result.ok, path + ' HTTP ' + result.status).toBe(true);
      return result.json();
    };
    const board = async () =>
      (await client.get('/api/board')).json() as Promise<ReturnType<Scheduler['board']>>;
    await post('/api/connections', {
      id: 'cli',
      name: '脚本化 Codex',
      kind: 'codex',
      executable: process.execPath,
      cwd: root,
    });
    await post('/api/connections', {
      id: 'api',
      name: '回环 HTTP API',
      kind: 'chat-completions',
      baseUrl: origin + '/v1',
    });
    await post('/api/models', {
      id: 'reviewer-model',
      connectionId: 'api',
      name: '审查模型',
      modelId: 'local-test',
      toolMode: 'json',
    });
    const marker = '来自脚本化前端接口成员的合同';
    await post('/api/members', {
      id: 'author',
      name: '接口成员',
      role: '交付接口',
      connectionId: 'cli',
      systemPrompt: marker,
      allowedActions: ['publish_artifact', 'submit_result'],
    });
    await post('/api/members', {
      id: 'reviewer',
      name: '审查成员',
      role: '审查接口版本',
      connectionId: 'api',
      modelId: 'reviewer-model',
    });
    await post('/api/spec/apply', {
      expectedRevision: 0,
      approved: true,
      spec: {
        id: 'mixed-delivery',
        title: '混合协作验收',
        goal: '让审查成员在作者尚未结束时读取契约',
        acceptance: ['审查绑定契约版本'],
        agents: [
          { id: 'author', name: '接口成员', connection: 'cli' },
          { id: 'reviewer', name: '审查成员', connection: 'api', role: 'lead' },
        ],
        slots: [
          { id: 'contract', title: '接口契约' },
          { id: 'verdict', title: '审查结果' },
        ],
        tasks: [
          { id: 'write', title: '提交接口契约', owner: 'author', produces: ['contract'] },
          {
            id: 'review',
            title: '审查新版本',
            owner: 'reviewer',
            consumes: [{ slotId: 'contract' }],
            produces: ['verdict'],
          },
        ],
        requiredSlots: ['contract', 'verdict'],
      },
    });
    const before = await board();
    expect(before.tasks.find((t) => t.id === 'review')?.status).toBe('waiting');
    const repository = join(root, 'fixture-repo');
    await mkdir(repository);
    execFileSync('git', ['init', '-b', 'main', repository], {stdio:'pipe'});
    execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c','commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base'], {stdio:'pipe'});
    await post('/api/worktrees/projects', { id:'project', repository, targetBranch:'main', writeEnabled:true, commands:[] });
    const tree = await post('/api/worktrees/member', { projectId:'project', taskId:'write' });
    await writeFile(join(tree.path, 'fixture-project-servers.json'), JSON.stringify(['tree_only']));
    const target = { projectId:'project', treeId:tree.id };
    const inspection = await post('/api/tasks/write/inspect', target);
    expect(inspection).toMatchObject({ cwd:tree.path, executionAccess:'只读任务', selectedChannel:'mcp' });
    expect(inspection.disabledMcpServers).toEqual(['tree_only']);
    const launched = await post('/api/tasks/write/run', {
      mode: 'live',
      approved: true,
      inspectionId: inspection.inspectionId, ...target,
    });
    await post('/api/dispatch', { maxCalls: 1, approved: true });
    await vi.waitFor(
      async () => expect((await board()).tasks.find((t) => t.id === 'review')?.status).toBe('review'),
      { timeout: 70_000, interval: 80 },
    );
    const midway = await board();
    expect(midway.executions.find((e) => e.id === launched.executionId)?.status).toBe('running');
    const contract = midway.versions.find((v) => v.slotId === 'contract')!;
    const verdict = midway.versions.find((v) => v.slotId === 'verdict')!;
    expect(contract.executionId).toBe(launched.executionId);
    expect(verdict.basedOn).toEqual({ contract: contract.id });
    expect(midway.executions.find((e) => e.id === verdict.executionId)).toMatchObject({
      owner: 'reviewer',
      connection: 'api',
      status: 'success',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(marker);
    release();
    await vi.waitFor(
      async () => expect((await board()).tasks.find((t) => t.id === 'write')?.status).toBe('review'),
      { timeout: 10_000 },
    );
    for (const id of ['write', 'review']) {
      const card = (await board()).tasks.find(t => t.id === id)!;
      await post('/api/tasks/' + id + '/control', { action: 'accept', expectedExecutionId: card.reviewExecutionId });
    }
    expect(await post('/api/accept', { expected: (await board()).acceptanceCandidate })).toEqual({
      snapshot: { contract: contract.id, verdict: verdict.id },
    });
  } finally {
    release();
    await app?.close();
    const closed = once(mockApi, 'close');
    mockApi.close();
    mockApi.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
