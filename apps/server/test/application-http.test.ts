import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { State, WorkflowEvent } from '@concordia/core/workflow';
import { startLocalServer } from '../src/local-server.ts';

const spec = {
  id: 'sample', title: '交付样例', goal: '让下游按指定样例验收', acceptance: ['可读版本'],
  agents: [{ id: 'lead', name: '负责人', connection: 'gateway', role: 'lead' }],
  slots: [{id:'sample', title:'样例'}], requiredSlots:['sample'],
  tasks: [{ id:'write', title:'发布样例', owner:'lead', produces:['sample'] }],
};
const actions = [
  { type:'publish_artifact', slotId:'sample', content:'来自本次有效执行' },
  { type:'submit_result', summary:'请对照样例验收' },
];
interface Application { launchUrl: string; close(): Promise<void> }
interface Client {
  origin: string;
  cookie: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}
async function login(app: Application): Promise<Client> {
  const launch = new URL(app.launchUrl);
  const response = await fetch(launch.origin + '/session', {method:'POST',
    headers:{origin:launch.origin,'content-type':'application/json'}, body:JSON.stringify({token:launch.hash.slice(1)})});
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { origin:launch.origin, cookie,
    get: path => fetch(launch.origin + path,{headers:{cookie}}),
    post: (path, body) => fetch(launch.origin + path,{method:'POST',headers:{cookie,origin:launch.origin,'content-type':'application/json'}, body:JSON.stringify(body)}),
  };
}

function finish(res: ServerResponse, content: unknown) {
  const encoded = JSON.stringify(content);
  const half = Math.floor(encoded.length/2);
  const frames = [encoded.slice(0,half), encoded.slice(half)].map((part,i) =>
    ({ choices:[{index:0,delta:{content:part},finish_reason:i===1?'stop':null}] }));
  for (const frame of frames) res.write('data: ' + JSON.stringify(frame) + '\n\n');
  res.write('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n');
  res.end('data: [DONE]\n\n');
}

async function gateway() {
  const queue: Array<(res:ServerResponse)=>void> = [];
  const seen: Array<{stream:unknown; model:unknown; url:unknown; authorization:boolean}> = [];
  const srv = createServer(async (req,res) => {
    const input: {model:unknown;stream:unknown} = JSON.parse(await text(req));
    seen.push({ stream: input.stream, model:input.model, url:req.url, authorization:req.headers.authorization!==undefined });
    const dispatch = queue.shift();
    if (!dispatch) { res.writeHead(500).end();return; }
    res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
    dispatch(res);
  });
  srv.listen(0,'127.0.0.1');
  await once(srv,'listening');
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('缺少本地测试端口');
  return {queue,seen,baseUrl:'http://127.0.0.1:'+addr.port+'/custom/v1',close: async () => {
    const closed=once(srv,'close');srv.close();srv.closeAllConnections();await closed;
  }};
}

let directory: string;
let web: string;
let data: string;
let app: Application | undefined;
let api: Awaited<ReturnType<typeof gateway>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(),'concordia-app-http-'));
  web = join(directory,'web');data=join(directory,'data');
  await mkdir(join(web,'assets'),{recursive:true});await writeFile(join(web,'index.html'),'<title>Concordia</title>');
  api=await gateway();
});
afterEach(async () => {
  try { await app?.close(); } finally { app=undefined;await api.close();await rm(directory,{recursive:true,force:true}); }
});

async function configure(ui: Client) {
  const responses = [
    await ui.post('/api/connections',{id:'gateway',name:'临时本机网关',kind:'chat-completions',baseUrl:api.baseUrl}),
    await ui.post('/api/models',{id:'custom',name:'自定义',connectionId:'gateway',modelId:'dev/任意模型',toolMode:'json'}),
    await ui.post('/api/members',{id:'lead',name:'负责人',role:'负责验收',connectionId:'gateway',modelId:'custom'}),
  ];
  expect(responses.map(r=>r.status)).toEqual([201,201,201]);
}
async function board(ui: Client): Promise<State> {
  const response=await ui.get('/api/board');expect(response.status).toBe(200);return response.json() as Promise<State>;
}
async function history(ui:Client,after=0):Promise<WorkflowEvent[]> {
  return (await ui.get('/api/history?after='+after)).json() as Promise<WorkflowEvent[]>;
}
async function apply(ui: Client, plan:unknown=spec) {
  expect((await ui.post('/api/spec/apply',{spec:plan,expectedRevision:0,approved:true})).status).toBe(200);
}

it('阶段 2/4：用原生 HTTP 会话创建连接，先批准生成再批准计划和调用，最终验收指定版本',async () => {
  app=await startLocalServer(web,data);const ui=await login(app);
  expect((await fetch(ui.origin+'/api/catalog')).status).toBe(401);
  const denied=await fetch(ui.origin+'/api/plans/generate',{method:'POST',headers:{cookie:ui.cookie,origin:'http://untrusted.invalid','content-type':'application/json'},body:'{}'});
  expect(denied.status).toBe(403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(ui.origin+'/api/plans/generate', { method:'POST', headers:{
      host:'untrusted.invalid',cookie:ui.cookie,origin:ui.origin,'content-type':'application/json',
    } }, response => {response.resume();resolve(response.statusCode);});
    req.on('error',reject);req.end(JSON.stringify({goal:spec.goal, agentId:'lead', approved:true}));
  });
  expect(hostStatus).toBe(403);
  await configure(ui);
  const goal={goal:spec.goal,agentId:'lead'};
  expect((await ui.post('/api/plans/generate',goal)).status).toBe(400);
  expect(api.seen).toHaveLength(0);
  api.queue.push(res=>finish(res,spec));
  const generated=await ui.post('/api/plans/generate',{...goal,approved:true});
  expect(generated.status).toBe(200);
  const proposed=await generated.json() as {spec:typeof spec;preview:unknown};
  expect(proposed.spec.id).toBe(spec.id);
  expect((await board(ui)).spec).toBeNull();
  expect((await ui.post('/api/spec/preview',{spec:proposed.spec})).status).toBe(200);
  expect((await ui.post('/api/spec/apply',{spec:proposed.spec,expectedRevision:0})).status).toBe(400);
  expect((await board(ui)).revision).toBe(0);
  await apply(ui,proposed.spec);
  expect((await ui.post('/api/tasks/write/run',{mode:'live'})).status).toBe(409);
  expect(api.seen).toHaveLength(1);
  api.queue.push(res=>finish(res,{actions}));
  const launched=await ui.post('/api/tasks/write/run',{mode:'live',approved:true});
  expect(launched.status).toBe(200);
  const {executionId}=await launched.json() as {executionId:string};
  await vi.waitFor(async () => expect((await board(ui)).tasks[0].status).toBe('review'));
  const current=await board(ui);
  expect(current.executions[0]).toMatchObject({id:executionId,status:'success',connection:'gateway',usage:{input:4,output:2}});
  const version=current.versions[0];
  expect(version).toMatchObject({slotId:'sample',executionId});
  expect(JSON.stringify(await (await ui.get('/api/versions/'+version.id)).json())).toContain(actions[0].content);
  expect((await ui.post('/api/tasks/write/control',{action:'accept'})).status).toBe(200);
  expect(await (await ui.post('/api/accept',{})).json()).toEqual({snapshot:{sample:version.id}});
  expect(api.seen).toEqual(Array.from({length:2},()=>({stream:true,model:'dev/任意模型',url:'/custom/v1/chat/completions',authorization:false})));
},20_000);

it('阶段 5：取消正在接收的流；迟到的完整动作不能发布版本或改回成功',async () => {
  app=await startLocalServer(web,data);const ui=await login(app);
  await configure(ui);await apply(ui);
  let late!:ServerResponse;
  const began=new Promise<void>(resolve=>api.queue.push(res=>{late=res;res.write(': waiting\n\n');resolve();}));
  expect((await ui.post('/api/tasks/write/run',{mode:'live',approved:true})).status).toBe(200);
  await began;
  expect((await ui.post('/api/tasks/write/control',{action:'cancel'})).status).toBe(200);
  finish(late,{actions});
  // A busy member is immutable. A successful no-op edit establishes that
  // the runtime and its finally block have finished processing the late frame.
  await vi.waitFor(async () => {
    const res=await fetch(ui.origin+'/api/members/lead',{ method:'PUT',
      headers:{origin:ui.origin,cookie:ui.cookie,'content-type':'application/json'},
      body:JSON.stringify({id:'lead',name:'负责人',role:'负责验收',connectionId:'gateway',modelId:'custom'})});
    expect(res.status).toBe(200);
  });
  const current=await board(ui);
  expect(current.tasks[0].status).toBe('cancelled');
  expect(current.executions[0].status).toBe('cancelled');
  expect(current.versions).toHaveLength(0);
  expect(api.seen).toHaveLength(1);
},15_000);

async function isolatedServer():Promise<Application> {
  const module=new URL('../src/local-server.ts',import.meta.url).href;
  const script='const [module,web,data]=process.argv.slice(1);const {startLocalServer}=await import(module);const app=await startLocalServer(web,data);process.send(app.launchUrl);';
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,module,web,data],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),stdio:['ignore','ignore','ignore','ipc'],shell:false,
    env:{SystemRoot:process.env.SystemRoot,TMPDIR:directory,TMP:directory,TEMP:directory,PATH:process.env.PATH},
  });
  const finished=once(child,'exit');
  // Register cleanup immediately, even if server startup fails.
  const close=async () => { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); await finished; };
  try {
    const launchUrl = await Promise.race([once(child,'message').then(([s])=>String(s)),
      finished.then(()=>Promise.reject(new Error('测试服务未启动')))]);
    return {launchUrl,close};
  } catch(err) {await close();throw err;}
}

it('阶段 5：强制终止 HTTP 服务后，同一目录重新启动可追赶 SSE，中断执行等待用户决定',async () => {
  app=await isolatedServer();const original=await login(app);
  await configure(original);await apply(original);
  const began=new Promise<void>(resolve=>api.queue.push(res=>{res.write(': waiting\n\n');resolve();}));
  const launched=await original.post('/api/tasks/write/run',{mode:'live',approved:true});
  expect(launched.status).toBe(200);
  const {executionId}=await launched.json() as {executionId:string};await began;
  const prior=await history(original);const after=prior.at(-1)!.seq;
  expect((await board(original)).executions[0].status).toBe('running');
  await app.close();app=undefined;
  app=await startLocalServer(web,data);const restored=await login(app);
  expect((await fetch(restored.origin+'/api/board',{headers:{cookie:original.cookie}})).status).toBe(401);
  const current=await board(restored);
  expect(current.executions).toEqual([expect.objectContaining({id:executionId,status:'interrupted'})]);
  expect(current.tasks[0].status).toBe('decision');
  expect(current.versions).toHaveLength(0);
  const replay=await history(restored,after);
  expect(replay.length).toBeGreaterThan(0);
  const controller=new AbortController();
  try {
    const response=await fetch(restored.origin+'/api/events',{headers:{cookie:restored.cookie,'Last-Event-ID':String(after)},signal:controller.signal});
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader=response.body!.getReader();let received='';
    while(!received.includes('id: '+replay.at(-1)!.seq+'\n')) {
      const {value,done}=await reader.read();
      if(done) break;
      received+=new TextDecoder().decode(value);
    }
    expect([...received.matchAll(/^id: (\d+)$/gm)].map(m=>Number(m[1]))).toEqual(replay.map(e=>e.seq));
  } finally {controller.abort();}
  expect(api.seen).toHaveLength(1);
},25_000);
