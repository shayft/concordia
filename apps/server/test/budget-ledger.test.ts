import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ModelProvider } from '@concordia/providers';
import { openStore } from '@concordia/store';
import {
  budgetReport,
  BudgetExceeded,
  meterProvider,
  registerBudgets,
  reserveBudget,
  settleBudget,
} from '../src/budget-ledger.ts';

let dir: string, db: DatabaseSync, app: FastifyInstance;
const scope = {
  workspaceId: 'project',
  memberId: 'worker',
  connectionId: 'one',
  poolId: 'shared',
  estimate: 100,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'concordia-budgets-'));
  db = openStore(join(dir, 'catalog.sqlite'));
  app = Fastify();
  registerBudgets(app, db);
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function caps(scope: string, id: string, payload: object) {
  const res = await app.inject({ method: 'PUT', url: '/api/budgets/' + scope + '/' + id, payload });
  expect(res.statusCode).toBe(200);
}
it('一次调用同时预留五种范围，限额拒绝时整笔回滚，已知用量覆盖估计', async () => {
  await caps('member', 'worker', { maxCalls: 1 });
  await caps('global', 'all', { maxCalls: 3 });
  const id = reserveBudget(db, scope);
  expect(budgetReport(db).usage).toHaveLength(5);
  expect(() => reserveBudget(db, scope)).toThrow(BudgetExceeded);
  expect(budgetReport(db).usage.every((u) => u.calls === 1 && u.active === 1 && u.tokens === 100)).toBe(true);
  settleBudget(db, id, { inputTokens: 9, outputTokens: 21 });
  settleBudget(db, id, { totalTokens: 500 });
  expect(budgetReport(db).usage.every((u) => u.tokens === 30 && u.active === 0)).toBe(true);
  const second = reserveBudget(db, { ...scope, memberId: 'two', connectionId: 'two' });
  settleBudget(db, second, { outputTokens: 200 });
  expect(budgetReport(db).usage.find((u) => u.scope === 'global')).toMatchObject({ calls: 2, tokens: 230 });
});

it('不同连接共池，跨工作区调用共用全局限额；删除上限不会清空已有用量', async () => {
  await caps('pool', 'shared', { maxConcurrent: 1 });
  await caps('global', 'all', { maxTokens: 180 });
  const id = reserveBudget(db, scope);
  expect(() => reserveBudget(db, { ...scope, connectionId: 'two', workspaceId: 'second' })).toThrow(
    BudgetExceeded,
  );
  settleBudget(db, id, { totalTokens: 10 });
  const next = reserveBudget(db, { ...scope, connectionId: 'two', workspaceId: 'second' });
  settleBudget(db, next);
  expect(() => reserveBudget(db, { ...scope, poolId: 'separate', memberId: 'other' })).toThrow(
    BudgetExceeded,
  );
  expect((await app.inject({ method: 'DELETE', url: '/api/budgets/global/all' })).statusCode).toBe(204);
  expect(budgetReport(db).usage.find((u) => u.scope === 'global')).toMatchObject({ calls: 2, tokens: 110 });
  settleBudget(db, reserveBudget(db, scope));
});
it('重启释放运行名额但保留中断调用的次数和预留用量，迟到结果不重复结算', async () => {
  await caps('global', 'all', { maxCalls: 2, maxConcurrent: 1 });
  const first = reserveBudget(db, scope);
  await app.close();
  db.close();
  db = openStore(join(dir, 'catalog.sqlite'));
  app = Fastify();
  registerBudgets(app, db);
  settleBudget(db, first, { totalTokens: 0 });
  const report = (await app.inject('/api/budgets')).json();
  expect(report.usage.find((r: { scope: string }) => r.scope === 'global')).toMatchObject({
    active: 0,
    calls: 1,
    tokens: 100,
  });
  const second = reserveBudget(db, scope);
  settleBudget(db, second);
  expect(() => reserveBudget(db, scope)).toThrow(BudgetExceeded);
});
it('逐轮调用适配器并处理流消费中止，达到上限时不执行后端', async () => {
  await caps('global', 'all', { maxCalls: 2 });
  let starts = 0;
  const fake: ModelProvider = {
    getCapabilities: () => ({ nativeTools: false, streaming: true }),
    async validateConnection() {
      starts++;
      return { ok: true, text: 'CONCORDIA_OK' };
    },
    async *stream() {
      starts++;
      yield { type: 'usage', inputTokens: 2, outputTokens: 4 };
      yield { type: 'completed' };
    },
  };
  const provider = meterProvider(db, scope, fake);
  for await (const _event of provider.stream([{ role: 'user', content: '模拟' }])) {
    void _event;
    break;
  }
  await provider.validateConnection();
  await expect(provider.validateConnection()).rejects.toThrow(BudgetExceeded);
  expect(starts).toBe(2);
  expect(budgetReport(db).usage.find((u) => u.scope === 'global')).toMatchObject({
    calls: 2,
    tokens: 106,
    active: 0,
  });
  expect((await app.inject({ method: 'PUT', url: '/api/budgets/global/all', payload: {} })).statusCode).toBe(
    400,
  );
});
