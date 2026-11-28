import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PlanningRequest } from '@concordia/protocol/planning';
import { PlanningRequests } from '../src/planning-requests.ts';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';
import { installHoldingCodex, running } from './fixtures/holding-codex.ts';

const spec = (id: string) => ({ id: 'notes', title: '写作', goal: '公开提纲', acceptance: ['可审阅'],
  agents: [{ id, name: id, connection: 'office' }], tasks: [{ id: 'write', owner: id, title: '编写' }] });
function frame(res: ServerResponse, content: string, done = false) {
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: done ? 'stop' : null }] }) + '\n\n');
  if (done) res.end('data: [DONE]\n\n');
}
const path = '/api/workspaces/default/plan-requests';
const req = (agentId: string, members = [agentId]) => ({ goal: '公开目标', agentId, members, approved: true, background: true, requestKey: randomUUID() });
let directory: string;
let web: string;
let app: Awaited<ReturnType<typeof startLocalServer>>;
let ui: Awaited<ReturnType<typeof browserSession>>;
let gateway: ReturnType<typeof createServer>;
let sent: { res: ServerResponse; prompt: { members: unknown[] }; body: string }[];
async function reopen() {
  app = await startLocalServer(web, join(directory, 'data'));
  ui = await browserSession(new URL(app.launchUrl));
}
async function list(): Promise<PlanningRequest[]> {
  const response = await ui.get(path);
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'concordia-planning-'));
  web = join(directory, 'web'); await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>planning</title>');
  sent = [];
  gateway = createServer(async (request, res) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const prompt = JSON.parse(JSON.parse(body).messages.at(-1).content);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    sent.push({ res, prompt, body });
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const addr = gateway.address();
  if (!addr || typeof addr === 'string') throw new Error('本地测试网关没有端口');
  await reopen();
  expect((await ui.post('/api/connections', { id: 'office', name: '模拟网关', kind: 'chat-completions',
    baseUrl: 'http://127.0.0.1:' + addr.port, maxConcurrent: 3 })).status).toBe(201);
  expect((await ui.post('/api/models', { id: 'model', connectionId: 'office', modelId: 'test', name: '模拟', toolMode: 'json' })).status).toBe(201);
  for (const id of ['lead','editor','elsewhere']) expect((await ui.post('/api/members', {
    id, name: id, role: id === 'elsewhere' ? 'OTHER_WORKSPACE_PUBLIC_MARKER' : id,
    modelId: 'model', connectionId: 'office',
  })).status).toBe(201);
});
afterEach(async () => {
  await app?.close();
  const closed = once(gateway, 'close'); gateway.close(); gateway.closeAllConnections(); await closed;
  await rm(directory, { recursive: true, force: true });
});

it('批准的名单与实际发给负责人的字段一致，未选岗位不能进入生成草案', async () => {
  const input = req('lead', ['editor','lead']);
  const route = '/api/approval-route?purpose=plan&id=lead&roster=editor,lead';
  const preview = await (await ui.get(route)).json();
  expect(preview.roster).toEqual(['editor','lead'].map(id => ({ id, name: id, role: id, connection: 'office' })));
  expect((await ui.post('/api/members/editor', { id: 'editor', name: 'editor', role: '复审',
    modelId: 'model', connectionId: 'office' }, 'PUT')).status).toBe(200);
  expect((await ui.post('/api/plans/generate', input, 'POST', preview.stamp)).status).toBe(409);
  expect((await ui.post('/api/plans/generate', { ...input, members: [] })).ok).toBe(false);
  expect(sent).toHaveLength(0);
  const approved = await (await ui.get(route)).json();
  const job = await (await ui.post('/api/plans/generate', input, 'POST', approved.stamp)).json() as PlanningRequest;
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].prompt.members).toEqual(approved.roster);
  expect(sent[0].body).not.toContain('OTHER_WORKSPACE_PUBLIC_MARKER');
  frame(sent[0].res, JSON.stringify(spec('elsewhere')), true);
  await vi.waitFor(async () => expect((await list())[0]).toMatchObject({ id: job.id, status: 'failed', hasResult: false }));
  expect((await ui.get(path + '/' + job.id + '/result')).status).toBe(409);
  expect((await (await ui.get('/api/board')).json()).spec).toBeNull();
  expect(sent).toHaveLength(1);
});

it('空工作区可恢复单项规划视图；重复提交、取消和页面重开不重新发起模型请求', async () => {
  const first = req('lead');
  const second = req('editor');
  const one = await (await ui.post('/api/plans/generate', first)).json() as PlanningRequest;
  const duplicate = await (await ui.post('/api/plans/generate', first)).json() as PlanningRequest;
  expect(duplicate.id).toBe(one.id);
  const two = await (await ui.post('/api/plans/generate', second)).json() as PlanningRequest;
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  const a = sent.find(item => JSON.stringify(item.prompt.members).includes('"lead"'))!;
  const b = sent.find(item => item !== a)!;
  frame(a.res, '{');
  frame(b.res, '{');
  await vi.waitFor(async () => expect((await list()).filter(row => row.phase === 'receiving')).toHaveLength(2));
  expect((await (await ui.openTab().get(path)).json()).map((row: PlanningRequest) => row.id)).toContain(two.id);
  const cancel = path + '/' + one.id + '/cancel';
  expect((await (await ui.post(cancel, {})).json()).status).toBe('cancelled');
  expect((await (await ui.post(cancel, {})).json()).status).toBe('cancelled');
  expect((await list()).find(row => row.id === two.id)?.status).toBe('running');
  expect((await ui.get(path + '/' + one.id + '/result')).status).toBe(409);
  frame(b.res, JSON.stringify(spec('editor')).slice(1), true);
  await vi.waitFor(async () => expect((await list()).find(row => row.id === two.id)?.status).toBe('proposed'));
  const result = await (await ui.get(path + '/' + two.id + '/result')).json();
  expect(result.spec.agents[0].id).toBe('editor');
  expect((await (await ui.get('/api/board')).json()).spec).toBeNull();
  await app.close(); await reopen();
  expect((await (await ui.get(path + '/' + two.id + '/result')).json()).spec.id).toBe(result.spec.id);
  expect((await list()).find(row => row.id === one.id)?.status).toBe('cancelled');
  const next = await (await ui.post('/api/workspaces', { name: '另一工作区' })).json();
  expect((await ui.get(path)).status).toBe(409);
  expect((await ui.get('/api/workspaces/' + next.active + '/plan-requests/' + two.id + '/result')).status).toBe(409);
  expect(sent).toHaveLength(2);
});

it('停服中断的规划在原工作区保留统计并等待用户决定', async () => {
  const input = req('lead');
  const job = await (await ui.post('/api/plans/generate', input)).json() as PlanningRequest;
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  frame(sent[0].res, '{');
  await vi.waitFor(async () => expect((await list())[0].progressBytes).toBe(1));
  await app.close(); await reopen();
  expect((await list())[0]).toMatchObject({ id: job.id, status: 'interrupted', progressBytes: 1, hasResult: false });
  expect((await (await ui.post('/api/plans/generate', input)).json()).id).toBe(job.id);
  expect(sent).toHaveLength(1);
});

it('取消规划只停止其命名请求，正在运行的普通任务仍可提交结果', async () => {
  expect((await ui.post('/api/spec/apply', { spec: spec('editor'), approved: true, expectedRevision: 0 })).status).toBe(200);
  const run = await ui.post('/api/tasks/write/run', { mode: 'live', approved: true });
  expect(run.ok).toBe(true);
  const task = await run.json();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const plan = await (await ui.post('/api/plans/generate', req('lead'))).json() as PlanningRequest;
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect((await (await ui.post(path + '/' + plan.id + '/cancel', {})).json()).status).toBe('cancelled');
  const board = () => ui.get('/api/board').then(res => res.json());
  expect((await board()).executions[0]).toMatchObject({ id: task.executionId, status: 'running' });
  frame(sent[0].res, JSON.stringify({ type: 'submit_result', summary: '普通任务按原计划完成' }), true);
  await vi.waitFor(async () => expect((await board()).executions[0].status).toBe('success'));
  expect(sent).toHaveLength(2);
});

it('后台状态写入失败时保留现场，恢复可写后标记中断且不会再次调用模型', async () => {
  const job = await (await ui.post('/api/plans/generate', req('lead'))).json() as PlanningRequest;
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const finish = vi.spyOn(PlanningRequests.prototype, 'finish').mockImplementation(() => { throw new Error('模拟存储暂不可写'); });
  try {
    frame(sent[0].res, JSON.stringify(spec('lead')), true);
    await vi.waitFor(() => expect(finish.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect((await ui.get(path)).status).toBe(409);
    expect((await ui.post('/api/workspaces', { name: '另一个工作区' })).status).toBe(409);
  } finally { finish.mockRestore(); }
  expect((await ui.post('/api/workspaces', { name: '另一个工作区' })).ok).toBe(true);
  expect((await ui.post('/api/workspaces/default/select', {})).ok).toBe(true);
  expect((await list())[0]).toMatchObject({ id: job.id, status: 'interrupted', hasResult: false });
  expect(sent).toHaveLength(1);
});

it('单项取消等到假 CLI 规划的进程及两代后代停止，再返回终态', async () => {
  const fixtureDir = join(directory, 'holding-cli');
  await mkdir(fixtureDir);
  const executable = await installHoldingCodex(fixtureDir, 'planner');
  expect((await ui.post('/api/connections', { id: 'local', name: '假命令行', kind: 'codex', executable, cwd: fixtureDir })).ok).toBe(true);
  expect((await ui.post('/api/members', { id: 'planner', name: '负责人', role: '整理提纲', connectionId: 'local' })).ok).toBe(true);
  const inspection = await ui.post('/api/plans/inspect', { agentId: 'planner' });
  expect(inspection.ok).toBe(true);
  const { inspectionId } = await inspection.json();
  const start = await ui.post('/api/plans/generate', { ...req('planner', ['editor']), inspectionId });
  expect(start.ok).toBe(true);
  const job = await start.json() as PlanningRequest;

  let pids: number[] = [];
  await vi.waitFor(async () => {
    pids = await Promise.all([0, 1, 2].map(async n => Number(await readFile(join(fixtureDir, 'pid-' + n), 'utf8'))));
    expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 0 && running(pid))).toBe(true);
  }, { timeout: 30_000 });
  const cancel = await ui.post(path + '/' + job.id + '/cancel', {});
  expect(cancel.ok).toBe(true);
  expect(await cancel.json()).toMatchObject({ id: job.id, status: 'cancelled' });
  expect(pids.map(running)).toEqual([false, false, false]);
  expect((await list())[0]).toMatchObject({ status: 'cancelled', hasResult: false });
  expect(sent).toHaveLength(0);
}, 90_000);
