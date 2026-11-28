import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoSpec, Scheduler } from '@concordia/core/workflow';
import type { WaitInterval } from '@concordia/core/timing';
import { openStore } from '@concordia/store';
import { WorkflowStore } from '@concordia/store/workflow';

const taskMs: Record<string, number> = {
  api: 9000,
  ui: 6000,
  tests: 4000,
  integrate: 3000,
  guide: 1000,
  accept: 2000,
};
const approvalLagMs = 1000;

function elapsedUnion(intervals: WaitInterval[], kind: WaitInterval['kind']) {
  const known = intervals
    .flatMap((i) =>
      i.kind === kind && i.start !== null && i.end !== null ? [[i.start, i.end] as const] : [],
    )
    .sort((a, b) => a[0] - b[0]);
  let end = -Infinity,
    total = 0;
  for (const [start, finish] of known) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
}

export function rehearse(mode: 'serial' | 'parallel' | 'early', optionalGuideMs = taskMs.guide) {
  const durations = { ...taskMs, guide: optionalGuideMs } as Record<string, number>;
  const mainConfirmationLagMs = 1000;
  const directory = mkdtempSync(join(tmpdir(), 'concordia-comparison-'));
  const db = openStore(join(directory, 'board.sqlite'));
  try {
    let now = 0,
      id = 0;
    const scheduler = new Scheduler({
      storage: new WorkflowStore(db),
      now: () => now,
      nextId: () => 'id-' + ++id,
    });
    scheduler.apply(demoSpec());
    let firstAcceptableMs: number | undefined,
      confirmedMs: number | undefined,
      allCardsFinishedMs: number | undefined;
    let accepted: Record<string, string> | undefined;
    const changes: { time: number; action: () => void }[] = [];
    const after = (delay: number, action: () => void) => changes.push({ time: now + delay, action });
    for (;;) {
      const board = scheduler.board();
      const candidate = board.acceptanceCandidate;
      if (candidate && firstAcceptableMs === undefined) {
        firstAcceptableMs = now;
        after(mainConfirmationLagMs, () => {
          accepted = scheduler.accept(candidate);
          confirmedMs = now;
        });
      }
      if (allCardsFinishedMs === undefined && board.tasks.every((t) => t.status === 'done'))
        allCardsFinishedMs = now;
      const occupied = new Set(board.executions.filter((e) => e.status === 'running').map((e) => e.owner));
      for (const task of board.tasks) {
        if (task.status !== 'ready' || occupied.has(task.owner) || (mode === 'serial' && occupied.size))
          continue;
        const exec = scheduler.claim(task.id);
        occupied.add(task.owner);
        const publish = (slotId: string) =>
          scheduler.act(exec.id, {
            type: 'publish_artifact',
            slotId,
            content: slotId + ' 模拟验收内容',
          });
        for (const slot of task.produces) {
          const delay = mode === 'early' && slot === 'contract' ? 2000 : durations[task.id];
          after(delay, () => publish(slot));
        }
        after(durations[task.id], () => {
          scheduler.act(exec.id, { type: 'submit_result', summary: '交付完成' });
          after(approvalLagMs, () => scheduler.control(task.id, 'accept', exec.id));
        });
      }
      if (!changes.length) break;
      changes.sort((a, b) => a.time - b.time);
      now = changes[0].time;
      while (changes[0]?.time === now) changes.shift()!.action();
    }
    if (
      !accepted ||
      firstAcceptableMs === undefined ||
      confirmedMs === undefined ||
      allCardsFinishedMs === undefined
    )
      throw new Error('模拟计划没有完成全部里程碑');
    const board = scheduler.board();
    const intervals = board.tasks.flatMap((t) => t.waitTime.intervals);
    const acceptedContents = Object.fromEntries(
      Object.entries(accepted).map(([slot, version]) => [slot, scheduler.readVersion(version).content]),
    );
    return {
      elapsedMs: allCardsFinishedMs,
      firstAcceptableMs,
      confirmedMs,
      allCardsFinishedMs,
      dependencyWallMs: elapsedUnion(intervals, 'waiting'),
      queueWallMs: elapsedUnion(intervals, 'ready'),
      approvalWallMs: elapsedUnion(intervals, 'review'),
      calls: board.executions.reduce((sum, e) => sum + e.calls, 0),
      taskStarts: Object.fromEntries(board.executions.map((e) => [e.taskId, e.started])),
      acceptedContents,
      acceptance: board.spec!.acceptance,
    };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(
    JSON.stringify(
      {
        clock: '模拟毫秒',
        taskMs,
        approvalLagMs,
        serial: rehearse('serial'),
        parallel: rehearse('parallel'),
        early: rehearse('early'),
        optionalGuide60s: rehearse('early', 60_000),
      },
      null,
      2,
    ),
  );
}
