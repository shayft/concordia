import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Scheduler, demoSpec } from '@concordia/core/workflow';
import type { Execution } from '@concordia/core/state';
import { catalogModelSchema } from '@concordia/protocol/connections';
import { openStore } from '@concordia/store';
import { WorkflowStore } from '@concordia/store/workflow';
import { executionCost, serveExecutionCosts } from '../src/execution-cost.ts';

const model = {
  modelId: 'gateway/model-a',
  pricing: { currency: 'USD', inputPerMillion: 2, outputPerMillion: 8 },
};
const execution: Execution = {
  id: 'attempt',
  taskId: 'api',
  owner: 'backend',
  connection: 'gateway',
  pool: 'gateway',
  inputs: {},
  outputs: {},
  contextRef: 'private-context',
  started: 1,
  ended: 2,
  status: 'success',
  modelSnapshot: model,
  calls: 2,
  meters: [
    { reserved: 1024, input: 50, output: 25 },
    { reserved: 1024, input: 50, output: 0 },
  ],
};

describe('按执行时选定的模型与供应方用量估算费用', () => {
  it('价格可选，可单独填输入价格，拒绝负数和无币种价格', () => {
    const record = { id: 'model-a', name: '模型', modelId: model.modelId, connectionId: 'gateway' };
    expect(catalogModelSchema.parse(record).pricing).toBeUndefined();
    expect(
      catalogModelSchema.parse({ ...record, pricing: { currency: 'cny', inputPerMillion: 0 } }).pricing,
    ).toEqual({ currency: 'CNY', inputPerMillion: 0 });
    for (const pricing of [
      { inputPerMillion: 1 },
      { currency: 'USD' },
      { currency: 'USD', inputPerMillion: -1 },
    ])
      expect(catalogModelSchema.safeParse({ ...record, pricing }).success).toBe(false);
  });
  it('多轮执行逐请求核对实际用量，缺一项、缺单价、运行中和旧快照均为未知', () => {
    expect(executionCost(execution).amount).toBeCloseTo(0.0004, 10);
    const partial = {
      ...execution,
      meters: [
        { reserved: 1024, input: 50, output: 25 },
        { reserved: 1024, input: 50 },
      ],
    };
    expect(executionCost(partial)).toMatchObject({ inputTokens: 100, outputTokens: null, amount: null });
    expect(
      executionCost({ ...execution, meters: undefined, usage: { input: 999, output: 999 } }).amount,
    ).toBeNull();
    expect(executionCost({ ...execution, modelSnapshot: undefined })).toMatchObject({
      modelId: null,
      amount: null,
    });
    expect(executionCost({ ...execution, status: 'running' }).amount).toBeNull();
    expect(
      executionCost({
        ...execution,
        modelSnapshot: { modelId: 'a', pricing: { currency: 'USD', inputPerMillion: 0 } },
      }).amount,
    ).toBeNull();
    expect(
      executionCost({
        ...execution,
        modelSnapshot: {
          modelId: 'a',
          pricing: { currency: 'USD', inputPerMillion: 0, outputPerMillion: 0 },
        },
      }).amount,
    ).toBe(0);
  });
  it('SQLite 重开后保留原始模型与报价，历史接口仅发送展示字段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concordia-pricing-'));
    const file = join(dir, 'state.sqlite');
    let db = openStore(file);
    const app = Fastify();
    try {
      let seq = 0;
      const scheduler = new Scheduler({
        storage: new WorkflowStore(db),
        now: () => 12,
        nextId: () => 'e' + ++seq,
      });
      scheduler.apply(demoSpec());
      const binding = structuredClone(model);
      const acquired = scheduler.claim('api', binding);
      binding.modelId = 'later-model';
      binding.pricing.inputPerMillion = 75;
      scheduler.recordUsage(acquired.id, { inputTokens: 500_000, outputTokens: 125_000 });
      scheduler.fail(acquired.id, 'fatal');
      db.close();
      db = openStore(file);
      serveExecutionCosts(app, () => new WorkflowStore(db).read().executions);
      const response = await app.inject({ method: 'GET', url: '/api/execution-costs' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          id: acquired.id,
          taskId: 'api',
          connection: 'mock-backend',
          started: 12,
          modelId: model.modelId,
          pricing: model.pricing,
          inputTokens: 500_000,
          outputTokens: 125_000,
          amount: 2,
        },
      ]);
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
