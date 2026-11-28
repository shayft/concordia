import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openStore } from '@concordia/store';
import { WorkflowStore } from '@concordia/store/workflow';
import { Scheduler } from '@concordia/core/workflow';
import { eventPage, historyQuery, streamHistory } from '../src/event-history.ts';

it('100 张卡和一万条事件按游标有界读取，慢订阅从排空后第一条未发送事件继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concordia-load-'));
  const db = openStore(join(dir, 'board.sqlite'));
  let stop: (() => void) | undefined;
  try {
    const board = new Scheduler({ storage: new WorkflowStore(db), now: () => 100, nextId: () => 'unused' });
    board.apply({ id:'load', title:'受控负载', goal:'记录读写耗时', acceptance:['完成'],
      agents:[{id:'a', name:'A', connection:'mock-a'}],
      tasks:Array.from({length:100}, (_, i) => ({id:'t' + i, title:'卡片 ' + i, owner:'a'})) });
    const beforeWrite = performance.now();
    const store = new WorkflowStore(db);
    store.transaction((_, append) => {
      for (let i = 0; i < 10_000; i++) append('task.progress', {taskId:'t' + i % 100});
    });
    const writeMs = performance.now() - beforeWrite;
    const beforeRead = performance.now();
    expect(board.board().tasks).toHaveLength(100);
    const boardMs = performance.now() - beforeRead;
    const start = performance.now();
    const latest = eventPage(db, historyQuery.parse({}));
    const readMs = performance.now() - start;
    const last = latest.events.at(-1)!.seq;
    expect(latest.hasMore).toBe(true);
    expect(latest.events.map(e => e.seq)).toEqual(Array.from({length:100}, (_, i) => last - 99 + i));
    const prior = eventPage(db, {before:latest.events[0].seq, limit:100});
    expect(prior.events.at(-1)!.seq + 1).toBe(latest.events[0].seq);
    expect(eventPage(db,{after:last-2,limit:2})).toMatchObject({hasMore:false,events:[{seq:last-1},{seq:last}]});
    expect(historyQuery.safeParse({before:3,after:2}).success).toBe(false);
    expect(historyQuery.safeParse({limit:201}).success).toBe(false);

    const seq: number[] = [];
    const output = Object.assign(new EventEmitter(), {
      destroyed:false, writableEnded:false, end:vi.fn(), write(frame: string) {
        seq.push(Number(/^id: (\d+)/.exec(frame)![1]));
        return seq.length !== 1;
      },
    });
    const closed = vi.fn();
    stop = streamHistory(output as unknown as ServerResponse, db, last - 105, closed);
    await vi.waitFor(() => expect(seq).toHaveLength(1));
    expect(output.listenerCount('drain')).toBe(1);
    output.emit('drain');
    await vi.waitFor(() => expect(seq).toHaveLength(105));
    expect(seq).toEqual(Array.from({length:105}, (_, i) => last - 104 + i));
    stop(); stop();
    expect(closed).toHaveBeenCalledTimes(1);
    console.info('100 cards, 10000 seeded events: ' + JSON.stringify({writeMs, boardMs, latestPageMs:readMs}));
  } finally {
    stop?.(); db.close(); rmSync(dir, {recursive:true,force:true});
  }
});
