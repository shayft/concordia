import type { WaitHistory } from './timing.ts';
import type { ModelSnapshot } from '@concordia/protocol/pricing';
import type { CallMeter } from './budget.ts';
import type { AcceptanceSnapshot, TaskSpec, WorkflowSpec } from '@concordia/protocol/workflow';

export type TaskStatus =
  | 'waiting'
  | 'ready'
  | 'running'
  | 'decision'
  | 'review'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';
export type Column = 'waiting' | 'doing' | 'review' | 'done';
export type Control = 'cancel' | 'pause' | 'resume' | 'retry' | 'accept' | 'rework';
export type Failure = 'auth' | 'rate_limit' | 'budget' | 'transient' | 'fatal' | 'permission';
export interface Task extends TaskSpec {
  status: TaskStatus;
  previous: Column;
  waitHistory?: WaitHistory;
  rework: number;
  retries: number;
  active?: string;
  progressRef?: string;
  acceptedExecution?: string;
  reason?: string;
  replyFor?: string;
}
export interface Execution {
  modelSnapshot?: ModelSnapshot;
  id: string;
  taskId: string;
  owner: string;
  connection: string;
  pool: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  contextRef: string;
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted' | 'obsolete';
  started: number;
  ended?: number;
  calls: number;
  meters?: CallMeter[];
  usage?: { input?: number; output?: number };
  resultRef?: string;
}
export interface Version {
  id: string;
  slotId: string;
  number: number;
  executionId: string;
  taskId: string;
  kind: 'text' | 'git_commit';
  contentRef: string;
  basedOn: Record<string, string>;
  incompatible: boolean;
  stale: boolean;
  time: number;
}
export interface Question {
  id: string;
  taskId: string;
  from: string;
  to: string;
  question: string;
  blocking: boolean;
  hops: number;
  replyTo?: string;
  replyTaskId?: string;
  status: 'open' | 'answered';
  answer?: string;
}
export interface Message {
  id: string;
  taskId: string;
  from: string;
  to: string;
  message: string;
  forTask?: string;
  deliveredTo?: string;
}
export interface WorkflowEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}
export interface State {
  archives: { id: string; title: string; ref: string }[];
  spec: WorkflowSpec | null;
  revision: number;
  plans: string[];
  tasks: Task[];
  executions: Execution[];
  versions: Version[];
  questions: Question[];
  messages: Message[];
  stoppedPools: string[];
  wakeups: string[];
  acceptance: Record<string, string> | null;
  acceptedSnapshot?: AcceptanceSnapshot;
  receipts: Record<string, { fingerprint: string; result?: unknown; resultRef?: string }>;
  conflicts?: Record<string, string>;
  proposals: { executionId: string; action: unknown }[];
}
export const emptyState = (): State => ({
  archives: [],
  spec: null,
  revision: 0,
  plans: [],
  tasks: [],
  executions: [],
  versions: [],
  questions: [],
  messages: [],
  stoppedPools: [],
  wakeups: [],
  acceptance: null,
  receipts: {},
  proposals: [],
});
export type Append = (type: string, data: Record<string, unknown>) => void;
export interface WorkflowStorage {
  transaction<T>(mutate: (state: State, append: Append) => T): T;
  read(): State;
  events(after?: number): WorkflowEvent[];
  putContent(text: string): string;
  getContent(ref: string): string;
}

export function column(task: Task): Column {
  switch (task.status) {
    case 'waiting':
    case 'ready':
      return 'waiting';
    case 'running':
      return 'doing';
    case 'review':
      return 'review';
    case 'done':
      return 'done';
    default:
      return task.previous;
  }
}
export function transition(task: Task, status: TaskStatus, reason?: string) {
  task.previous = column(task);
  task.status = status;
  task.reason = reason;
}
export function entity<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error('记录不存在');
  return item;
}
export function latest(state: State, slotId: string) {
  return state.versions.findLast((v) => v.slotId === slotId);
}
export function inputsFor(task: Task, state: State) {
  const inputs: Record<string, string> = {};
  for (const input of task.consumes) {
    const v =
      input.policy === 'pinned'
        ? state.versions.find((v) => v.slotId === input.slotId && v.id === input.version)
        : latest(state, input.slotId);
    if (v && (input.policy === 'pinned' || !v.stale)) inputs[input.slotId] = v.id;
  }
  return inputs;
}
export function refresh(task: Task, state: State) {
  const complete = Object.keys(inputsFor(task, state)).length === task.consumes.length;
  transition(task, complete ? 'ready' : 'waiting');
}
export function makeTask(spec: TaskSpec): Task {
  return {
    ...spec,
    status: 'waiting',
    previous: 'waiting',
    rework: 0,
    retries: 0,
    waitHistory: { complete: true, approvalTracked: true, intervals: [] },
  };
}
export function activePlan(state: State): WorkflowSpec {
  if (!state.spec) throw new Error('请先批准工作流计划');
  return state.spec;
}
export function fence(state: State, task: Task, status: Execution['status'], now: number) {
  if (task.active) {
    const exec = entity(state.executions, task.active);
    exec.status = status;
    exec.ended = now;
    delete task.active;
  }
}
export function reopen(task: Task, state: State, now: number) {
  fence(state, task, 'obsolete', now);
  const plan = activePlan(state);
  if (plan.requiredTasks?.includes(task.id) || !plan.requiredSlots.length) state.acceptance = null;
  delete task.acceptedExecution;
  task.rework++;
  if (task.rework > task.maxRework) transition(task, 'decision', '返工次数已用尽');
  else refresh(task, state);
}
