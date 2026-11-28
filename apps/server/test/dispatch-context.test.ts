import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
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

it('已批准两轮的 JSON 通道按版本取页，单轮成员收到同一交付物的内联全文', async () => {
  const content = '图🙂'.repeat(900);
  const requests: {messages:{role:string;content:string}[]}[] = [];
  const action = {type:'submit_result',summary:'已完成'};
  const responses = [
    [{type:'publish_artifact',slotId:'doc',content},action],
    [{type:'read_artifact',slotId:'doc',limit:3}], [action], [action],
  ];
  const baseUrl = await listen(async (req,res) => {
    requests.push(JSON.parse(await text(req)));
    const answer = responses.shift();
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));
  });
  const dir = await mkdtemp(join(tmpdir(),'concordia-document-'));
  let app;
  try {
    const web = join(dir,'web');
    await mkdir(join(web,'assets'),{recursive:true});
    await writeFile(join(web,'index.html'),'测试');
    app = await startLocalServer(web,join(dir,'data'));
    const ui = await browserSession(new URL(app.launchUrl));
    const spec = {id:'documents',title:'文档',goal:'按需取阅',acceptance:['正确取页'],slots:[{id:'doc',title:'文档'}],
      agents:[{id:'member',name:'协作者',connection:'gateway'}],tasks:[
        {id:'source',title:'写入',owner:'member',produces:['doc']},
        {id:'capable',title:'按需',owner:'member',consumes:[{slotId:'doc'}]},
        {id:'single',title:'内联',owner:'member',consumes:[{slotId:'doc'}]}]};
    for (const [path,body] of [
      ['/api/connections',{id:'gateway',name:'模拟',kind:'chat-completions',baseUrl,stream:false}],
      ['/api/models',{id:'model',connectionId:'gateway',name:'模型',modelId:'custom',toolMode:'json'}],
      ['/api/members',{id:'member',name:'协作者',role:'测试',connectionId:'gateway',modelId:'model',
        allowedActions:['publish_artifact','read_artifact','submit_result']}],
      ['/api/spec/apply',{spec,expectedRevision:0,approved:true}],
    ] as const) expect((await ui.post(path,body)).ok).toBe(true);
    for (const [task, maxCalls] of [['source',1],['capable',2],['single',1]] as const) {
      expect((await ui.post('/api/tasks/'+task+'/run',{mode:'live',approved:true,maxCalls})).ok).toBe(true);
      await vi.waitFor(async () => {
        const board = await (await ui.get('/api/board')).json();
        expect(board.tasks.find((t:{id:string})=>t.id===task).status).toBe('review');
      });
    }
    const context = (index:number) => JSON.parse(requests[index].messages[1].content);
    expect(context(1).inputs.doc).toMatchObject({versionId:expect.any(String),readWith:'read_artifact',utf8Bytes:Buffer.byteLength(content)});
    expect(requests[2].messages.at(-1)?.content).toContain('"content":"图🙂图","nextOffset":3');
    expect(context(3).inputs.doc).toBe(content);
    expect(requests).toHaveLength(4);
  } finally {
    await app?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
