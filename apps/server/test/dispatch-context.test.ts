import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { listen } from '../../../packages/providers/test/fixture.ts';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';

it('从任务入口在最终工具上下文过大时阻止首发，工作流和系统预算均为零', async () => {
  let requests = 0;
  const baseUrl = await listen((_req, res) => { requests++; res.writeHead(500).end(); });
  const dir = await mkdtemp(join(tmpdir(), 'concordia-context-budget-'));
  let app;
  try {
    const web = join(dir,'web');
    await mkdir(join(web,'assets'),{recursive:true}); await writeFile(join(web,'index.html'), '测试');
    app = await startLocalServer(web,join(dir,'data'));
    const ui = await browserSession(new URL(app.launchUrl));
    const agent = {id:'member',name:'协作者',connection:'gateway',role:'lead'};
    const spec = {id:'test',title:'上下文',goal:'短输入',acceptance:['测试'],slots:[{id:'out',title:'结果'}],
      requiredSlots:['out'],agents:[agent],tasks:[{id:'write',title:'测试',owner:'member',produces:['out']}],
      maxContextTokens:420,maxCalls:1};
    for (const [path, body] of [
      ['/api/connections',{id:'gateway',name:'模拟',kind:'chat-completions',baseUrl}],
      ['/api/models',{id:'model',connectionId:'gateway',name:'模型',modelId:'custom'}],
      ['/api/members',{id:'member',name:'协作者',role:'测试',connectionId:'gateway',modelId:'model'}],
      ['/api/spec/apply',{spec,expectedRevision:0,approved:true}],
    ] as const) expect((await ui.post(path,body)).ok).toBe(true);
    expect((await ui.post('/api/tasks/write/run',{mode:'live',approved:true})).status).toBe(200);
    await vi.waitFor(async () => {
      const board = await (await ui.get('/api/board')).json();
      expect(board.tasks[0]).toMatchObject({status:'decision'});
      expect(board.executions[0]).toMatchObject({calls:0,meters:[]});
    });
    expect(requests).toBe(0);
    expect((await (await ui.get('/api/budgets')).json()).usage).toContainEqual({
      scope:'global',id:'all',calls:0,tokens:0,active:0,
    });
  } finally {
    await app?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
