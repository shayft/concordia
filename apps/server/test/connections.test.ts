import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '@concordia/store';
import { cancelCatalogProbes, getCatalog, providerConfig, probeCount, registerConnectionRoutes, resolveMember, type RunningFilter } from '../src/connections.ts';

let dir: string, app: FastifyInstance, db: DatabaseSync;
let busy: RunningFilter | undefined;
let recovered: boolean;
const gateway = { id: 'gateway', name: '网关', kind: 'chat-completions', baseUrl: 'https://one.invalid/v1' };
const cli = { id: 'local', name: '原生 CLI', kind: 'codex' };
const model = { id: 'custom', name: '自定义模型', connectionId: gateway.id, modelId: 'third-party/甲:v2' };
const member = { id: 'test', name: '测试', role: 'qa', connectionId: gateway.id, modelId: model.id };
const pool = { id: 'shared', name: '共享额度', maxConcurrent: 2 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'concordia-catalog-'));
  db = openStore(join(dir, 'application.sqlite'));
  app = Fastify();
  busy = undefined;
  recovered = true;
  registerConnectionRoutes(app, db, { assertCanExecute: () => { if (!recovered) throw new Error('待核对'); }, isRunning: filter => busy !== undefined && Object.entries(filter).every(
    ([key, value]) => busy?.[key as keyof RunningFilter] === value,
  ) });
});
afterEach(async () => { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); });

const post = (resource: string, payload: object) => app.inject({ method: 'POST', url: '/api/' + resource, payload });
const put = (resource: string, payload: object) => app.inject({ method: 'PUT', url: '/api/' + resource, payload });
const del = (resource: string) => app.inject({ method: 'DELETE', url: '/api/' + resource });
async function setup() {
  for (const [path, config] of [['pools', pool], ['connections', { ...gateway, poolId: pool.id }],
    ['connections', cli], ['models', model], ['members', member]] as const) {
    expect((await post(path, config)).statusCode).toBe(201);
  }
}

describe('连接、独立模型、岗位与额度池', () => {
  it('保留自由模型 ID；可把一名成员切换到 CLI，其他成员和历史配置保持可用', async () => {
    await setup();
    await post('members', { ...member, id: 'docs' });
    const api = resolveMember(db, member.id);
    expect(api.poolId).toBe('shared');
    expect(api.poolLimit).toBe(2);
    expect(providerConfig(api.connection, api.model).model).toBe(model.modelId);
    const updated = { id: member.id, name: '测试', role: 'qa', connectionId: cli.id };
    expect((await put('members/test', updated)).statusCode).toBe(200);
    expect(resolveMember(db, member.id)).toMatchObject({ model: null, poolId: 'connection:local' });
    expect(resolveMember(db, 'docs').model?.modelId).toBe(model.modelId);
    expect((await app.inject('/api/catalog')).json()).toEqual(getCatalog(db));
    expect((await del('pools/shared')).statusCode).toBe(409);
    expect((await del('models/custom')).statusCode).toBe(409);
    expect((await del('connections/local')).statusCode).toBe(409);
    expect((await del('members/test')).statusCode).toBe(204);
    expect((await del('connections/local')).statusCode).toBe(204);
  });

  it('数据库重开后恢复模型和连接；同一模型别名可绑定另一网关', async () => {
    await setup();
    await post('connections', { ...gateway, id: 'two', baseUrl: 'https://two.invalid/root' });
    await post('models', { ...model, id: 'second', connectionId: 'two' });
    db.close();
    db = openStore(join(dir, 'application.sqlite'));
    const snapshot = getCatalog(db);
    expect(snapshot.connections).toHaveLength(3);
    expect(snapshot.models.map(m => m.modelId)).toEqual([model.modelId, model.modelId]);
    expect(resolveMember(db, member.id).model?.id).toBe('custom');
  });

  it('拒绝失配模型、失效引用和编辑中的执行，禁用连接仅影响该连接', async () => {
    await setup();
    expect((await post('members', { ...member, id: 'other', connectionId: cli.id })).statusCode).toBe(400);
    expect((await post('connections', { ...gateway, id: 'badpool', poolId: 'missing' })).statusCode).toBe(409);
    busy = { memberId: member.id, connectionId: gateway.id, poolId: pool.id };
    for (const [path, data] of [['models/custom', model], ['members/test', member],
      ['pools/shared', pool], ['connections/gateway', gateway]] as const) {
      expect((await put(path, data)).statusCode).toBe(409);
    }
    busy = undefined;
    expect((await put('connections/gateway', { ...gateway, enabled: false })).statusCode).toBe(200);
    expect(() => resolveMember(db, member.id)).toThrow('禁用');
    expect((await post('connections/gateway/test', { approved: true, modelId: 'custom' })).statusCode).toBe(409);
    expect((await post('members', { id: 'second', name: '文档', role: 'docs', connectionId: cli.id })).statusCode).toBe(201);
    expect(resolveMember(db, 'second').connection.id).toBe(cli.id);
  });

  it('严格拒绝明文凭据和任意控制字段，API 响应不回显输入', async () => {
    const marker = crypto.randomUUID();
    for (const extra of [{ credentialRef: marker }, { apiKey: marker },
      { baseUrl: 'https://user:' + marker + '@example.invalid/api' }, { params: { token: marker } },
      { headers: { Authorization: marker } }, { headerRefs: { 'X-Private': marker } }]) {
      const res = await post('connections', { ...gateway, ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.body.includes(marker)).toBe(false);
    }
    expect(getCatalog(db).connections).toHaveLength(0);
  });

  it('岗位动作清单可显式为空，直属上级须存在且不能成环', async () => {
    await setup();
    const reports = { ...member, id:'junior', reportsTo:'test', allowedActions:[] };
    expect((await post('members',reports)).statusCode).toBe(201);
    expect(resolveMember(db,'junior').member.allowedActions).toEqual([]);
    expect((await put('members/test',{...member,reportsTo:'junior'})).statusCode).toBe(400);
    expect((await put('members/junior',{...reports,reportsTo:'missing'})).statusCode).toBe(404);
    expect((await put('members/junior',{...reports,allowedActions:['undeclared']})).statusCode).toBe(400);
    expect((await del('members/test')).statusCode).toBe(409);
  });

  it('保留模拟命名空间；旧连接可列出、删除，不能实跑或误充模拟成员', async () => {
    const legacy = { ...gateway, id: 'mock-old' };
    expect((await post('connections', legacy)).statusCode).toBe(400);
    db.prepare('INSERT INTO connections(id,document) VALUES (?,?)').run(legacy.id, JSON.stringify(legacy));
    expect(getCatalog(db).connections[0].id).toBe(legacy.id);
    expect((await post('connections/mock-old/test', {approved:true})).statusCode).toBe(409);
    expect((await del('connections/mock-old')).statusCode).toBe(204);
  });

  it('全局停止能取消健康检查；恢复未核对时不发送请求', async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let calls = 0;
    const mock = createServer(() => { calls++; signalStarted(); });
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
    try {
      await post('connections',{...gateway,baseUrl:'http://127.0.0.1:'+(mock.address() as AddressInfo).port});
      await post('models',model);
      const verify = () => post('connections/gateway/test',{approved:true,modelId:model.id});
      recovered = false;
      expect((await verify()).statusCode).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(0);
      recovered = true;
      const pending = verify().then(res=>res.json());
      await started;
      cancelCatalogProbes(db);
      expect(await pending).toMatchObject({ok:false});
      expect(probeCount(db,{})).toBe(0);
    } finally { mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve())); }
  });

  it('岗位验证占用共享池名额并锁定实际使用的配置，完成后释放', async () => {
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const mock = createServer(async (_req, res) => {
      signalStarted();
      await hold;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'CONCORDIA_OK' }, finish_reason: 'stop' }] }));
    });
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
    try {
      await setup();
      await put('pools/shared',{...pool,maxConcurrent:1});
      const local = { ...gateway, poolId: pool.id, baseUrl: 'http://127.0.0.1:' + (mock.address() as AddressInfo).port };
      await put('connections/gateway', local);
      await post('connections',{...local,id:'sibling'});
      await post('models',{...model,id:'other',connectionId:'sibling'});
      const pending = post('members/test/test', { approved: true }).then(res => res.json());
      await started;
      expect(probeCount(db, {poolId:'shared'})).toBe(1);
      expect((await put('members/test',member)).statusCode).toBe(409);
      expect((await put('connections/gateway',local)).statusCode).toBe(409);
      expect((await post('connections/sibling/test',{approved:true,modelId:'other'})).statusCode).toBe(409);
      release();
      expect(await pending).toMatchObject({ok:true});
      expect(probeCount(db, {connectionId:gateway.id})).toBe(0);
    } finally {
      release();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  });

  it('明确批准后只向指定本机模拟网关测试，模型选择和路径不串用', async () => {
    const seen: { url?: string; model: string }[] = [];
    const mock = createServer(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      seen.push({ url: req.url, model: JSON.parse(body).model });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'CONCORDIA_OK' }, finish_reason:'stop' }], usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5} }));
    });
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + (mock.address() as AddressInfo).port;
      for (const id of ['a', 'b']) {
        await post('connections', { ...gateway, id, baseUrl: url + '/' + id });
        await post('models', { ...model, id, connectionId: id, modelId: '任意/' + id });
      }
      const run = (id: string, body: object) => post('connections/' + id + '/test', body);
      expect((await run('a', { modelId: 'a' })).statusCode).toBe(400);
      expect((await run('a', { modelId: 'b', approved: true })).statusCode).toBe(400);
      expect(seen).toEqual([]);
      for (const id of ['a', 'b']) {
        expect((await run(id, { modelId: id, approved: true })).json()).toMatchObject({ ok: true, text: 'CONCORDIA_OK' });
      }
      await post('models',{...model,id:'alias',connectionId:'a',modelId:'another.model:v2'});
      expect((await run('a',{modelId:'alias',approved:true})).json()).toMatchObject({ok:true});
      expect((await app.inject('/api/budgets')).json().usage.find((entry:{scope:string})=>entry.scope==='global'))
        .toMatchObject({calls:3,tokens:15,active:0});
      expect((await put('budgets/global/all',{maxCalls:3})).statusCode).toBe(200);
      expect((await run('a',{modelId:'alias',approved:true})).statusCode).toBe(409);
      expect(seen).toEqual([
        {url:'/a/chat/completions',model:'任意/a'},
        {url:'/b/chat/completions',model:'任意/b'},
        {url:'/a/chat/completions',model:'another.model:v2'},
      ]);
    } finally { await new Promise<void>(resolve => mock.close(() => resolve())); }
  });
});
