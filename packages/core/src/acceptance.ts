import type { AcceptanceSnapshot } from '@concordia/protocol/workflow';
import { latest, type State, type Task } from './state.ts';

export function reviewExecution(state: State, task: Task) {
  return state.executions.findLast(e => e.taskId === task.id && e.status === 'success');
}

// Read-only preview and transactional approval use the same lineage checks.
export function acceptanceCandidate(state: State): AcceptanceSnapshot | string {
  const plan = state.spec;
  if (!plan) return '请先批准工作流计划';
  const versions: Record<string, string> = {};
  const executions: Record<string, string> = {};
  const required = new Set(plan.requiredTasks?.length ? plan.requiredTasks :
    plan.requiredSlots.length ? [] : plan.tasks.map(t => t.id));
  for (const slot of plan.requiredSlots) {
    const version = latest(state, slot);
    if (!version || version.stale) return '必需交付物未验收或已过期';
    versions[slot] = version.id;
    required.add(version.taskId);
  }
  for (const taskId of required) {
    const task = state.tasks.find(t => t.id === taskId);
    if (task?.status !== 'done') return '必需任务尚未完成审查';
    const exec = task.acceptedExecution
      ? state.executions.find(e => e.id === task.acceptedExecution)
      : reviewExecution(state, task);
    if (exec?.status !== 'success' || exec.taskId !== taskId) return '必需任务缺少可核对的执行';
    for (const id of Object.values(exec.inputs)) {
      const version = state.versions.find(v => v.id === id);
      if (!version || version.stale) return '必需审查的输入已过期';
    }
    for (const slot of task.produces) {
      if (versions[slot] && versions[slot] !== exec.outputs[slot]) return '交付物与验收执行不符';
    }
    executions[taskId] = exec.id;
  }
  if (state.questions.some(q => q.status === 'open' && q.blocking)) return '尚有未答复的阻塞问题';
  return { planId: plan.id, revision: state.revision, versions, executions };
}

function sameEntries(a: Record<string, string>, b: Record<string, string>) {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}
export function sameAcceptance(a: AcceptanceSnapshot, b: AcceptanceSnapshot) {
  return a.planId === b.planId && a.revision === b.revision && sameEntries(a.versions, b.versions)
    && sameEntries(a.executions, b.executions);
}
