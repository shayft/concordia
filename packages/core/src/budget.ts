import type { WorkflowSpec } from '@concordia/protocol/workflow';
import type { Execution, State, Task } from './state.ts';

export interface CallMeter {
  reservationId?: string;
  reserved: number;
  input?: number;
  output?: number;
}

function charge(call: CallMeter) {
  const observed = (call.input ?? 0) + (call.output ?? 0);
  return call.input !== undefined && call.output !== undefined ? observed : Math.max(observed, call.reserved);
}

/** Partial or missing provider usage keeps its estimate. Actual usage is tracked independently for display. */
export function exhausted(plan: WorkflowSpec, state: State, task: Task, exec?: Execution) {
  const estimate = plan.estimatedTokensPerCall ?? 1024;
  const measured = (e: Execution) =>
    e.meters?.reduce((sum, m) => sum + charge(m), 0) ??
    Math.max((e.usage?.input ?? 0) + (e.usage?.output ?? 0), e.calls * estimate);
  const own = state.executions.filter((e) => e.taskId === task.id);
  const sum = (items: Execution[], get: (e: Execution) => number) => items.reduce((n, e) => n + get(e), 0);
  return (
    sum(state.executions, (e) => e.calls) >= plan.maxCalls ||
    sum(own, (e) => e.calls) >= task.maxCalls ||
    (task.maxCallsPerExecution !== undefined && (exec?.calls ?? 0) >= task.maxCallsPerExecution) ||
    (plan.maxTokens !== undefined && sum(state.executions, measured) + estimate > plan.maxTokens) ||
    (task.maxTokens !== undefined && sum(own, measured) + estimate > task.maxTokens)
  );
}
