import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';

async function gateway() {
  const models: string[] = [];
  const server = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    models.push(JSON.parse(body).model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'CONCORDIA_OK' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, models,
    close: async () => { const end = once(server, 'close'); server.close(); server.closeAllConnections(); await end; } };
}

it('两个窗口编辑既有绑定后，五个真实入口均要求重新核对网关、供应商模型及权限', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'concordia-approval-'));
  const first = await gateway();
  const next = await gateway();
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    const web = join(directory, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<title>route</title>');
    server = await startLocalServer(web, join(directory, 'data'));
    const client = await browserSession(new URL(server.launchUrl));
    const settingsTab = client.openTab();
    const connection = { id: 'g', name: '工作网关', kind: 'chat-completions', stream: false, baseUrl: first.baseUrl };
    const model = { id: 'm', name: '日常模型', modelId: 'upstream-one', connectionId: 'g' };
    const member = { id: 'writer', name: '编辑', role: '写作', connectionId: 'g', modelId: 'm' };
    for (const [path, body] of [['connections', connection], ['models', model], ['members', member]] as const)
      expect((await client.post('/api/' + path, body)).status).toBe(201);
    const spec = { id: 'notes', goal: '写一份提纲', title: '笔记', acceptance: ['可以审阅'], agents: [{ id: 'writer', name: '编辑', connection: 'g' }], tasks: [{ id: 'write', title: '写作', owner: 'writer' }] };
    expect((await client.post('/api/spec/apply', { spec, approved: true, expectedRevision: 0 })).status).toBe(200);
    const cases = [
      ['task&id=write', '/api/tasks/write/run', { mode: 'live', approved: true }],
      ['dispatch', '/api/dispatch', { approved: true, maxCalls: 1 }],
      ['plan&id=writer', '/api/plans/generate', { agentId: 'writer', goal: '提纲', approved: true }],
      ['member-test&id=writer', '/api/members/writer/test', { approved: true }],
      ['connection-test&id=g&modelId=m', '/api/connections/g/test', { approved: true, modelId: 'm' }],
    ] as const;
    const review = async (query: string) => {
      const res = await client.get('/api/approval-route?purpose=' + query);
      expect(res.status).toBe(200);
      return res.json() as Promise<{ stamp: string; revision: number; routes: { destination: string; model: string; permissions: string }[] }>;
    };
    const views = await Promise.all(cases.map(([query]) => review(query)));
    expect(views[0].routes[0]).toMatchObject({ destination: first.baseUrl + '/chat/completions', model: 'upstream-one' });
    // A second legitimate tab edits the same named connection while the first still displays those views.
    expect((await settingsTab.post('/api/connections/g', { ...connection, baseUrl: next.baseUrl }, 'PUT')).status).toBe(200);
    for (const [i, [, path, input]] of cases.entries())
      expect((await client.post(path, input, 'POST', views[i].stamp)).status, path).toBe(409);
    const moved = await review(cases[0][0]);
    expect((await settingsTab.post('/api/models/m', { ...model, modelId: 'upstream-two' }, 'PUT')).status).toBe(200);
    expect((await client.post(cases[0][1], cases[0][2], 'POST', moved.stamp)).status).toBe(409);
    const renamed = await review(cases[0][0]);
    expect((await settingsTab.post('/api/members/writer', { ...member, allowedActions: [] }, 'PUT')).status).toBe(200);
    expect((await client.post(cases[0][1], cases[0][2], 'POST', renamed.stamp)).status).toBe(409);
    const permissions = await review(cases[0][0]);
    expect(permissions.routes[0]).toMatchObject({ destination: next.baseUrl + '/chat/completions', model: 'upstream-two', permissions: '无平台动作' });
    expect((await settingsTab.post('/api/spec/apply', { spec: { ...spec, goal: '更新目标' }, approved: true, expectedRevision: 1 })).status).toBe(200);
    expect((await client.post(cases[0][1], cases[0][2], 'POST', permissions.stamp)).status).toBe(409);
    expect(first.models).toEqual([]);
    expect(next.models).toEqual([]);
    const [query, path, body] = cases[4];
    const approved = await review(query);
    expect((await (await client.post(path, body, 'POST', approved.stamp)).json()).ok).toBe(true);
    expect(first.models).toEqual([]);
    expect(next.models).toEqual(['upstream-two']);
  } finally {
    await server?.close();
    await Promise.all([first.close(), next.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
