import type { DatabaseSync } from 'node:sqlite';

export type Account = [string, string];
type Limit = { scope: string; id: string; max_calls: number | null; max_tokens: number | null; max_concurrent: number | null };
const key = ([scope, id]: Account) => JSON.stringify([scope, id]);

export function applicableLimits(db: DatabaseSync, accounts: Account[]) {
  const selected = new Set(accounts.map(key));
  return (db.prepare('SELECT scope,id,max_calls,max_tokens,max_concurrent FROM budget_limits ORDER BY scope,id').all() as Limit[])
    .filter(l => selected.has(key([l.scope,l.id])));
}

/** Recheck after asynchronous preparation as well as before reserving capacity. A new cap counts as a policy change. */
export function budgetPolicyMatches(db: DatabaseSync, approvalId: string | undefined, accounts: Account[]) {
  if (!approvalId) return true;
  const row = db.prepare('SELECT details FROM governance WHERE id=?').get(approvalId);
  if (!row) return false;
  const approved = JSON.parse(String(row.details)) as { policy: { limits: Limit[] } };
  const selected = new Set(accounts.map(key));
  const prior = approved.policy.limits.filter(l => selected.has(key([l.scope,l.id])));
  return JSON.stringify(prior) === JSON.stringify(applicableLimits(db,accounts));
}
