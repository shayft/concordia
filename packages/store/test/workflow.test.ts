import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  demoSpec,
  meetingSpec,
  parallelSpec,
  reviewSpec,
  Scheduler,
  type Version,
  type Question,
} from '@concordia/core/workflow';
import { runDemo } from '@concordia/core/demo';
import { openStore } from '../src/index.ts';
import { WorkflowStore } from '../src/workflow.ts';

let db: DatabaseSync;
let root: string;
let storage: WorkflowStore;
let scheduler: Scheduler;
let ids = 0;
const clock = () => 12345;
const nextId = () => 'id-' + ++ids;
function connect() {
  db = openStore(join(root, 'db.sqlite'));
  storage = new WorkflowStore(db);
  scheduler = new Scheduler({ storage, now: clock, nextId });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'concordia-workflow-'));
  ids = 0;
  connect();
});
afterEach(() => {
  db.close();
  rmSync(root, { force: true, recursive: true });
});
const task = (id: string) => scheduler.board().tasks.find((task) => task.id === id)!;
const pub = (executionId: string, slotId: string, content: string, incompatible = false) =>
  scheduler.act(executionId, { type: 'publish_artifact', slotId, content, incompatible }) as Version;
function submit(id: string, taskId: string) {
  scheduler.act(id, { type: 'submit_result', summary: '已完成' });
  scheduler.control(taskId, 'accept');
}

describe('真实 SQLite 与脚本化成员', () => {
  it('固定流程在后端完成前并行执行前端和测试，普通进度零次派发，非必需说明不阻塞', () => {
    const board = runDemo(scheduler);
    expect(board.acceptance).toHaveProperty('integration');
    expect(task('guide').status).toBe('ready');
    const e = scheduler.events();
    const api = board.executions.find((x) => x.taskId === 'api')!;
    const finished = e.find((x) => x.type === 'execution.submitted' && x.data.id === api.id)!.seq;
    expect(
      e
        .filter((x) => x.type === 'execution.started' && ['tests', 'ui'].includes(String(x.data.taskId)))
        .every((x) => x.seq < finished),
    ).toBe(true);
    expect(board.executions.length).toBe(5);
    expect(board.questions[0]).toMatchObject({ from: 'frontend', to: 'backend', status: 'answered' });
  });
  it('输入包和发布内容按哈希回读，重开后保留执行与事件游标', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api'),
      v = pub(api.id, 'contract', '接口 v1');
    const ui = scheduler.claim('ui');
    expect(scheduler.context(ui.id).inputs.contract).toBe('接口 v1');
    const seq = scheduler.events().at(-1)!.seq;
    db.close();
    connect();
    expect(scheduler.readVersion(v.id).content).toBe('接口 v1');
    expect(scheduler.recover()).toBe(2);
    expect(scheduler.recover()).toBe(0);
    expect(task('ui')).toMatchObject({ status: 'decision', column: 'doing' });
    expect(scheduler.events(seq).map((e) => e.type)).toEqual([
      'execution.interrupted',
      'execution.interrupted',
    ]);
  });
  it('事务失败时回滚状态及事件，两个连接不能重复领取同一卡', () => {
    scheduler.apply(demoSpec());
    expect(() =>
      storage.transaction((s, append) => {
        s.tasks = [];
        append('doomed', {});
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(scheduler.events().map((e) => e.type)).toEqual(['plan.applied']);
    const other = openStore(join(root, 'db.sqlite'));
    try {
      const b = new Scheduler({ storage: new WorkflowStore(other), now: clock, nextId });
      scheduler.claim('api');
      expect(() => b.claim('api')).toThrow('尚未就绪');
    } finally {
      other.close();
    }
  });
  it('同一交付事件或重复投递只发布一个版本，重用消息号改变内容会被拒绝', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    scheduler.act(api.id, { type: 'progress', message: '仅供当前任务查看的普通进度' });
    expect(scheduler.readProgress('api')).toBe('仅供当前任务查看的普通进度');
    expect(JSON.stringify(scheduler.events())).not.toContain('仅供当前任务');
    const action = { type: 'publish_artifact', slotId: 'contract', content: 'v1' };
    scheduler.act(api.id, action, 'one');
    scheduler.act(api.id, action, 'one');
    scheduler.act(api.id, action);
    expect(() => scheduler.act(api.id, { ...action, content: 'v2' }, 'one')).toThrow();
    expect(scheduler.board().versions).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM workflow_wakeups').get()?.n).toBe(2);
  });
  it('预览拒绝跨槽钉住和不存在的版本，看板只统计实际等待的下游', () => {
    const spec = demoSpec();
    scheduler.apply(spec);
    expect(scheduler.board().criticalSlot).toBe('contract');
    scheduler.control('tests', 'cancel');
    expect(scheduler.board().slots.find((s) => s.id === 'contract')?.waiting).toEqual(['ui']);
    const changed = structuredClone(spec);
    changed.tasks[1].consumes = [{ slotId: 'contract', policy: 'pinned', version: 'missing' }];
    expect(() => scheduler.preview(changed)).toThrow('版本不存在');
  });
  it('拒绝循环、越权、过期预览和错误的计划，既有状态保持不变', () => {
    const spec = demoSpec();
    const bad = structuredClone(spec);
    bad.tasks[0].consumes = [{ slotId: 'frontend-code', policy: 'latest' }];
    expect(() => scheduler.preview(bad)).toThrow('环');
    expect(scheduler.board().revision).toBe(0);
    expect(scheduler.preview(spec).added).toContain('api');
    scheduler.apply(spec, 0);
    expect(() => scheduler.apply({ ...spec, title: '另一个标题' }, 0)).toThrow('版本');
    const api = scheduler.claim('api');
    expect(() => pub(api.id, 'frontend-code', '越权')).toThrow();
    expect(() => scheduler.act(api.id, { type: 'assign_task', taskId: 'ui', assignee: 'qa' })).toThrow();
    expect(() => scheduler.act(api.id, { type: 'read_file', path: 'unknown' })).toThrow();
    expect(() => scheduler.act(api.id, { type: 'submit_result', summary: '空交付' })).toThrow();
  });
  it('不兼容变更使正在运行和已产出的下游过期，取消后的迟到交付保留记录', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    pub(api.id, 'contract', 'v1');
    const ui = scheduler.claim('ui');
    pub(ui.id, 'frontend-code', '基于 v1');
    submit(ui.id, 'ui');
    const qa = scheduler.claim('tests');
    pub(api.id, 'contract', 'v2', true);
    expect(task('ui')).toMatchObject({ status: 'ready', rework: 1 });
    expect(task('tests')).toMatchObject({ status: 'ready', rework: 1 });
    expect(scheduler.act(qa.id, { type: 'publish_artifact', slotId: 'cases', content: '迟到' })).toEqual({
      obsolete: true,
    });
    expect(scheduler.board().versions.some((v) => v.slotId === 'cases')).toBe(false);
    const ui2 = scheduler.claim('ui');
    scheduler.control('ui', 'cancel');
    scheduler.act(ui2.id, { type: 'submit_result', summary: '迟到' });
    expect(scheduler.events().filter((e) => e.type === 'execution.late')).toHaveLength(2);
    expect(task('ui').status).toBe('cancelled');
  });
  it('传递上游失效会让尚未领取的孙任务重新等待，不会调用缺输入的成员', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    pub(api.id, 'contract', 'v1');
    const ui = scheduler.claim('ui');
    pub(ui.id, 'frontend-code', 'v1 实现');
    expect(task('guide').status).toBe('ready');
    pub(api.id, 'contract', 'v2', true);
    expect(task('guide')).toMatchObject({ status: 'waiting', missing: ['frontend-code'] });
    expect(() => scheduler.claim('guide')).toThrow('尚未就绪');
  });
  it('兼容变更仅提示旧输入，审核途中重启能按同一组输出继续验收', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    pub(api.id, 'contract', '原版');
    const ui = scheduler.claim('ui');
    pub(ui.id, 'frontend-code', '控件');
    scheduler.act(ui.id, { type: 'submit_result', summary: '提交审查' });
    pub(api.id, 'contract', '兼容版');
    expect(scheduler.board().versions.find((v) => v.slotId === 'frontend-code')).toMatchObject({
      stale: false,
      outdatedInputs: ['contract'],
    });
    db.close();
    connect();
    scheduler.recover();
    expect(task('ui').status).toBe('review');
    scheduler.control('ui', 'accept');
    expect(task('ui').status).toBe('done');
  });
  it.each(['failed','cancelled','interrupted','reassigned'] as const)('收件人 %s 时两条阻塞问题产生一份待决定的答复，重启不会再派发', ending => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    pub(api.id, 'contract', 'v1');
    const ui = scheduler.claim('ui');
    for (const question of ['谁负责？','如何验证？'])
      scheduler.act(ui.id,{type:'ask_question',to:'backend',blocking:true,question});
    expect(scheduler.board().tasks.filter(t => t.replyFor)).toHaveLength(0);
    if (ending === 'failed') scheduler.fail(api.id,'fatal');
    if (ending === 'cancelled') scheduler.control('api','cancel');
    if (ending === 'reassigned') scheduler.reassign('api','docs');
    if (ending === 'interrupted') scheduler.recover();
    const replies = scheduler.board().tasks.filter(t => t.replyFor === 'ui');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({status:'decision',owner:'backend'});
    expect(() => scheduler.claim(replies[0].id)).toThrow('尚未就绪');
    scheduler.recover();
    expect(scheduler.board().tasks.filter(t=>t.replyFor)).toHaveLength(1);
    scheduler.control(replies[0].id,'resume');
    expect(scheduler.context(scheduler.claim(replies[0].id).id).questions).toHaveLength(2);
  });
  it('执行中追加的问题交给下一份答复；用户取消该待办后不会重新派发', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    pub(api.id, 'contract', 'v1');
    pub(api.id, 'backend-code', '后端');
    submit(api.id, 'api');
    const ui=scheduler.claim('ui');
    const ask=(text:string) => scheduler.act(ui.id,{type:'ask_question',to:'backend',blocking:true,question:text}) as Question;
    const first=ask('第一个问题');
    const taskId=scheduler.board().tasks.find(t=>t.replyFor==='ui')!.id;
    const replying=scheduler.claim(taskId);
    ask('执行中到达的第二个问题');
    scheduler.act(replying.id,{type:'answer_question',questionId:first.id,answer:'已确认'});
    scheduler.act(replying.id,{type:'submit_result',summary:'已答复首个问题'});
    const next=scheduler.board().tasks.filter(t=>t.replyFor==='ui' && t.status==='ready');
    expect(next).toHaveLength(1);
    scheduler.control(next[0].id,'cancel');
    scheduler.recover();
    expect(scheduler.board().tasks.filter(t=>t.replyFor==='ui')).toHaveLength(2);
    expect(scheduler.board().tasks.filter(t=>t.replyFor==='ui' && t.status==='ready')).toHaveLength(0);
  });
  it('全局停止后维持取消状态，不补发模型任务', () => {
    scheduler.apply(demoSpec());
    const api=scheduler.claim('api'); pub(api.id,'contract','v1');
    scheduler.act(scheduler.claim('ui').id, {type:'ask_question',to:'backend',blocking:true,question:'如何验证？'});
    scheduler.stopAll(); scheduler.recover();
    expect(scheduler.board().tasks.filter(t=>t.replyFor)).toHaveLength(0);
  });
  it('成员结束执行时仍有阻塞问题会安排一次答复，用户消息进入指定成员的下次输入', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api');
    pub(api.id, 'contract', '约定');
    const ui = scheduler.claim('ui');
    scheduler.act(ui.id, { type: 'ask_question', to: 'backend', question: '未分配的值？', blocking: true });
    pub(api.id, 'backend-code', '服务');
    submit(api.id, 'api');
    const reply = scheduler.board().tasks.find((t) => t.replyFor === 'ui')!;
    expect(reply.owner).toBe('backend');
    scheduler.sendAsUser(reply.id, '按之前约定答复');
    const run = scheduler.claim(reply.id);
    expect(scheduler.context(run.id).messages[0].from).toBe('user');
    const q = scheduler.act(run.id, {
      type: 'ask_question',
      to: 'user',
      question: '是否沿用？',
      blocking: true,
    }) as Question;
    scheduler.answerAsUser(q.id, '沿用');
    expect(scheduler.board().questions.find((item) => item.id === q.id)?.status).toBe('answered');
  });
  it('必需审查已绑定执行；上游不兼容使审查重新就绪时同时撤销主卡验收', () => {
    scheduler.apply({
      id: 'review-binding',
      title: '审查',
      goal: '核对版本',
      acceptance: ['已审查'],
      requiredTasks: ['review'],
      requiredSlots: ['independent'],
      agents: ['lead', 'supplier', 'writer'].map((id) => ({ id, name: id, connection: id })),
      slots: ['input', 'independent'].map((id) => ({ id, title: id })),
      tasks: [
        { id: 'up', owner: 'supplier', title: '输入', produces: ['input'] },
        { id: 'review', owner: 'lead', title: '审查', consumes: [{ slotId: 'input' }] },
        { id: 'other', owner: 'writer', title: '独立交付', produces: ['independent'] },
      ],
    });
    const up = scheduler.claim('up');
    pub(up.id, 'input', 'v1');
    const review = scheduler.claim('review');
    submit(review.id, 'review');
    const other = scheduler.claim('other');
    pub(other.id, 'independent', '独立正文');
    submit(other.id, 'other');
    scheduler.accept();
    expect(scheduler.events().at(-1)?.data.acceptedExecutions).toMatchObject({ review: review.id });
    pub(up.id, 'input', 'v2', true);
    expect(task('review').status).toBe('ready');
    expect(scheduler.board().acceptance).toBeNull();
  });
  it('钉住旧版的无产出审查在上游不兼容后撤销验收，旧快照不能重放', () => {
    const spec = demoSpec();
    scheduler.apply(spec);
    const first = scheduler.claim('api');
    const original = pub(first.id, 'contract', 'v1');
    scheduler.control('api', 'pause');
    spec.tasks.find(t => t.id === 'accept')!.consumes = [{ slotId:'contract', policy:'pinned', version:original.id }];
    spec.requiredTasks = ['accept'];
    spec.requiredSlots = [];
    scheduler.apply(spec);
    const review = scheduler.claim('accept');
    scheduler.act(review.id, { type:'submit_result', summary:'核对 v1' });
    expect(() => scheduler.control('accept','accept','previous-execution')).toThrow('待审执行已改变');
    scheduler.control('accept','accept',review.id);
    const snapshot = scheduler.board().acceptanceCandidate!;
    expect(snapshot.executions).toEqual({accept:review.id});
    expect(() => scheduler.accept({...snapshot, revision:snapshot.revision-1})).toThrow('快照已改变');
    scheduler.accept(snapshot);
    scheduler.control('api','resume');
    pub(scheduler.claim('api').id,'contract','v2',true);
    expect(task('accept').status).toBe('done');
    expect(scheduler.board().acceptedSnapshot).toBeNull();
    expect(() => scheduler.accept(snapshot)).toThrow('审查的输入已过期');
  });
  it('钉住旧版的任务可继续运行，但基于不兼容旧输入的快照不能验收', () => {
    const spec = demoSpec();
    scheduler.apply(spec);
    const api = scheduler.claim('api'),
      v = pub(api.id, 'contract', 'v1');
    scheduler.control('api', 'pause');
    const uiSpec = spec.tasks.find((t) => t.id === 'ui')!;
    uiSpec.consumes = [{ slotId: 'contract', policy: 'pinned', version: v.id }];
    spec.requiredSlots = ['frontend-code'];
    scheduler.apply(spec);
    scheduler.control('api', 'resume');
    const api2 = scheduler.claim('api'),
      ui = scheduler.claim('ui');
    pub(api2.id, 'contract', 'v2', true);
    expect(task('ui').status).toBe('running');
    pub(ui.id, 'frontend-code', '旧版输入');
    submit(ui.id, 'ui');
    expect(() => scheduler.accept()).toThrow('过期');
  });
  it('共享池限流只暂停本池，预算用尽转等待用户，用户增额后手动恢复', () => {
    const spec = demoSpec();
    spec.agents.find((a) => a.id === 'qa')!.pool = 'shared';
    spec.agents.find((a) => a.id === 'frontend')!.pool = 'shared';
    spec.tasks[0].maxCalls = 1;
    scheduler.apply(spec);
    const api = scheduler.claim('api');
    pub(api.id, 'contract', 'v1');
    const ui = scheduler.claim('ui');
    expect(() => scheduler.claim('tests')).toThrow('额度池');
    scheduler.fail(ui.id, 'rate_limit');
    expect(() => scheduler.claim('tests')).toThrow('额度池');
    expect(() => scheduler.reserveCall(api.id)).toThrow('预算');
    expect(task('api').status).toBe('decision');
    spec.tasks[0].maxCalls = 3;
    scheduler.apply(spec);
    scheduler.control('api', 'resume');
    const retried = scheduler.claim('api');
    expect(retried.connection).toBe('mock-backend');
    scheduler.recordUsage(retried.id, { inputTokens: 3 });
    expect(scheduler.board().executions.at(-1)?.usage).toEqual({ input: 3 });
    scheduler.resumePool('shared');
    expect(scheduler.claim('tests').pool).toBe('shared');
  });
  it('同一卡同一收件人的阻塞问题合并为一次答复执行，跳数超限交给负责人', () => {
    const spec = demoSpec();
    spec.maxHops = 1;
    scheduler.apply(spec);
    const api = scheduler.claim('api');
    const ask = (id: string, to: string, replyTo?: string) =>
      scheduler.act(id, {
        type: 'ask_question',
        to,
        question: '请澄清',
        blocking: true,
        replyTo,
      }) as Question;
    const q = ask(api.id, 'frontend');
    ask(api.id, 'frontend');
    const replies = scheduler.board().tasks.filter((t) => t.replyFor === 'api');
    expect(replies).toHaveLength(1);
    const answer = scheduler.claim(replies[0].id);
    expect(scheduler.context(answer.id).questions).toHaveLength(2);
    expect(ask(answer.id, 'backend', q.id).to).toBe('lead');
    expect(() =>
      scheduler.act(api.id, { type: 'answer_question', questionId: q.id, answer: '越权' }),
    ).toThrow();
  });
  it('冲突按稳定标识一次投递到对应任务，其他成员的收件箱不受影响', () => {
    runDemo(scheduler);
    const issue = { id: 'safe-snapshot', taskIds: ['api', 'ui'], paths: ['src/main.ts'] };
    expect(scheduler.reportConflict(issue)).toEqual({ duplicate: false });
    expect(scheduler.reportConflict({ ...issue, taskIds: ['ui', 'api'] })).toEqual({ duplicate: true });
    expect(() => scheduler.reportConflict({ ...issue, paths: ['src/changed.ts'] })).toThrow();
    const board = scheduler.board();
    expect(board.questions.filter((q) => q.from === 'integration').map((q) => q.to)).toEqual([
      'backend',
      'frontend',
    ]);
    expect(board.acceptance).toBeNull();
  });
  it('禁止成员读取未绑定交付物或跳到同一槽位其他版本；幂等回执中的正文也只保存摘要', () => {
    scheduler.apply(demoSpec());
    const api = scheduler.claim('api'),
      v1 = pub(api.id, 'contract', '已绑定的内容');
    const ui = scheduler.claim('ui'),
      v2 = pub(api.id, 'contract', '更新内容');
    expect(() => scheduler.act(ui.id, { type: 'read_artifact', slotId: 'backend-code' })).toThrow('无权');
    expect(() =>
      scheduler.act(ui.id, { type: 'read_artifact', slotId: 'contract', versionId: v2.id }),
    ).toThrow('绑定');
    const read = { type: 'read_artifact', slotId: 'contract', versionId: v1.id };
    const result = scheduler.act(ui.id, read, 'read-once');
    expect(scheduler.act(ui.id, read, 'read-once')).toEqual(result);
    const row = db.prepare('SELECT data FROM workflow_state').get()!;
    expect(String(row.data)).not.toContain('已绑定的内容');
  });
  it('批准前显示移除的预算上限以及任务从哪个岗位转给哪个岗位', () => {
    const prior = { ...demoSpec(), maxTokens: 12000 };
    scheduler.apply(prior);
    const changed = demoSpec();
    const task = changed.tasks.find(task => task.id === 'api')!;
    const original = task.owner;
    task.owner = changed.agents.find(agent => agent.id !== original)!.id;
    const diff = scheduler.preview(changed);
    expect(diff.settings).toContainEqual({ field: 'maxTokens', before: 12000, after: null });
    expect(diff.taskChanges).toContainEqual({
      id: task.id, before: expect.objectContaining({ owner: original }), after: expect.objectContaining({ owner: task.owner })
    });
    expect(scheduler.board().spec?.maxTokens).toBe(12000);
  });
  it('不足以覆盖估算时禁止下一次调用，完整用量可结算估算，同一轮累计用量不会重复计算', () => {
    const spec = demoSpec();
    spec.maxTokens = 15;
    spec.estimatedTokensPerCall = 10;
    scheduler.apply(spec);
    const api = scheduler.claim('api');
    scheduler.recordUsage(api.id, { inputTokens: 2, outputTokens: 3 });
    scheduler.recordUsage(api.id, { inputTokens: 2, outputTokens: 3 });
    expect(scheduler.board().executions[0].usage).toEqual({ input: 2, output: 3 });
    scheduler.reserveCall(api.id);
    expect(() => scheduler.reserveCall(api.id)).toThrow('预算');
    expect(task('api').status).toBe('decision');
  });
  it('合成连接池与同名共享池独立，禁止特殊发件人、原型名称和原型池名', () => {
    const spec = parallelSpec('测试', ['a', 'b']);
    spec.agents[1].pool = 'a';
    spec.poolLimits = { 'connection:a': 1, a: 1 };
    scheduler.apply(spec);
    expect(scheduler.claim('work-0').pool).toBe('connection:a');
    expect(scheduler.claim('work-1').pool).toBe('a');
    expect(() =>
      scheduler.preview({
        ...spec,
        agents: spec.agents.map((a) => ({ ...a, pool: 'connection:constructor' })),
      }),
    ).toThrow();
    expect(() => meetingSpec('讨论', ['user'])).toThrow();
  });
  it('并行方案彼此隔离，比较任务等待全部方案；审查任务等待初稿，修改任务等待全部意见', () => {
    const parallel = parallelSpec('比较设计', ['a', 'b'], 'c');
    scheduler.apply(parallel);
    expect(task('compare').status).toBe('waiting');
    for (const item of ['0', '1']) {
      const round = scheduler.claim('work-' + item);
      pub(round.id, 'option-' + item, '方案' + item);
      submit(round.id, round.taskId);
    }
    expect(task('compare').status).toBe('ready');
    scheduler.apply(reviewSpec('审查设计', 'p', ['one', 'two']));
    const producer = scheduler.claim('produce');
    pub(producer.id, 'draft', '初稿');
    expect(task('review-0').status).toBe('ready');
    expect(task('revise').status).toBe('waiting');
    for (const item of ['0', '1']) {
      const round = scheduler.claim('review-' + item);
      pub(round.id, 'feedback-' + item, '意见' + item);
    }
    expect(task('revise').status).toBe('ready');
  });
  it('会议使用同一调度器，新计划保留既有工作区与快照', () => {
    const previous = runDemo(scheduler);
    const plan = meetingSpec('讨论版本', ['a', 'b']);
    scheduler.apply(plan);
    expect(scheduler.board().tasks[0].status).toBe('ready');
    const a = scheduler.claim('turn-0');
    pub(a.id, 'statement-0', '第一条发言');
    submit(a.id, 'turn-0');
    expect(task('turn-1').status).toBe('ready');
    scheduler.switchWorkspace(previous.spec!.id);
    expect(scheduler.board().acceptance).toEqual(previous.acceptance);
    expect(scheduler.board().archives[0].id).toBe('meeting');
  });
});

it('大文本可按绑定版本和 Unicode 码点分页；不能取阅时保留内联或在派发前拒绝', () => {
  scheduler.apply({...demoSpec(), maxContextTokens:3000});
  const api = scheduler.claim('api', undefined, { deferCall:true });
  expect(api.calls).toBe(0);
  scheduler.reserveCall(api.id, 'not-sent');
  scheduler.refundUnstartedCall(api.id,'wrong');
  expect(scheduler.board().executions[0].calls).toBe(1);
  scheduler.refundUnstartedCall(api.id,'not-sent');
  scheduler.refundUnstartedCall(api.id,'not-sent');
  expect(scheduler.board().executions[0].calls).toBe(0);
  const content = '🙂接口'.repeat(2000);
  const version = pub(api.id,'contract',content);
  expect(() => scheduler.claim('ui')).toThrow(/上下文限制/);
  const ui = scheduler.claim('ui', undefined, { readArtifacts:true, deferCall:true });
  expect(scheduler.context(ui.id).inputs.contract).toEqual({ versionId:version.id, utf8Bytes:Buffer.byteLength(content), readWith:'read_artifact' });
  const read = (offset:number) => scheduler.act(ui.id,{type:'read_artifact',slotId:'contract',versionId:version.id,offset,limit:4});
  expect(read(0)).toMatchObject({content:'🙂接口🙂',nextOffset:4});
  expect(read(4)).toMatchObject({content:'接口🙂接',nextOffset:8});
  expect(scheduler.act(ui.id,{type:'read_artifact',slotId:'contract'})).toHaveProperty('nextOffset',2048);
  expect(() => scheduler.act(ui.id,{type:'read_artifact',slotId:'contract',versionId:'unbound'})).toThrow(/绑定/);
});
