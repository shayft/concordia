import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { demoSpec, Scheduler } from '@concordia/core/workflow';
import { openStore } from '../src/index.ts';
import { WorkflowStore } from '../src/workflow.ts';

it('改派使旧执行失效，新成员按版本返工并通过审查', () => {
  const directory = mkdtempSync(join(tmpdir(), 'concordia-reassign-'));
  const database = openStore(join(directory, 'workflow.sqlite'));
  try {
    const scheduler = new Scheduler({
      storage: new WorkflowStore(database),
      nextId: randomUUID,
      now: Date.now,
    });
    scheduler.apply(demoSpec());
    const first = scheduler.claim('api');
    scheduler.reassign('api', 'frontend');
    scheduler.act(first.id, { type: 'publish_artifact', slotId: 'contract', content: '迟到版本' });
    expect(scheduler.board().versions).toHaveLength(0);
    const next = scheduler.claim('api');
    expect(next.owner).toBe('frontend');
    function deliver(id: string, text: string) {
      for (const slotId of ['contract', 'backend-code'])
        scheduler.act(id, { type: 'publish_artifact', slotId, content: text });
      scheduler.act(id, { type: 'submit_result', summary: text });
    }
    deliver(next.id, 'v1');
    scheduler.control('api', 'rework');
    const rework = scheduler.claim('api');
    deliver(rework.id, 'v2');
    scheduler.control('api', 'accept');
    const board = scheduler.board();
    expect(board.tasks.find((task) => task.id === 'api')).toMatchObject({
      owner: 'frontend',
      status: 'done',
      rework: 1,
    });
    expect(board.versions.filter((item) => item.slotId === 'contract').map((item) => item.number)).toEqual([
      1, 2,
    ]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
