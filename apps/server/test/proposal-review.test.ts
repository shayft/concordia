import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Scheduler } from '@concordia/core/workflow';
import { openStore } from '@concordia/store';
import { WorkflowStore } from '@concordia/store/workflow';
import { browserSession } from './browser-session.ts';
import { startLocalServer } from '../src/local-server.ts';

it('负责人提议先排队，重启后仍能按所见快照分别批准和拒绝，重复提交只应用一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concordia-proposals-')), data = join(dir,'data');
  mkdirSync(join(dir,'assets'));
  writeFileSync(join(dir,'index.html'), '<title>Concordia</title>');
  let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    app = await startLocalServer(dir, data);
    await app.close(); app = undefined;
    const db = openStore(join(data,'boards','default','workspace.sqlite'));
    const create = { type:'create_task', taskId:'new', description:'新增交付'.repeat(150), assignee:'member' };
    const assign = { type:'assign_task', taskId:'target', assignee:'lead' };
    let createId: string, assignId: string;
    try {
      const storage = new WorkflowStore(db), scheduler = new Scheduler({storage, now:Date.now, nextId:randomUUID});
      scheduler.apply({id:'workflow', title:'分工', goal:'审查分工', acceptance:['完成'],
        agents:[{id:'lead', role:'lead', name:'负责人', connection:'mock-lead'},
          {id:'member', name:'成员', connection:'mock-member'}],
        tasks:[{id:'plan',title:'规划',owner:'lead'},{id:'target',title:'交付',owner:'member'}]});
      const job = scheduler.claim('plan'), target = scheduler.claim('target');
      createId = (scheduler.act(job.id, create, 'first') as {proposalId:string}).proposalId;
      expect(scheduler.act(job.id, create)).toMatchObject({proposalId:createId});
      expect(scheduler.act(job.id, create, 'first')).toMatchObject({proposalId:createId});
      expect(() => scheduler.act(target.id, create)).toThrow('只有负责人');
      assignId = (scheduler.act(job.id, assign) as {proposalId:string}).proposalId;
      const queued = scheduler.previewProposal(assignId);
      expect(queued.queued).toBe(true);
      expect(() => scheduler.decideProposal(assignId,'approved',queued.stamp)).toThrow('暂停');
      scheduler.control('target','pause');
      expect(() => scheduler.decideProposal(assignId,'approved',queued.stamp)).toThrow('重新预览');
      expect(scheduler.board().tasks).toHaveLength(2);
      // Old persisted proposals lack IDs, revisions and decisions.
      storage.transaction(state => state.proposals.push({ executionId:job.id, action:create }));
    } finally { db.close(); }
    app = await startLocalServer(dir,data);
    let ui = await browserSession(new URL(app.launchUrl));
    const preview = async (id: string) => (await ui.post('/api/proposals/'+id+'/preview',{})).json() as Promise<ReturnType<Scheduler['previewProposal']>>;
    const decide = (id: string, expected: ReturnType<Scheduler['previewProposal']>['stamp'], decision='approved') =>
      ui.post('/api/proposals/'+id+'/decide',{expected,decision});
    const creating = await preview(createId), assigning = await preview(assignId);
    expect(creating.diff?.added).toEqual(['new']);
    expect(creating.diff?.spec.tasks.find(t => t.id === 'new')?.description).toBe(create.description);
    expect(creating.queued).toBe(false);
    expect(assigning.diff?.taskChanges[0]).toMatchObject({id:'target',before:{owner:'member'},after:{owner:'lead'}});
    expect((await decide(createId, {...creating.stamp,planId:'other'})).status).toBe(409);
    expect((await decide(assignId, creating.stamp)).status).toBe(409);
    expect((await decide(createId, creating.stamp)).status).toBe(200);
    expect((await decide(assignId, assigning.stamp)).status).toBe(409);
    const current = await preview(assignId);
    expect((await decide(assignId,current.stamp)).status).toBe(200);
    let board = await (await ui.get('/api/board')).json() as ReturnType<Scheduler['board']>;
    expect(board.tasks.find(t => t.id === 'target')).toMatchObject({owner:'lead',status:'ready'});
    const old = board.proposals.find(p => p.submittedRevision === null)!;
    const conflicting = await preview(old.id);
    expect(conflicting.diff).toBeNull();
    expect(conflicting.blocker).toBe('提议的任务编号已存在');
    expect((await decide(old.id,conflicting.stamp)).status).toBe(409);
    expect((await decide(old.id,conflicting.stamp,'rejected')).status).toBe(200);
    await app.close();
    app = await startLocalServer(dir,data);
    ui = await browserSession(new URL(app.launchUrl));
    expect((await decide(createId,creating.stamp)).status).toBe(200);
    expect((await decide(createId,creating.stamp,'rejected')).status).toBe(409);
    expect((await decide(old.id,conflicting.stamp,'rejected')).status).toBe(200);
    board = await (await ui.get('/api/board')).json() as ReturnType<Scheduler['board']>;
    expect(board.revision).toBe(3);
    expect(board.tasks.map(t => t.id)).toEqual(['plan','target','new']);
    expect(board.proposals.map(p => p.status)).toEqual(['approved','approved','rejected']);
  } finally { try { await app?.close(); } finally { rmSync(dir,{recursive:true,force:true}); } }
}, 20_000);
