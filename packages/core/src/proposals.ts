import { platformActionSchema, type PlatformAction } from '@concordia/protocol';
import { taskSchema, workflowSpecSchema, type WorkflowSpec } from '@concordia/protocol/workflow';
import { activePlan, entity, type State, type TaskStatus } from './state.ts';

export type ProposalAction = Extract<PlatformAction, { type: 'create_task' | 'assign_task' }>;
export interface ProposalStamp {
  proposalId: string;
  planId: string;
  revision: number;
  target: { status: TaskStatus; executionId: string | null } | null;
}
export interface Proposal {
  id: string;
  planId: string;
  submittedRevision: number | null;
  executionId: string;
  action: ProposalAction;
  status: 'pending' | 'approved' | 'rejected';
  decision?: ProposalStamp;
}
export interface LegacyProposal { executionId: string; action: unknown }

export function proposals(state: State): Proposal[] {
  return (state.proposals ?? []).map((p, index) => {
    if ('id' in p) return p;
    const action = platformActionSchema.parse(p.action);
    if (action.type !== 'create_task' && action.type !== 'assign_task') throw new Error('旧提议内容无效');
    // Append-only indices are stable in each archived plan. Older records did not record a revision.
    return { id: 'legacy:' + index, planId: activePlan(state).id, submittedRevision: null,
      executionId: p.executionId, action, status: 'pending' };
  });
}
export function proposalStamp(state: State, proposal: Proposal): ProposalStamp {
  const task = state.tasks.find(t => t.id === proposal.action.taskId);
  return { planId: activePlan(state).id, proposalId: proposal.id, revision: state.revision,
    target: task ? { status: task.status, executionId: state.executions.findLast(e => e.taskId === task.id)?.id ?? null } : null };
}
export function sameStamp(a: ProposalStamp, b: ProposalStamp) {
  return a.planId === b.planId && a.proposalId === b.proposalId && a.revision === b.revision &&
    a.target?.status === b.target?.status && a.target?.executionId === b.target?.executionId;
}
export function proposedSpec(state: State, action: ProposalAction): WorkflowSpec {
  const plan = activePlan(state);
  entity(plan.agents, action.assignee);
  if (action.type === 'create_task') {
    if (state.tasks.some(t => t.id === action.taskId)) throw new Error('提议的任务编号已存在');
    const task = taskSchema.parse({ id: action.taskId, owner: action.assignee,
      ...(action.description.length <= 500 ? { title: action.description } : { title: action.taskId, description: action.description }),
    });
    return workflowSpecSchema.parse({ ...plan, tasks: [...plan.tasks, task] });
  }
  const task = entity(state.tasks, action.taskId);
  if (task.replyFor || ['done', 'cancelled'].includes(task.status)) throw new Error('此任务不能改派');
  if (task.owner === action.assignee) throw new Error('该成员已经负责此任务');
  return workflowSpecSchema.parse({ ...plan, tasks: plan.tasks.map(t =>
    t.id === task.id ? { ...t, owner: action.assignee } : t) });
}
