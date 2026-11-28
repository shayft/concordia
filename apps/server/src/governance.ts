import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { CatalogModel, Connection, Member, QuotaPool } from '@concordia/protocol/connections';

// A non-secret identifier for an application instance, independent of its login proof.
const sessions = new WeakMap<DatabaseSync, string>();
const approval = new AsyncLocalStorage<string | undefined>();
export const currentApprovalId = () => approval.getStore();
export const withApproval = <T>(id: string | undefined, fn: () => T) => approval.run(id, fn);
export const fingerprint = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function recordDecision(db: DatabaseSync, action: string, workspace: string | null, details: object) {
  let session = sessions.get(db);
  if (!session) { session = randomUUID(); sessions.set(db, session); }
  const id = randomUUID();
  db.prepare('INSERT INTO governance(id,session,created,workspace,action,details) VALUES(?,?,?,?,?,?)')
    .run(id, session, Date.now(), workspace, action, JSON.stringify(details));
  return id;
}

type Config = Connection | CatalogModel | Member | QuotaPool;
/** Hash free text, credential references, paths and prompts. Preserve the policy settings needed to explain a decision. */
export function configSnapshot(c: Config) {
  return {
    id: c.id, digest: fingerprint(c),
    ...('kind' in c && { protocol: c.kind }),
    ...('baseUrl' in c && { origin: new URL(c.baseUrl).origin }),
    ...('enabled' in c && { enabled: c.enabled }),
    ...('connectionId' in c && { connectionId: c.connectionId }),
    ...('role' in c && { model: c.modelId, actions: c.allowedActions ?? 'default', manager: c.reportsTo }),
    ...('poolId' in c && { pool: c.poolId }),
    ...('maxConcurrent' in c && { maxConcurrent: c.maxConcurrent }),
    ...('baseUrl' in c && { outputLimit: c.maxOutputTokens, outputField: c.outputTokenField }),
    ...('pricing' in c && { pricing: c.pricing }),
  };
}

export function registerGovernance(app: FastifyInstance, db: DatabaseSync, workspace: () => string) {
  // A previous server cannot still be dispatching after acquiring the data directory lease.
  db.prepare("UPDATE approved_executions SET status='unknown_after_restart' WHERE status='running'").run();
  app.get('/api/governance', async (req, reply) => {
    const { before } = req.query as { before?: string };
    if (before !== undefined && (!/^\d{1,16}$/u.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1))
      return reply.code(400).send({ error: '审计页游标无效。' });
    const rows = db.prepare('SELECT * FROM governance WHERE (workspace IS NULL OR workspace=?) AND seq<? ORDER BY seq DESC LIMIT 51')
      .all(workspace(), before === undefined ? Number.MAX_SAFE_INTEGER : Number(before));
    const calls = db.prepare('SELECT status,outcome,count(*) AS count FROM budget_calls WHERE approval_id=? GROUP BY status,outcome');
    const jobs = db.prepare('SELECT execution,status FROM approved_executions WHERE approval_id=? ORDER BY execution');
    const plans = db.prepare('SELECT id,status FROM plan_requests WHERE approval_id=? ORDER BY started');
    const items = rows.slice(0,50).map(row => ({
      seq: row.seq, id: row.id, session: row.session, created: row.created, action: row.action,
      details: JSON.parse(String(row.details)) as object,
      calls: calls.all(row.id), executions: jobs.all(row.id), plans: plans.all(row.id),
    }));
    return { items, next: rows.length > 50 ? items[49].seq : null };
  });
}
