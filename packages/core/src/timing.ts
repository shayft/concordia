import { inputsFor, type State, type Task } from './state.ts';

type Blocker = { slotId: string; owner: string | null };
export type WaitInterval = {
  kind: 'waiting' | 'ready' | 'review';
  start: number | null;
  end: number | null;
  blockedBy: Blocker[];
};
export type WaitHistory = { complete: boolean; approvalTracked?: boolean; intervals: WaitInterval[] };

function currentInterval(task: Task, state: State, start: number | null): WaitInterval | undefined {
  if (task.status === 'ready' || task.status === 'review') return { kind: task.status, start, end: null, blockedBy: [] };
  if (task.status !== 'waiting') return;
  const inputs = inputsFor(task, state);
  const blockedBy = task.consumes
    .filter((c) => !inputs[c.slotId])
    .map(({ slotId }) => ({
      slotId,
      owner: state.tasks.find((t) => t.produces.includes(slotId))?.owner ?? null,
    }));
  return { kind: 'waiting', start, end: null, blockedBy };
}

/** Existing rows have no trustworthy creation time. Preserve that uncertainty across subsequent transitions. */
function legacyHistory(task: Task, state: State): WaitHistory {
  const current = currentInterval(task, state, null);
  return { complete: false, intervals: current ? [current] : [] };
}

export function captureLegacyWaits(state: State) {
  for (const task of state.tasks) task.waitHistory ??= legacyHistory(task, state);
}

export function recordWaits(state: State, now: number) {
  for (const task of state.tasks) {
    const history = (task.waitHistory ??= legacyHistory(task, state));
    const last = history.intervals.at(-1);
    // Keep intervals nonnegative even if the wall clock moves backwards.
    const time = Math.max(now, last?.end ?? last?.start ?? now);
    const next = currentInterval(task, state, time);
    if (last && last.end === null) {
      if (
        next?.kind === last.kind &&
        next.blockedBy.length === last.blockedBy.length &&
        next.blockedBy.every(
          (entry, i) => entry.slotId === last.blockedBy[i].slotId && entry.owner === last.blockedBy[i].owner,
        )
      )
        continue;
      last.end = time;
    }
    if (next) history.intervals.push(next);
  }
}

export function waitTime(task: Task, state: State, now: number) {
  const history = task.waitHistory ?? legacyHistory(task, state);
  let dependencyMs = 0,
    queueMs = 0,
    approvalMs = 0;
  for (const interval of history.intervals) {
    if (interval.start === null) continue;
    const duration = Math.max(0, (interval.end ?? now) - interval.start);
    if (interval.kind === 'waiting') dependencyMs += duration;
    else if (interval.kind === 'ready') queueMs += duration;
    else approvalMs += duration;
  }
  return { ...history, dependencyMs, queueMs, approvalMs, observedAt: now };
}
