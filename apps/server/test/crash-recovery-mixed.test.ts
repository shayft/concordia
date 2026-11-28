import { browserSession } from './browser-session.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { State } from '@concordia/core/workflow';
import { installHoldingCodex, running } from './fixtures/holding-codex.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function isolatedServer(web: string, data: string) {
  const entry = new URL('../src/local-server.ts', import.meta.url).href;
  const script =
    'const [entry,web,data]=process.argv.slice(1);const {startLocalServer}=await import(entry);' +
    'const server=await startLocalServer(web,data);process.send(server.launchUrl);';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, entry, web, data],
    {
      shell: false,
      cwd: repo,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        TMPDIR: tmpdir(),
      },
    },
  );
  const died = once(child, 'exit');
  async function kill() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await died;
  }
  cleanup.push(kill);
  const link = await Promise.race([
    once(child, 'message').then(([url]) => new URL(String(url))),
    died.then(() => Promise.reject(new Error('临时服务提前退出'))),
  ]);
  const client = await browserSession(link);
  return {
    kill,
    async post(path: string, body: unknown) {
      const res = await client.post(path, body);
      expect(res.ok, path + ' HTTP ' + res.status).toBe(true);
      return res.json();
    },
    async get(path: string) {
      const res = await client.get(path);
      expect(res.status).toBe(200);
      return res.json();
    },
    async board() {
      return this.get('/api/board') as Promise<State>;
    },
  };
}
it('强杀混合团队的服务后，重新启动回收同一 CLI 执行的三代进程，两个中断任务均等待用户决定', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'concordia-real-crash-'));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const web = join(scratch, 'web'),
    data = join(scratch, 'data');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>Concordia</title>');
  const executable = await installHoldingCodex(scratch, 'agent');
  let requests = 0;
  const gateway = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': pending\n\n');
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  cleanup.push(async () => {
    const done = once(gateway, 'close');
    gateway.close();
    gateway.closeAllConnections();
    await done;
  });
  const addr = gateway.address();
  if (!addr || typeof addr === 'string') throw new Error('本机网关未启动');
  const original = await isolatedServer(web, data);
  await original.post('/api/connections', {
    id: 'author-cli',
    name: '受控假 Codex',
    kind: 'codex',
    executable,
    cwd: scratch,
  });
  await original.post('/api/connections', {
    id: 'review-api',
    name: '本机审查模型',
    kind: 'chat-completions',
    baseUrl: 'http://127.0.0.1:' + addr.port + '/v1',
  });
  await original.post('/api/models', {
    id: 'review',
    name: '审查',
    connectionId: 'review-api',
    modelId: 'local-review',
    toolMode: 'json',
  });
  await original.post('/api/members', {
    id: 'author',
    name: '作者',
    role: '发布契约',
    connectionId: 'author-cli',
  });
  await original.post('/api/members', {
    id: 'reviewer',
    name: '审查者',
    role: '审查契约',
    connectionId: 'review-api',
    modelId: 'review',
  });
  await original.post('/api/spec/apply', {
    approved: true,
    expectedRevision: 0,
    spec: {
      id: 'interruption',
      title: '验收服务崩溃与恢复',
      goal: '在两个成员仍执行时关闭宿主',
      acceptance: ['中断版本可追查'],
      agents: [
        { id: 'author', name: '作者', connection: 'author-cli', role: 'lead' },
        { id: 'reviewer', name: '审查者', connection: 'review-api' },
      ],
      slots: [
        { id: 'contract', title: '约定' },
        { id: 'review', title: '审查' },
      ],
      requiredSlots: ['contract', 'review'],
      tasks: [
        { id: 'write', title: '交约定', owner: 'author', produces: ['contract'] },
        {
          id: 'check',
          title: '审查约定',
          owner: 'reviewer',
          consumes: [{ slotId: 'contract' }],
          produces: ['review'],
        },
      ],
    },
  });
  const diagnostic = await original.post('/api/members/author/inspect', {});
  const author = await original.post('/api/tasks/write/run', {
    approved: true,
    mode: 'live',
    inspectionId: diagnostic.inspectionId,
  });
  await original.post('/api/dispatch', { approved: true, maxCalls: 1 });
  let pids: number[] = [];
  await vi.waitFor(
    async () => {
      expect(requests).toBe(1);
      pids = await Promise.all(
        [0, 1, 2].map(async (n) => Number(await readFile(join(scratch, 'pid-' + n), 'utf8'))),
      );
      expect(new Set(pids).size).toBe(3);
      expect(pids.every((pid) => pid > 1 && running(pid))).toBe(true);
    },
    { timeout: 70_000, interval: 100 },
  );
  const before = await original.board();
  const review = before.executions.find((e) => e.taskId === 'check')!;
  expect(before.executions.filter((e) => e.status === 'running')).toHaveLength(2);
  expect(before.versions).toHaveLength(1);
  expect(before.versions[0].executionId).toBe(author.executionId);
  expect(review.inputs.contract).toBe(before.versions[0].id);
  const registry = join(data, 'processes');
  const records = await Promise.all(
    (await readdir(registry))
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => JSON.parse(await readFile(join(registry, n), 'utf8'))),
  );
  expect(records).toContainEqual(
    expect.objectContaining({ executionId: author.executionId, pid: expect.any(Number) }),
  );

  await original.kill();
  const restored = await isolatedServer(web, data);
  expect(await restored.get('/api/recovery')).toEqual({ recovered: [author.executionId], unresolved: [] });
  expect((await readdir(registry)).filter((n) => n.endsWith('.json'))).toEqual([]);
  await vi.waitFor(() => expect(pids.some(running)).toBe(false), { timeout: 8000 });
  const after = await restored.board();
  expect(after.executions.map((e) => e.id).sort()).toEqual([author.executionId, review.id].sort());
  expect(after.executions.every((e) => e.status === 'interrupted')).toBe(true);
  expect(after.tasks.every((t) => t.status === 'decision')).toBe(true);
  expect(after.versions.map((v) => v.id)).toEqual([before.versions[0].id]);
  expect(after.acceptance).toBeNull();
  expect(requests).toBe(1);
}, 150_000);
