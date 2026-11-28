import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkflowStore } from '@concordia/store/workflow';
import { recordDecision } from '../src/governance.ts';
import { Scheduler } from '@concordia/core/workflow';
import { openStore } from '@concordia/store';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';

it.each(['insert', 'update'] as const)(
  '模拟批次遇到审计 %s 写失败时释放任务，重启后按归档执行对账',
  async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'concordia-audit-fault-'));
    const data = join(root, 'data'),
      web = join(root, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<title>test</title>');
    let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    try {
      server = await startLocalServer(web, data);
      const browser = await browserSession(new URL(server.launchUrl));
      const spec = {
        id: 'first',
        title: '排班',
        goal: '核对失败的审计写入',
        acceptance: ['交付物可回读'],
        agents: ['a', 'b'].map((id) => ({ id, name: id, connection: 'mock-' + id })),
        slots: [{ id: 'out', title: '模拟成果' }],
        tasks: [
          { id: 'one', title: '第一张卡', owner: 'a', produces: ['out'] },
          {
            id: 'two',
            title: '第二张卡',
            owner: 'b',
            consumes: failure === 'insert' ? [] : [{ slotId: 'out' }],
          },
        ],
      };
      expect(
        (await browser.post('/api/spec/apply', { spec, expectedRevision: 0, approved: true })).status,
      ).toBe(200);
      const catalog = openStore(join(data, 'catalog.sqlite'));
      let executionId: string;
      try {
        catalog.exec(`CREATE TRIGGER simulate_audit_fault BEFORE ${failure} ON approved_executions
        BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END`);
        expect((await browser.post('/api/dispatch', { approved: true, maxCalls: 2 })).status).toBe(200);
        const board = () =>
          browser.get('/api/board').then((r) => r.json()) as Promise<ReturnType<Scheduler['board']>>;
        await vi.waitFor(async () =>
          expect((await board()).tasks[0].status).toBe(failure === 'insert' ? 'failed' : 'review'),
        );
        const state = await board();
        expect(state.executions).toHaveLength(1);
        expect(state.tasks[1].status).toBe('ready');
        expect(state.executions[0].calls).toBe(failure === 'insert' ? 0 : 1);
        expect(state.executions[0].approvalId).toBeTruthy();
        executionId = state.executions[0].id;
        const record = catalog
          .prepare('SELECT status FROM approved_executions WHERE execution=?')
          .get(executionId);
        expect(record?.status).toBe(failure === 'insert' ? undefined : 'running');
        // Archiving also proves that neither the batch nor the worker remains occupied.
        expect(
          (
            await browser.post('/api/spec/apply', {
              spec: { ...spec, id: 'other' },
              expectedRevision: 1,
              approved: true,
            })
          ).status,
        ).toBe(200);
        catalog.exec('DROP TRIGGER simulate_audit_fault');
      } finally {
        catalog.close();
      }
      await server.close();
      server = await startLocalServer(web, data);
      const reopened = await browserSession(new URL(server.launchUrl));
      const audit = await (await reopened.get('/api/governance')).json();
      const grants = audit.items.filter((row: { action: string }) => row.action === 'approval.granted');
      expect(grants).toMatchObject([
        {
          calls: [],
          executions: [{ execution: executionId, status: failure === 'insert' ? 'failed' : 'success' }],
        },
      ]);
      const active = await (await reopened.get('/api/board')).json();
      expect(active.spec.id).toBe('other');
      expect(active.executions).toEqual([]);
    } finally {
      try {
        await server?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  15_000,
);

it('重启时将旧版活动执行对账为已中断，重复打开保留原审批且不重新派发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'concordia-audit-interruption-'));
  const data = join(root, 'data'),
    web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<title>test</title>');
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    server = await startLocalServer(web, data);
    await server.close();
    server = undefined;
    const catalog = openStore(join(data, 'catalog.sqlite'));
    const board = openStore(join(data, 'boards', 'default', 'workspace.sqlite'));
    let grant: string, execution: string;
    try {
      const scheduler = new Scheduler({
        storage: new WorkflowStore(board),
        now: Date.now,
        nextId: randomUUID,
      });
      scheduler.apply({
        id: 'restart',
        title: '恢复',
        goal: '核实审批',
        acceptance: ['完成'],
        agents: [{ id: 'lead', name: '负责', connection: 'mock-lead' }],
        tasks: [{ id: 'one', title: '执行', owner: 'lead' }],
      });
      grant = recordDecision(catalog, 'approval.granted', 'default', { purpose: 'dispatch' });
      // Simulate a process that stopped after claiming an execution under an older board schema.
      execution = scheduler.claim('one', undefined, { deferCall: true }).id;
      catalog.prepare("INSERT INTO approved_executions VALUES(?,?,'running')").run(execution, grant);
    } finally {
      board.close();
      catalog.close();
    }
    for (let i = 0; i < 2; i++) {
      server = await startLocalServer(web, data);
      const browser = await browserSession(new URL(server.launchUrl));
      const audit = await (await browser.get('/api/governance')).json();
      expect(audit.items).toMatchObject([
        { id: grant, calls: [], executions: [{ execution, status: 'interrupted' }] },
      ]);
      const state = await (await browser.get('/api/board')).json();
      expect(state.tasks[0].status).toBe('decision');
      expect(state.executions).toHaveLength(1);
      await server.close();
      server = undefined;
    }
  } finally {
    try {
      await server?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 15_000);
