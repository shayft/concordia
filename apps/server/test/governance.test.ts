import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { it, expect } from 'vitest';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';

it('将当前会话批准、当时的预算和调度结果关联；改限额使旧批准失效，分享摘要始终排除私有字段', async () => {
  const root = await mkdtemp(join(tmpdir(),'concordia-governance-'));
  const web = join(root,'web'), data = join(root,'data');
  const gateway = createServer((_req,res) => {
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason:'stop', message: { role:'assistant', content:'CONCORDIA_OK' } }] }));
  });
  let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    await mkdir(join(web,'assets'),{recursive:true});
    await writeFile(join(web,'index.html'),'<title>test</title>');
    gateway.listen(0,'127.0.0.1');
    await once(gateway,'listening');
    const baseUrl = 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port;
    app = await startLocalServer(web,data);
    const browser = await browserSession(new URL(app.launchUrl));
    const endpoint = '/api/connections/g/test';
    const model = { id:'m', name:'private-display-example', modelId:'private-model-example', connectionId:'g' };
    expect((await browser.post('/api/connections',{ id:'g', name:'private-connection-example', kind:'chat-completions', baseUrl })).status).toBe(201);
    expect((await browser.post('/api/models',model)).status).toBe(201);
    const caps = (maxCalls: number) => browser.post('/api/budgets/global/all',{maxCalls},'PUT');
    expect((await caps(3)).status).toBe(200);
    const preview = async () => (await (await browser.get('/api/approval-route?purpose=connection-test&id=g&modelId=m')).json()).stamp as string;
    const old = await preview();
    expect((await caps(2)).status).toBe(200);
    expect((await browser.post(endpoint,{approved:true,modelId:'m'},'POST',old)).status).toBe(409);
    expect(await (await browser.post(endpoint,{approved:true,modelId:'m'})).json()).toMatchObject({ ok:true });
    await caps(1);
    const ignored = await fetch(browser.origin + '/api/governance');
    expect(ignored.status).toBe(401);
    expect((await browser.get('/api/governance?before=invalid')).status).toBe(400);
    const state = await (await browser.get('/api/governance')).json() as {
      items: { seq:number; session:string; action:string; details: { before?:object; after?:object; policy?:{limits:object[]} }; calls:object[] }[]
    };
    const decision = state.items.find(r => r.action === 'approval.granted')!;
    expect(decision.details.policy?.limits).toEqual([expect.objectContaining({max_calls:2})]);
    expect(decision.calls).toEqual([expect.objectContaining({status:'finished',outcome:'success',count:1})]);
    expect(state.items.find(r => r.action === 'approval.rejected')?.calls).toEqual([]);
    expect(state.items[0]).toMatchObject({ action:'budget.updated',details:{before:{max_calls:2},after:{max_calls:1}} });
    expect(new Set(state.items.map(i => i.session)).size).toBe(1);
    expect(JSON.stringify(state)).not.toContain('private-');
    const shared = await (await browser.get('/api/export/audit')).text();
    expect(shared).not.toContain(decision.session);
    expect(shared).not.toContain(baseUrl);
    await app.close();
    app = await startLocalServer(web,data);
    const restarted = await browserSession(new URL(app.launchUrl));
    expect((await restarted.post('/api/budgets/global/all',{},'DELETE')).status).toBe(204);
    const page = await (await restarted.get('/api/governance')).json();
    expect(page.items[0].session).not.toBe(decision.session);
    expect(page.items).toContainEqual(decision);
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { gateway.close(() => resolve()); gateway.closeAllConnections(); });
    await rm(root,{recursive:true,force:true});
  }
}, 30000);
