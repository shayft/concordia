import { browserSession } from './browser-session.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Scheduler, WorkflowEvent } from '@concordia/core/workflow';
import { startLocalServer } from '../src/local-server.ts';
import { git } from '../src/worktrees/git.ts';

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
type Client = Awaited<ReturnType<typeof browserSession>>;
function login(app: Application) { return browserSession(new URL(app.launchUrl)); }

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
  const messages: unknown[] = [];
  const mode = { jsonOnly:false };
  const statuses: number[] = [];
  const seen: Array<{stream:unknown; model:unknown; url:unknown; authorization:boolean}> = [];
  const srv = createServer(async (req,res) => {
    const input: {model:unknown;stream:unknown;messages:unknown} = JSON.parse(await text(req));
    messages.push(input.messages);
    seen.push({ stream: input.stream, model:input.model, url:req.url, authorization:req.headers.authorization!==undefined });
    const status = statuses.shift() ?? 200;
    if (status < 200 || status >= 300) { res.writeHead(status).end(); return; }
    if (mode.jsonOnly && input.stream !== false) {res.writeHead(406).end();return;}
    const dispatch = queue.shift();
    if (!dispatch) { res.writeHead(500).end();return; }
    res.writeHead(status,{'content-type':input.stream === false ? 'application/json' : 'text/event-stream'});res.flushHeaders();
    dispatch(res);
  });
  srv.listen(0,'127.0.0.1');
  await once(srv,'listening');
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('缺少本地测试端口');
  return {queue,seen,messages,statuses,mode,baseUrl:'http://127.0.0.1:'+addr.port+'/custom/v1',close: async () => {
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

async function configure(ui: Client, stream?:boolean) {
  const responses = [
    await ui.post('/api/connections',{id:'gateway',name:'临时本机网关',kind:'chat-completions',baseUrl:api.baseUrl,stream}),
    await ui.post('/api/models',{id:'custom',name:'自定义',connectionId:'gateway',modelId:'dev/任意模型',toolMode:'json'}),
    await ui.post('/api/members',{id:'lead',name:'负责人',role:'负责验收',connectionId:'gateway',modelId:'custom'}),
  ];
  expect(responses.map(r=>r.status)).toEqual([201,201,201]);
}
async function board(ui: Client): Promise<ReturnType<Scheduler['board']>> {
  const response=await ui.get('/api/board');expect(response.status).toBe(200);return response.json() as Promise<ReturnType<Scheduler['board']>>;
}
async function history(ui:Client,after=0):Promise<WorkflowEvent[]> {
  return (await ui.get('/api/history?after='+after)).json() as Promise<WorkflowEvent[]>;
}
async function apply(ui: Client, plan:unknown=spec) {
  expect((await ui.post('/api/spec/apply',{spec:plan,expectedRevision:0,approved:true})).status).toBe(200);
}

it('README 无账号示例从手工预览到主卡验收均可在空连接目录运行', async () => {
  const example = JSON.parse(await readFile(new URL('../../../examples/first-workflow.json', import.meta.url), 'utf8'));
  app = await startLocalServer(web, data);
  const ui = await login(app);
  expect(await (await ui.get('/api/catalog')).json()).toMatchObject({ connections: [], members: [], models: [] });
  expect((await ui.post('/api/spec/preview', { spec: example })).status).toBe(200);
  expect((await board(ui)).spec).toBeNull();
  expect((await ui.post('/api/spec/apply', { spec: example, expectedRevision: 0 })).status).toBe(400);
  await apply(ui, example);
  const task = '/api/tasks/publish-title';
  expect((await ui.post(task + '/run', { mode: 'simulation' })).status).toBe(200);
  await vi.waitFor(async () => expect((await board(ui)).tasks[0].status).toBe('review'));
  const { versions: [version], executions } = await board(ui);
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({ status: 'success', connection: 'mock-editor' });
  expect(version.slotId).toBe('title-card');
  expect(await (await ui.get('/api/versions/' + version.id)).json()).toMatchObject({ content: '模拟交付 · 发布标题卡' });
  expect((await ui.post(task + '/control', { action: 'accept' })).status).toBe(400);
  expect((await ui.post(task + '/control', { action: 'accept', expectedExecutionId: 'old' })).status).toBe(409);
  expect((await ui.post(task + '/control', { action: 'accept', expectedExecutionId: executions[0].id })).status).toBe(200);
  const expected = (await board(ui)).acceptanceCandidate!;
  expect((await ui.post('/api/accept', {})).status).toBe(400);
  expect((await ui.post('/api/accept', {expected: {...expected, versions: {}}})).status).toBe(409);
  expect(await (await ui.post('/api/accept', { expected: (await board(ui)).acceptanceCandidate })).json()).toEqual({ snapshot: { 'title-card': version.id } });
  expect(api.seen).toHaveLength(0);
});

it('同一模板两次新建使用独立实例；从归档修订时显示该计划自己的预算差异', async () => {
  app = await startLocalServer(web, data);
  const ui = await login(app);
  await configure(ui);
  expect((await ui.post('/api/members', {id:'peer',name:'同事',role:'审查',connectionId:'gateway',modelId:'custom'})).status).toBe(201);
  for (const type of ['meeting','parallel','review']) {
    const create = async () => {
      const response = await ui.post('/api/templates/' + type, {goal:'相同目标',members:['lead','peer']});
      expect(response.status).toBe(200);
      return response.json() as Promise<NonNullable<ReturnType<Scheduler['board']>['spec']>>;
    };
    const first = await create(), second = await create();
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith(type + '-')).toBe(true);
    if (type !== 'meeting') continue;
    const legacy = {...first, id:'meeting', maxTokens:1234};
    await apply(ui,legacy);
    expect((await ui.post('/api/spec/apply', {spec:second,expectedRevision:1,approved:true})).status).toBe(200);
    const draft = await (await ui.get('/api/plans/meeting/spec')).json() as typeof legacy;
    expect(draft.maxTokens).toBe(1234);
    expect(await (await ui.get('/api/plans')).json()).toContainEqual({id:'meeting',title:legacy.title,active:false});
    const next = {...draft, maxTokens:4567};
    const preview = await (await ui.post('/api/spec/preview',{spec:next,revisionOf:'meeting'})).json();
    expect(preview).toMatchObject({baselineId:'meeting',revision:2,settings:[{field:'maxTokens',before:1234,after:4567}]});
    expect((await ui.post('/api/spec/apply',{spec:next,revisionOf:second.id,approved:true,expectedRevision:2})).status).toBe(409);
    expect((await ui.post('/api/spec/apply',{spec:next,revisionOf:'meeting',approved:true,expectedRevision:2})).status).toBe(200);
    expect((await board(ui)).spec?.id).toBe('meeting');
  }
  expect(api.seen).toHaveLength(0);
});

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
  expect(proposed.spec.id).toMatch(/^plan-/);
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
  expect((await ui.post('/api/tasks/write/control',{action:'accept',expectedExecutionId:executionId})).status).toBe(200);
  expect(await (await ui.post('/api/accept',{expected:(await board(ui)).acceptanceCandidate})).json()).toEqual({snapshot:{sample:version.id}});
  expect(api.seen).toEqual(Array.from({length:2},()=>({stream:true,model:'dev/任意模型',url:'/custom/v1/chat/completions',authorization:false})));
},20_000);

it('仅支持 JSON 的网关从持久化配置完成连接验证、生成计划与执行任务', async () => {
  api.mode.jsonOnly = true;
  app = await startLocalServer(web, data);
  let ui = await login(app);
  await configure(ui, false);
  await app.close();
  app = await startLocalServer(web, data);
  ui = await login(app);
  const send = (content: string) => (res: ServerResponse) =>
    res.end(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
  api.statuses.push(201);
  api.queue.push(send('CONCORDIA_OK'));
  const health = await ui.post('/api/connections/gateway/test', { modelId: 'custom', approved: true });
  expect(await health.json()).toMatchObject({
    ok: true,
    httpStatus: 201,
    elapsedMs: expect.any(Number),
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
  api.queue.push(send(JSON.stringify(spec)));
  const generated = await ui.post('/api/plans/generate', {
    goal: spec.goal,
    agentId: 'lead',
    approved: true,
  });
  expect(generated.status).toBe(200);
  await apply(ui, (await generated.json()).spec);
  api.queue.push(send(JSON.stringify({ actions })));
  expect((await ui.post('/api/tasks/write/run', { mode: 'live', approved: true })).status).toBe(200);
  await vi.waitFor(async () => expect((await board(ui)).tasks[0].status).toBe('review'));
  expect(api.seen.map((x) => [x.stream, x.model])).toEqual(
    Array.from({ length: 3 }, () => [false, 'dev/任意模型']),
  );
}, 20_000);

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
    const res = await ui.post('/api/members/lead', { id:'lead',name:'负责人',role:'负责验收',connectionId:'gateway',modelId:'custom' }, 'PUT');
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
    const response=await fetch(restored.origin+'/api/events',{headers:{...restored.headers,'Last-Event-ID':String(after)},signal:controller.signal});
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

it('通用 Worker 从绑定树提交版本，只读下游从该 SHA 读文件；同名跨工作区任务不能借用原树', async () => {
  const repository = join(directory, 'user-project');
  await mkdir(repository);
  git(repository, ['init', '-b', 'main', '--template=']);
  await writeFile(join(repository, 'README.md'), '用户项目基准');
  git(repository, ['add', '--', 'README.md']);
  git(repository, ['commit', '-m', '临时验收基准']);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  app = await startLocalServer(web, data);
  const ui = await login(app);
  await configure(ui);
  const plan = {
    ...spec,
    id: 'same-plan',
    requiredSlots: ['sample', 'inspection'],
    slots: [...spec.slots, { id: 'inspection', title: '读取结果' }],
    tasks: [
      ...spec.tasks,
      {
        id: 'inspect',
        title: '按已发布版本检查文件',
        owner: 'lead',
        consumes: [{ slotId: 'sample' }],
        produces: ['inspection'],
      },
    ],
  };
  await apply(ui, plan);
  const project = { id: 'user-repo', repository, targetBranch: 'main', writeEnabled: true, commands: [] };
  expect((await ui.post('/api/worktrees/projects', project)).ok).toBe(true);
  const createTree = () => ui.post('/api/worktrees/member', { projectId: project.id, taskId: 'write' });
  const treeResponse = await createTree();
  expect(treeResponse.ok).toBe(true);
  const member = (await treeResponse.json()) as { id: string; path: string };
  const path = 'lib/version.txt',
    published = '发布时的正文',
    later = '尚未交付的本地改动';
  api.queue.push((res) =>
    finish(res, {
      actions: [
        { type: 'write_file', path, content: published },
        { type: 'commit_artifact', slotId: 'sample' },
        { type: 'request_review', taskId: 'write' },
      ],
    }),
  );
  const bound = { mode: 'live', approved: true, projectId: project.id, treeId: member.id };
  expect((await ui.post('/api/tasks/write/run', bound)).ok).toBe(true);
  await vi.waitFor(
    async () => expect((await board(ui)).tasks.find((t) => t.id === 'write')?.status).toBe('review'),
    { timeout: 10000 },
  );
  const version = (await board(ui)).versions.find((v) => v.slotId === 'sample')!;
  expect(version.kind).toBe('git_commit');
  const record = (await (await ui.get('/api/versions/' + version.id)).json()) as { content: string };
  expect(record.content).toBe(git(member.path, ['rev-parse', 'HEAD']).trim());
  expect(git(repository, ['show', record.content + ':' + path])).toBe(published);
  // Simulate an unpublished edit after the slot was fulfilled.
  await writeFile(join(member.path, path), later);
  api.queue.push((res) =>
    finish(res, { type: 'read_artifact', slotId: 'sample', versionId: version.id, path }),
  );
  api.queue.push((res) =>
    finish(res, {
      actions: [
        { type: 'publish_artifact', slotId: 'inspection', content: '已读取' },
        { type: 'request_review', taskId: 'inspect' },
      ],
    }),
  );
  expect((await ui.post('/api/tasks/inspect/run', { mode: 'live', approved: true, maxCalls: 2 })).ok).toBe(
    true,
  );
  await vi.waitFor(async () =>
    expect((await board(ui)).tasks.find((t) => t.id === 'inspect')?.status).toBe('review'),
  );
  const delivered = JSON.stringify(api.messages.at(-1));
  expect(delivered).toContain(published);
  expect(delivered).not.toContain(later);
  expect((await board(ui)).versions.find((v) => v.slotId === 'inspection')?.basedOn).toEqual({
    sample: version.id,
  });
  expect(git(repository, ['rev-parse', 'HEAD']).trim()).toBe(base);
  expect(git(repository, ['status', '--porcelain'])).toBe('');
  const oldCalls = api.seen.length;
  expect((await ui.post('/api/workspaces', { name: '同名任务的另一个工作区' })).ok).toBe(true);
  await apply(ui, plan);
  expect((await ui.post('/api/tasks/write/run', bound)).status).toBe(409);
  expect((await ui.get('/api/versions/' + version.id)).ok).toBe(false);
  expect(api.seen).toHaveLength(oldCalls);
  const foreign = await createTree();
  expect(foreign.ok).toBe(true);
  expect(((await foreign.json()) as { id: string }).id).not.toBe(member.id);
  api.queue.push((res) =>
    finish(res, {
      actions: [
        { type: 'publish_artifact', slotId: 'sample', content: '第二个工作区自己的占位版本' },
        { type: 'request_review', taskId: 'write' },
      ],
    }),
  );
  expect((await ui.post('/api/tasks/write/run', { mode: 'live', approved: true })).ok).toBe(true);
  await vi.waitFor(async () =>
    expect((await board(ui)).tasks.find((t) => t.id === 'write')?.status).toBe('review'),
  );
  api.queue.push((res) =>
    finish(res, { type: 'read_artifact', slotId: 'sample', versionId: version.id, path }),
  );
  expect((await ui.post('/api/tasks/inspect/run', { mode: 'live', approved: true, maxCalls: 2 })).ok).toBe(
    true,
  );
  await vi.waitFor(async () => {
    const b = await board(ui);
    const execution = b.executions.find((e) => e.taskId === 'inspect');
    expect(execution?.status).toBe('failed');
    expect(b.versions.some((v) => v.slotId === 'inspection')).toBe(false);
  });
  expect(api.seen).toHaveLength(oldCalls + 2);
  expect(JSON.stringify(api.messages.slice(oldCalls))).not.toContain(published);
}, 30_000);

it('共享账户限流后，切换工作区仍须手动恢复，未恢复前不再向网关发请求', async () => {
  app = await startLocalServer(web, data);
  const first = await login(app);
  await configure(first);
  await apply(first);
  api.statuses.push(429);
  expect((await first.post('/api/tasks/write/run', { mode: 'live', approved: true })).status).toBe(200);
  await vi.waitFor(async () => expect((await board(first)).stoppedPools).toContain('connection:gateway'));
  await vi.waitFor(async () => {
    const switched = await first.post('/api/workspaces', { name: '同一账户' });
    expect(switched.status).toBe(200);
  });
  await apply(first);
  expect((await board(first)).stoppedPools).toContain('connection:gateway');
  expect((await first.post('/api/tasks/write/run', { mode: 'live', approved: true })).status).toBe(409);
  expect(api.seen).toHaveLength(1);
  expect((await first.post('/api/pools/connection%3Agateway/resume', {})).status).toBe(200);
  expect((await first.post('/api/workspaces/default/select', {})).status).toBe(200);
  expect((await board(first)).stoppedPools).toEqual([]);
  expect(api.seen).toHaveLength(1);
}, 20_000);
