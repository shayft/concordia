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
type Account = [BudgetScope, string];
type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export class BudgetExceeded extends Error {
  constructor() {
    super('此调用超出已配置的预算或并发上限。');
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
export function reserveBudget(db: DatabaseSync, scope: CallScope): string {
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
    db.prepare("INSERT INTO budget_calls(id,scopes,estimated,started,status) VALUES (?,?,?,?,'running')").run(
      callId,
      JSON.stringify(accounts),
      estimate,
      Date.now(),
    );
    return callId;
  });
}

export function settleBudget(db: DatabaseSync, id: string, usage: Usage = {}): void {
  transaction(db, () => {
    const row = db
      .prepare("SELECT scopes,estimated FROM budget_calls WHERE id=? AND status='running'")
      .get(id);
    if (!row) return; // A duplicate settlement or interrupted call cannot release a second slot.
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
      "UPDATE budget_calls SET status='finished',input_tokens=?,output_tokens=?,total_tokens=?,finished=? WHERE id=?",
    ).run(input, output, total, Date.now(), id);
  });
}

export function meterProvider(db: DatabaseSync, scope: CallScope, provider: ModelProvider): ModelProvider {
  return {
    getCapabilities: () => provider.getCapabilities(),
    async *stream(messages, tools, options) {
      options?.signal?.throwIfAborted();
      const id = reserveBudget(db, scope);
      const usage: Usage = {};
      try {
        for await (const event of provider.stream(messages, tools, options)) {
          if (event.type === 'error' && (event.kind === 'rate_limit' || event.kind === 'budget'))
            suspendPool(db, scope.poolId);
          if (event.type === 'usage') {
            if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
            if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
            if (event.totalTokens !== undefined) usage.totalTokens = event.totalTokens;
          }
          yield event;
        }
      } finally {
        settleBudget(db, id, usage);
      }
    },
    async validateConnection(signal) {
      signal?.throwIfAborted();
      const id = reserveBudget(db, scope);
      let usage: Usage | undefined;
      try {
        const result = await provider.validateConnection(signal);
        if (!result.ok && (result.error.kind === 'rate_limit' || result.error.kind === 'budget'))
          suspendPool(db, scope.poolId);
        usage = result.usage;
        return result;
      } finally {
        settleBudget(db, id, usage);
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
  return { limits, usage };
}

/** Register once, after acquiring the application's exclusive data-directory lease. */
export function registerBudgets(app: FastifyInstance, db: DatabaseSync) {
  transaction(db, () => {
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
  app.put<Params>('/api/budgets/:scope/:id', async (request, reply) => {
    const { id } = request.params;
    const scope = scopeFor(request.params.scope, id);
    const caps = budgetCapsSchema.safeParse(request.body);
    if (!scope || !caps.success) return reply.code(400).send({ error: '请指定有效预算范围与正整数上限。' });
    const { maxCalls, maxTokens, maxConcurrent } = caps.data;
    db.prepare(
      `INSERT INTO budget_limits(scope,id,max_calls,max_tokens,max_concurrent) VALUES(?,?,?,?,?)
      ON CONFLICT(scope,id) DO UPDATE SET max_calls=excluded.max_calls,max_tokens=excluded.max_tokens,max_concurrent=excluded.max_concurrent`,
    ).run(scope, id, maxCalls ?? null, maxTokens ?? null, maxConcurrent ?? null);
    return { scope, id, ...caps.data };
  });
  app.delete<Params>('/api/budgets/:scope/:id', async (request, reply) => {
    const { id } = request.params;
    const scope = scopeFor(request.params.scope, id);
    if (!scope) return reply.code(400).send({ error: '预算范围无效。' });
    db.prepare('DELETE FROM budget_limits WHERE scope=? AND id=?').run(scope, id);
    return reply.code(204).send();
  });
}
