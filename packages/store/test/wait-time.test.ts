import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { demoSpec, Scheduler } from '@concordia/core/workflow';
import { openStore } from '../src/index.ts';
import { WorkflowStore } from '../src/workflow.ts';

let root: string;
let close: () => void;
let storage: WorkflowStore;
let scheduler: Scheduler;
let now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'concordia-waits-'));
  const db = openStore(join(root, 'board.sqlite'));
  close = () => db.close();
  storage = new WorkflowStore(db);
  now = 1000;
  let ids = 0;
  scheduler = new Scheduler({ storage, now: () => now, nextId: () => String(++ids) });
  scheduler.apply(demoSpec());
});
afterEach(() => {
  close();
  rmSync(root, { recursive: true, force: true });
});
const waits = (id: string) => scheduler.board().tasks.find((t) => t.id === id)!.waitTime;

it('分别累计等待依赖及排队时长，暂停和执行时间排除，运行中普通进度不影响时长', () => {
  now = 2000;
  const api = scheduler.claim('api');
  expect(waits('api').queueMs).toBe(1000);
  now = 3500;
  scheduler.act(api.id, { type: 'publish_artifact', slotId: 'contract', content: '约定' });
  now = 4000;
  scheduler.control('ui', 'pause');
  now = 9000;
  expect(waits('ui')).toMatchObject({
    complete: true,
    dependencyMs: 2500,
    queueMs: 500,
    intervals: [
      { kind: 'waiting', start: 1000, end: 3500, blockedBy: [{ slotId: 'contract', owner: 'backend' }] },
      { kind: 'ready', start: 3500, end: 4000, blockedBy: [] },
    ],
  });
  scheduler.control('ui', 'resume');
  now = 9200;
  const ui = scheduler.claim('ui');
  now = 20000;
  scheduler.act(ui.id, { type: 'progress', message: '接口已联通' });
  expect(waits('ui').queueMs).toBe(700);
  expect(waits('ui').dependencyMs).toBe(2500);
  expect(scheduler.readProgress('ui')).toBe('接口已联通');
});

it('部分依赖满足时分割等待区间，旧数据的未知开始时间不会补成零', () => {
  storage.transaction((s) => {
    delete s.tasks.find((task) => task.id === 'integrate')!.waitHistory;
  });
  now = 4000;
  expect(waits('integrate')).toMatchObject({ complete: false, intervals: [{ start: null, end: null }] });
  const api = scheduler.claim('api');
  now = 5000;
  scheduler.act(api.id, { type: 'publish_artifact', slotId: 'backend-code', content: '实现' });
  now = 6200;
  const current = waits('integrate');
  expect(current.complete).toBe(false);
  expect(current.intervals.map((i) => [i.start, i.end, i.blockedBy.map((b) => b.slotId)])).toEqual([
    [null, 5000, ['backend-code', 'frontend-code', 'cases']],
    [5000, null, ['frontend-code', 'cases']],
  ]);
  expect(current.dependencyMs).toBe(1200);
});
