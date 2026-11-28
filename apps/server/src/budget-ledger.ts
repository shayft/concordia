import { budgetPolicyMatches } from './budget-policy.ts';
import { currentApprovalId, recordDecision } from './governance.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import {
  budgetCapsSchema,
  budgetScopeSchema,
  type BudgetLimit,
  type BudgetReport,
  type BudgetScope,
} from '@concordia/protocol/budgets';
import type { ModelProvider } from '@concordia/providers';

export interface CallScope {
  workspaceId?: string;
  memberId?: string;
  connectionId: string;
  poolId: string;
  estimate?: number;
}
export type CallOutcome = 'success' | 'error' | 'cancelled' | 'unknown';
type Account = [BudgetScope, string];
type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export class BudgetExceeded extends Error {
  constructor(message = '此调用超出已配置的预算或并发上限。') {
    super(message);
  }
}
export class PoolSuspended extends Error {
  constructor() {
    super('共享额度池已暂停，请核对供应商状态后手动恢复。');
  }
}

export function pausedPools(db: DatabaseSync): string[] {
  return db
    .prepare('SELECT id FROM paused_pools ORDER BY id')
    .all()
    .map((row) => String(row.id));
}
export function suspendPool(db: DatabaseSync, poolId: string): void {
  db.prepare('INSERT INTO paused_pools(id,paused_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(
    poolId,
    Date.now(),
  );
}
export function resumeSharedPool(db: DatabaseSync, poolId: string): void {
  db.prepare('DELETE FROM paused_pools WHERE id=?').run(poolId);
}
export function assertPoolAvailable(db: DatabaseSync, poolId: string): void {
  if (db.prepare('SELECT 1 FROM paused_pools WHERE id=?').get(poolId)) throw new PoolSuspended();
}
function transaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** One reservation per upstream request or native CLI invocation. The estimate is retained if its outcome is unknown. */
export function reserveBudget(db: DatabaseSync, scope: CallScope, phase: 'preparing' | 'running' = 'running'): string {
  const estimate = scope.estimate ?? 1024;
  if (!Number.isSafeInteger(estimate) || estimate < 1) throw new Error('调用预算估计无效。');
  const accounts: Account[] = [
    ['global', 'all'],
    ['connection', scope.connectionId],
    ['pool', scope.poolId],
  ];
  if (scope.workspaceId) accounts.push(['workspace', scope.workspaceId]);
  if (scope.memberId) accounts.push(['member', scope.memberId]);
  return transaction(db, () => {
    if (!budgetPolicyMatches(db,currentApprovalId(),accounts)) throw new BudgetExceeded('预算策略已改变，请重新批准。');
    assertPoolAvailable(db, scope.poolId);
    const check = db.prepare(`SELECT 1 AS exceeded FROM budget_limits l
      LEFT JOIN budget_usage u USING (scope,id)
      WHERE l.scope=? AND l.id=? AND (COALESCE(u.calls,0)+1 > l.max_calls OR
      COALESCE(u.tokens,0)+? > l.max_tokens OR COALESCE(u.active,0)+1 > l.max_concurrent)`);
    const increment = db.prepare(`INSERT INTO budget_usage(scope,id,calls,tokens,active) VALUES (?,?,1,?,1)
      ON CONFLICT(scope,id) DO UPDATE SET calls=calls+1,tokens=tokens+excluded.tokens,active=active+1`);
    for (const [kind, id] of accounts) {
      if (check.get(kind, id, estimate)) throw new BudgetExceeded();
      increment.run(kind, id, estimate);
    }
    const callId = randomUUID();
    db.prepare("INSERT INTO budget_calls(id,scopes,estimated,started,status,approval_id) VALUES (?,?,?,?,?,?)").run(
      callId,
      JSON.stringify(accounts),
      estimate,
      Date.now(),
      phase,
      currentApprovalId() ?? null,
    );
    return callId;
  });
}

/** Receipt is persisted before handing the request to the transport. */
export function dispatchBudget(db: DatabaseSync, id: string, beforeSend?: (id: string) => void): void {
  const hold = db.prepare("SELECT scopes,approval_id FROM budget_calls WHERE id=? AND status='preparing'").get(id);
  if (!hold) throw new Error('调用预算预留已失效。');
  const accounts = JSON.parse(String(hold.scopes)) as Account[];
  if (!budgetPolicyMatches(db,typeof hold.approval_id === 'string' ? hold.approval_id : undefined,accounts))
    throw new BudgetExceeded('预算策略已改变，请重新批准。');
  const pool = accounts.find(([scope]) => scope === 'pool');
  if (pool) assertPoolAvailable(db, pool[1]);
  beforeSend?.(id);
  db.prepare("UPDATE budget_calls SET status='running' WHERE id=? AND status='preparing'").run(id);
}

function refundPreparation(db: DatabaseSync, id: string, row: {scopes: unknown; estimated: unknown}) {
  const refund = db.prepare('UPDATE budget_usage SET calls=calls-1,tokens=tokens-?,active=active-1 WHERE scope=? AND id=?');
  for (const [scope, key] of JSON.parse(String(row.scopes)) as Account[]) refund.run(Number(row.estimated), scope, key);
  db.prepare("UPDATE budget_calls SET status='not_sent',finished=? WHERE id=?").run(Date.now(), id);
}

/** A trusted supervisor positively confirmed it failed to spawn the native executable. */
export function noTargetStarted(db: DatabaseSync, id: string) {
  transaction(db, () => {
    const row = db.prepare("SELECT scopes,estimated FROM budget_calls WHERE id=? AND status='running'").get(id);
    if (row) refundPreparation(db, id, { scopes: row.scopes, estimated: row.estimated });
  });
}

export function settleBudget(db: DatabaseSync, id: string, usage: Usage = {}, outcome: CallOutcome = 'unknown'): void {
  transaction(db, () => {
    const row = db
      .prepare("SELECT scopes,estimated,status FROM budget_calls WHERE id=? AND status IN ('preparing','running')")
      .get(id);
    if (!row) return; // A duplicate settlement or interrupted call cannot release a second slot.
    if (row.status === 'preparing') return refundPreparation(db, id, { scopes: row.scopes, estimated: row.estimated });
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    const input = valid(usage.inputTokens) ? usage.inputTokens : null;
    const output = valid(usage.outputTokens) ? usage.outputTokens : null;
    const total = valid(usage.totalTokens) ? usage.totalTokens : null;
    const estimate = Number(row.estimated);
    const observed = (input ?? 0) + (output ?? 0);
    const tokens =
      total !== null
        ? Math.max(total, observed)
        : input !== null && output !== null
          ? observed
          : Math.max(estimate, observed);
    const update = db.prepare(
      'UPDATE budget_usage SET tokens=tokens+?,active=active-1 WHERE scope=? AND id=?',
    );
    for (const [scope, key] of JSON.parse(String(row.scopes)) as Account[])
      update.run(tokens - estimate, scope, key);
    db.prepare(
      "UPDATE budget_calls SET status='finished',outcome=?,input_tokens=?,output_tokens=?,total_tokens=?,finished=? WHERE id=?",
    ).run(outcome, input, output, total, Date.now(), id);
  });
}

export function meterProvider(db: DatabaseSync, scope: CallScope, provider: ModelProvider): ModelProvider {
  return {
    getCapabilities: () => ({ ...provider.getCapabilities(), dispatchSignal: true }),
    async *stream(messages, tools, options) {
      options?.signal?.throwIfAborted();
      const id = reserveBudget(db, scope, 'preparing');
      const usage: Usage = {};
      let outcome: CallOutcome = 'unknown';
      try {
        const mark = () => dispatchBudget(db, id, options?.onDispatch);
        const precise = provider.getCapabilities().dispatchSignal;
        if (!precise) mark();
        for await (const event of provider.stream(messages, tools, { ...options, onDispatch: precise ? mark : undefined })) {
          if (event.type === 'error') outcome = 'error';
          if (event.type === 'completed' && outcome !== 'error') outcome = 'success';
          if (event.type === 'error' && (event.kind === 'rate_limit' || (event.kind === 'budget' && event.httpStatus !== undefined)))
            suspendPool(db, scope.poolId);
          if (event.type === 'usage') {
            if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
            if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
            if (event.totalTokens !== undefined) usage.totalTokens = event.totalTokens;
          }
          yield event;
        }
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        settleBudget(db, id, usage, options?.signal?.aborted ? 'cancelled' : outcome);
      }
    },
    async validateConnection(signal, onDispatch) {
      signal?.throwIfAborted();
      const id = reserveBudget(db, scope, 'preparing');
      let usage: Usage | undefined;
      let outcome: CallOutcome = 'error';
      try {
        const mark = () => dispatchBudget(db, id, onDispatch);
        const precise = provider.getCapabilities().dispatchSignal;
        if (!precise) mark();
        const result = await provider.validateConnection(signal, precise ? mark : undefined);
        if (!result.ok && (result.error.kind === 'rate_limit' || (result.error.kind === 'budget' && result.error.httpStatus !== undefined)))
          suspendPool(db, scope.poolId);
        outcome = result.ok ? 'success' : 'error';
        usage = result.usage;
        return result;
      } finally {
        settleBudget(db, id, usage, signal?.aborted ? 'cancelled' : outcome);
      }
    },
  };
}

export function budgetReport(db: DatabaseSync): BudgetReport {
  const limits = db
    .prepare('SELECT * FROM budget_limits ORDER BY scope,id')
    .all()
    .map(
      (r) =>
        ({
          scope: r.scope as BudgetScope,
          id: String(r.id),
          ...(r.max_calls !== null && { maxCalls: Number(r.max_calls) }),
          ...(r.max_tokens !== null && { maxTokens: Number(r.max_tokens) }),
          ...(r.max_concurrent !== null && { maxConcurrent: Number(r.max_concurrent) }),
        }) satisfies BudgetLimit,
    );
  const usage = db
    .prepare('SELECT * FROM budget_usage ORDER BY scope,id')
    .all()
    .map((r) => ({
      scope: r.scope as BudgetScope,
      id: String(r.id),
      calls: Number(r.calls),
      tokens: Number(r.tokens),
      active: Number(r.active),
    }));
  // Preparing calls hold capacity, but have no user-visible billed calls or tokens.
  const held = new Map(usage.map(row => [JSON.stringify([row.scope, row.id]), row]));
  for (const row of db.prepare("SELECT scopes,estimated FROM budget_calls WHERE status='preparing'").all()) {
    for (const account of JSON.parse(String(row.scopes)) as Account[]) {
      const entry = held.get(JSON.stringify(account));
      if (entry) { entry.calls--; entry.tokens -= Number(row.estimated); }
    }
  }
  return { limits, usage };
}

/** Register once, after acquiring the application's exclusive data-directory lease. */
export function registerBudgets(app: FastifyInstance, db: DatabaseSync) {
  transaction(db, () => {
    for (const row of db.prepare("SELECT id,scopes,estimated FROM budget_calls WHERE status='preparing'").all())
      refundPreparation(db, String(row.id), { scopes: row.scopes, estimated: row.estimated });
    db.exec(
      "UPDATE budget_calls SET status='interrupted' WHERE status='running'; UPDATE budget_usage SET active=0 WHERE active>0",
    );
  });
  app.get('/api/budgets', async () => budgetReport(db));
  type Params = { Params: { scope: string; id: string } };
  function scopeFor(raw: string, id: string) {
    const scope = budgetScopeSchema.safeParse(raw);
    if (!scope.success) return;
    const good =
      scope.data === 'global' ? id === 'all' : /^(?:connection:)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id);
    if (good && (scope.data === 'pool' || !id.includes(':'))) return scope.data;
  }
  const priorCaps = db.prepare('SELECT max_calls,max_tokens,max_concurrent FROM budget_limits WHERE scope=? AND id=?');
  app.put<Params>('/api/budgets/:scope/:id', async (request, reply) => {
    const { id } = request.params;
    const scope = scopeFor(request.params.scope, id);
    const caps = budgetCapsSchema.safeParse(request.body);
    if (!scope || !caps.success) return reply.code(400).send({ error: '请指定有效预算范围与正整数上限。' });
    const { maxCalls, maxTokens, maxConcurrent } = caps.data;
    transaction(db, () => {
      const before = priorCaps.get(scope,id) ?? null;
      db.prepare(
      `INSERT INTO budget_limits(scope,id,max_calls,max_tokens,max_concurrent) VALUES(?,?,?,?,?)
      ON CONFLICT(scope,id) DO UPDATE SET max_calls=excluded.max_calls,max_tokens=excluded.max_tokens,max_concurrent=excluded.max_concurrent`,
    ).run(scope, id, maxCalls ?? null, maxTokens ?? null, maxConcurrent ?? null);
      recordDecision(db, 'budget.updated', scope === 'workspace' ? id : null, { scope, id, before, after: priorCaps.get(scope,id) });
    });
    return { scope, id, ...caps.data };
  });
  app.delete<Params>('/api/budgets/:scope/:id', async (request, reply) => {
    const { id } = request.params;
    const scope = scopeFor(request.params.scope, id);
    if (!scope) return reply.code(400).send({ error: '预算范围无效。' });
    transaction(db, () => {
      const before = priorCaps.get(scope,id);
      db.prepare('DELETE FROM budget_limits WHERE scope=? AND id=?').run(scope, id);
      if (before) recordDecision(db, 'budget.deleted', scope === 'workspace' ? id : null, { scope, id, before, after: null });
    });
    return reply.code(204).send();
  });
}
