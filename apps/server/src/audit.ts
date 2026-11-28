import type { FastifyInstance } from 'fastify';
import type { WorkflowEvent, State } from '@concordia/core/state';

const events = new Set([
  'artifact.published',
  'budget.exhausted',
  'call.reserved',
  'dependency.updated',
  'execution.failed',
  'execution.interrupted',
  'execution.late',
  'execution.started',
  'execution.submitted',
  'integration.conflict',
  'message.sent',
  'plan.accepted',
  'plan.applied',
  'plan.proposed',
  'plan.proposal_decided',
  'plan.switched',
  'pool.resumed',
  'question.answered',
  'question.asked',
  'reply.scheduled',
  'task.cancelled',
  'task.control',
  'task.progress',
  'task.reassigned',
  'task.stale',
  'usage.recorded',
]);
const taskStatuses = [
  'waiting',
  'ready',
  'running',
  'decision',
  'review',
  'paused',
  'done',
  'failed',
  'cancelled',
];
const runStatuses = ['running', 'success', 'failed', 'cancelled', 'interrupted', 'obsolete'];
const controls = ['cancel', 'pause', 'resume', 'retry', 'accept', 'rework'];
const failures = ['auth', 'rate_limit', 'budget', 'transient', 'fatal', 'permission'];
const known = (value: unknown, vocabulary: string[]) =>
  typeof value === 'string' && vocabulary.includes(value) ? value : 'unknown';
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Safe even for legacy event records containing free text and connection details.
 * New fields are private until explicitly included in this projection. */
export function auditEvent(event: WorkflowEvent) {
  const data: Record<string, number | string | boolean> = {};
  for (const key of ['time', 'calls', 'hops', 'revision', 'input', 'output', 'number']) {
    const value = count(event.data[key]);
    if (value !== null) data[key] = value;
  }
  for (const key of ['blocking', 'stale', 'incompatible']) {
    const value = event.data[key];
    if (typeof value === 'boolean') data[key] = value;
  }
  if (typeof event.data.status === 'string')
    data.status = known(event.data.status, [...taskStatuses, ...runStatuses]);
  if (typeof event.data.operation === 'string') data.operation = known(event.data.operation, controls);
  if (typeof event.data.kind === 'string') data.kind = known(event.data.kind, event.type === 'plan.proposed' ? ['create_task','assign_task'] : failures);
  if (event.type === 'plan.proposal_decided') data.decision = known(event.data.decision, ['approved','rejected']);
  return { seq: count(event.seq) ?? 0, type: events.has(event.type) ? event.type : 'event.other', data };
}

type AuditBoard = Pick<State, 'tasks' | 'executions' | 'versions' | 'questions'>;

/** Ordinals are local to this file. No string originating in a project or
 * connection is exported, even if someone enters sensitive text as an ID. */
export function auditSummary(board: AuditBoard) {
  const taskNumbers = new Map(board.tasks.map((t, index) => [t.id, index + 1]));
  return {
    format: 'concordia-audit-v1',
    counts: {
      tasks: board.tasks.length,
      executions: board.executions.length,
      versions: board.versions.length,
      questions: board.questions.length,
    },
    tasks: board.tasks.map((t, index) => ({
      task: index + 1,
      status: known(t.status, taskStatuses),
      retries: count(t.retries),
      rework: count(t.rework),
    })),
    executions: board.executions.map((e, index) => {
      const start = count(e.started),
        end = count(e.ended);
      return {
        execution: index + 1,
        task: taskNumbers.get(e.taskId) ?? null,
        status: known(e.status, runStatuses),
        calls: count(e.calls),
        durationMs: start === null || end === null || end < start ? null : end - start,
        inputTokens: count(e.usage?.input),
        outputTokens: count(e.usage?.output),
      };
    }),
  };
}

export function serveAuditExport(app: FastifyInstance, getBoard: () => AuditBoard) {
  app.get('/api/export/audit', async (_req, reply) =>
    reply
      .header('content-disposition', 'attachment; filename="concordia-audit.json"')
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(auditSummary(getBoard())),
  );
}
