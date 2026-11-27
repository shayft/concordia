import type { FastifyInstance } from 'fastify';
import type { Execution } from '@concordia/core/state';
import type { ExecutionCost } from '@concordia/protocol/pricing';

/** A reservation estimates a budget only. Every request needs a measured count
 * for a direction before that direction can be priced. */
function measuredTotal(execution: Execution, side: 'input' | 'output'): number | null {
  const meters = execution.meters;
  if (!meters?.length || meters.length !== execution.calls) return null;
  let sum = 0;
  for (const meter of meters) {
    const value = meter[side];
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) return null;
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

export function executionCost(execution: Execution): ExecutionCost {
  const pricing = execution.modelSnapshot?.pricing ?? null;
  const inputTokens = measuredTotal(execution, 'input'),
    outputTokens = measuredTotal(execution, 'output');
  let amount: number | null = null;
  if (
    execution.status !== 'running' &&
    inputTokens !== null &&
    outputTokens !== null &&
    pricing?.inputPerMillion !== undefined &&
    pricing.outputPerMillion !== undefined
  ) {
    const value =
      (inputTokens / 1_000_000) * pricing.inputPerMillion +
      (outputTokens / 1_000_000) * pricing.outputPerMillion;
    if (Number.isFinite(value)) amount = value;
  }
  return {
    id: execution.id,
    taskId: execution.taskId,
    connection: execution.connection,
    started: execution.started,
    modelId: execution.modelSnapshot?.modelId ?? null,
    pricing,
    inputTokens,
    outputTokens,
    amount,
  };
}

export function serveExecutionCosts(app: FastifyInstance, executions: () => Execution[]) {
  app.get('/api/execution-costs', async () => executions().map(executionCost));
}
