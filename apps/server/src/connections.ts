import { BudgetExceeded, PoolSuspended, meterProvider, registerBudgets, reserveBudget, settleBudget, suspendPool } from './budget-ledger.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { type z } from 'zod';
import {
  catalogModelSchema, connectionSchema, writableConnectionSchema, inspectConnectionSchema, memberSchema, quotaPoolSchema, testConnectionSchema,
  type Catalog, type CatalogModel, type Connection, type Member, type QuotaPool,
} from '@concordia/protocol/connections';
import { createModelProvider, type ProviderConfig } from '@concordia/providers';
import { CliDiagnosticError, inspectCli, runCliProbe } from '@concordia/runtimes';

const entities = {
  connections: { table: 'connections', schema: connectionSchema },
  models: { table: 'catalog_models', schema: catalogModelSchema },
  members: { table: 'members', schema: memberSchema },
  pools: { table: 'quota_pools', schema: quotaPoolSchema },
} as const;
type Resource = keyof typeof entities;
type RecordOf<K extends Resource> = Catalog[K][number];
type ResourceParams = { Params: { id: string } };
export interface RunningFilter { connectionId?: string; memberId?: string; poolId?: string }
export interface CatalogOptions {
  isRunning(filter: RunningFilter): boolean;
  runningCount?(filter: RunningFilter): number;
  assertCanExecute?(): void;
}

interface Probe extends RunningFilter { controller: AbortController; modelId?: string }
const currentProbes = new WeakMap<DatabaseSync, Set<Probe>>();
export function cancelCatalogProbes(db: DatabaseSync): void {
  for (const probe of currentProbes.get(db) ?? []) probe.controller.abort();
}
export function probeCount(db: DatabaseSync, filter: RunningFilter): number {
  const probes = currentProbes.get(db);
  if (!probes) return 0;
  return [...probes].filter(p => (!filter.memberId || p.memberId === filter.memberId) &&
    (!filter.connectionId || p.connectionId === filter.connectionId) && (!filter.poolId || p.poolId === filter.poolId)).length;
}

class CatalogError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function parse<T extends z.ZodType>(schema: T, document: unknown): z.output<T> {
  const result = schema.safeParse(document);
  if (!result.success) throw new CatalogError(400, '配置字段或取值无效。凭据只能填写系统引用。');
  return result.data;
}

function find<K extends Resource>(db: DatabaseSync, key: K, id: string): RecordOf<K> {
  const row = db.prepare('SELECT document FROM ' + entities[key].table + ' WHERE id = ?').get(id);
  if (!row) throw new CatalogError(404, '找不到指定的配置。');
  return parse(entities[key].schema, JSON.parse(String(row.document))) as RecordOf<K>;
}

function list<K extends Resource>(db: DatabaseSync, key: K): RecordOf<K>[] {
  return db.prepare('SELECT document FROM ' + entities[key].table + ' ORDER BY id').all()
    .map(row => parse(entities[key].schema, JSON.parse(String(row.document))) as RecordOf<K>);
}
export function getCatalog(db: DatabaseSync): Catalog {
  return { connections: list(db, 'connections'), models: list(db, 'models'), members: list(db, 'members'), pools: list(db, 'pools') };
}

function selectedModel(db: DatabaseSync, connection: Connection, id?: string) {
  if (!id) {
    if ('baseUrl' in connection) throw new CatalogError(400, '请为 API 连接指定模型。');
    return null;
  }
  const model = find(db, 'models', id);
  if (model.connectionId !== connection.id) throw new CatalogError(400, '模型不属于指定连接。');
  if (!model.enabled) throw new CatalogError(409, '模型已禁用。');
  return model;
}

export function resolveMember(db: DatabaseSync, memberId: string) {
  const member = find(db, 'members', memberId);
  const connection = find(db, 'connections', member.connectionId);
  if (connection.id.startsWith('mock-')) throw new CatalogError(409, '此旧连接标识为模拟系统保留，请新建连接并重新绑定成员。');
  if (!member.enabled || !connection.enabled) throw new CatalogError(409, '成员或连接已禁用。');
  const model = selectedModel(db, connection, member.modelId);
  const pool = connection.poolId ? find(db, 'pools', connection.poolId) : null;
  return { member, connection, model, poolId: pool?.id ?? 'connection:' + connection.id,
    poolLimit: pool?.maxConcurrent ?? connection.maxConcurrent };
}

export function providerConfig(connection: Connection, model: CatalogModel | null): ProviderConfig {
  if (!('baseUrl' in connection) || !model || model.connectionId !== connection.id)
    throw new CatalogError(400, '请选择此 API 连接的模型。');
  return {
    protocol: connection.kind, baseUrl: connection.baseUrl, model: model.modelId,
    credentialRef: connection.credentialRef, headerRefs: connection.headerRefs, endpoint: connection.endpoint,
    timeoutMs: connection.timeoutMs, maxOutputTokens: connection.maxOutputTokens,
    params: { ...connection.params, ...model.params },
  };
}

function checkConfig(db: DatabaseSync, key: Resource, data: Connection | CatalogModel | Member | QuotaPool, editing: boolean) {
  if (key === 'connections' && !writableConnectionSchema.safeParse(data).success) {
    throw new CatalogError(400, 'mock- 标识供模拟使用，请为真实连接选择其他标识。');
  }
  if (key === 'members' && 'role' in data) {
    const seen = new Set([data.id]);
    let superior = data.reportsTo;
    while (superior) {
      if (seen.has(superior)) throw new CatalogError(400, '直属上级不能形成循环。');
      seen.add(superior);
      superior = find(db, 'members', superior).reportsTo;
    }
    const connection = find(db, 'connections', data.connectionId);
    if (!data.modelId && 'baseUrl' in connection) throw new CatalogError(400, 'API 成员必须选择模型。');
    if (data.modelId && find(db, 'models', data.modelId).connectionId !== data.connectionId)
      throw new CatalogError(400, '模型不属于指定连接。');
  }
  if (key === 'connections' && 'kind' in data && editing && find(db, key, data.id).kind !== data.kind) {
    const used = db.prepare('SELECT 1 FROM members WHERE connection_id = ? UNION ALL SELECT 1 FROM catalog_models WHERE connection_id = ? LIMIT 1').get(data.id, data.id);
    if (used) throw new CatalogError(409, '连接已有成员或模型。请先解除关联，再更改协议。');
  }
}

function mutate(db: DatabaseSync, write: () => void) {
  db.exec('BEGIN IMMEDIATE');
  try {
    write();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    // SQLite extended result code's low byte is its primary result code.
    if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 19)
      throw new CatalogError(409, '配置标识重复、引用不存在或仍有关联记录。');
    throw error;
  }
}

export function registerConnectionRoutes(app: FastifyInstance, db: DatabaseSync, options: CatalogOptions): void {
  registerBudgets(app,db);
  const probes = new Set<Probe>();
  currentProbes.set(db, probes);
  app.addHook('preClose', async () => { cancelCatalogProbes(db); });
  const active = (filter: RunningFilter) => probeCount(db, filter) > 0 || options.isRunning(filter);
  function checkIdle(key: Resource, id: string) {
    let busy: boolean;
    if (key === 'connections') busy = active({ connectionId: id });
    else if (key === 'members') busy = active({ memberId: id });
    else if (key === 'pools') busy = active({ poolId: id });
    else {
      const members = db.prepare('SELECT id FROM members WHERE model_id = ?').all(id);
      busy = [...probes].some(p => p.modelId === id) || members.some(m => options.isRunning({ memberId: String(m.id) }));
    }
    if (busy) throw new CatalogError(409, '配置正在使用，请先停止当前执行。');
  }

  // Keep this error handler confined to catalog routes. The parent owns session and Origin checks.
  app.register(async api => {
    api.setErrorHandler((error, _request, reply) => {
      if (error instanceof BudgetExceeded || error instanceof PoolSuspended) return reply.code(409).send({error:error.message});
      if (error instanceof CatalogError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof CliDiagnosticError) return reply.code(400).send({ error: error.message });
      const code = typeof error === 'object' && error && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
      return reply.code(status).send({ error: '配置操作失败。' });
    });
    api.get('/api/catalog', async () => getCatalog(db));
    for (const key of Object.keys(entities) as Resource[]) {
      const { table, schema } = entities[key];
      const path = '/api/' + key;
      api.get(path, async () => list(db, key));
      api.get<ResourceParams>(path + '/:id', async request => find(db, key, request.params.id));
      api.post(path, async (request, reply) => {
        const data = parse(schema, request.body);
        mutate(db, () => {
          checkConfig(db, key, data, false);
          db.prepare('INSERT INTO ' + table + '(id, document) VALUES (?, ?)').run(data.id, JSON.stringify(data));
        });
        return reply.code(201).send(data);
      });
      api.put<ResourceParams>(path + '/:id', async request => {
        const data = parse(schema, request.body);
        if (data.id !== request.params.id) throw new CatalogError(400, '编辑时不能更改标识。');
        mutate(db, () => {
          find(db, key, data.id);
          checkIdle(key, data.id);
          checkConfig(db, key, data, true);
          db.prepare('UPDATE ' + table + ' SET document = ? WHERE id = ?').run(JSON.stringify(data), data.id);
        });
        return data;
      });
      api.delete<ResourceParams>(path + '/:id', async (request, reply) => {
        mutate(db, () => {
          find(db, key, request.params.id);
          checkIdle(key, request.params.id);
          db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(request.params.id);
        });
        return reply.code(204).send();
      });
    }

    function registerProbe(resource: 'connections' | 'members', mode: 'inspect' | 'test') {
      api.post<ResourceParams>('/api/' + resource + '/:id/' + mode, async (request, reply) => {
        const input = mode === 'test' ? parse(testConnectionSchema, request.body) : parse(inspectConnectionSchema, request.body);
        options.assertCanExecute?.();
        const member = resource === 'members' ? find(db, 'members', request.params.id) : undefined;
        if (member && (!member.enabled || (input.modelId && input.modelId !== member.modelId)))
          throw new CatalogError(409, '岗位已禁用或所选模型与绑定不符。');
        const connection = find(db, 'connections', member?.connectionId ?? request.params.id);
        if (connection.id.startsWith('mock-')) throw new CatalogError(409, '此旧连接标识为模拟系统保留，请重新配置。');
        if (!connection.enabled) throw new CatalogError(409, '连接已禁用。');
        const model = selectedModel(db, connection, member?.modelId ?? input.modelId);
        const pool = connection.poolId ? find(db, 'pools', connection.poolId) : null;
        const poolId = pool?.id ?? 'connection:' + connection.id;
        function limitReached(filter: RunningFilter, limit: number) {
          const used = options.runningCount?.(filter) ?? (options.isRunning(filter) ? limit : 0);
          return used + probeCount(db, filter) >= limit;
        }
        if (limitReached({ connectionId: connection.id }, connection.maxConcurrent) ||
            limitReached({ poolId }, pool?.maxConcurrent ?? connection.maxConcurrent))
          throw new CatalogError(409, '连接或额度池并发已满。');
        const workspace = db.prepare('SELECT id FROM workspaces WHERE active=1').get()?.id;
        const scope = { workspaceId:workspace ? String(workspace):undefined, memberId:member?.id, connectionId:connection.id, poolId };
        const controller = new AbortController();
        const probe = { controller, connectionId: connection.id, memberId: member?.id, modelId: model?.id, poolId };
        probes.add(probe);
        const stop = () => controller.abort();
        reply.raw.once('close', stop);
        try {
          if ('baseUrl' in connection) {
            if (mode === 'inspect') throw new CatalogError(400, 'API 连接无需 CLI 预检。');
            const start = performance.now();
            const provider = meterProvider(db,scope,createModelProvider(providerConfig(connection, model)));
            const result = await provider.validateConnection(controller.signal);
            const elapsedMs = Math.round(performance.now() - start);
            return result.ok ? { ...result, elapsedMs } : { ok: false, error: result.error.message,
              httpStatus: result.error.httpStatus, elapsedMs };
          }
          const cli = { executable: connection.executable, cwd: connection.cwd, model: model?.modelId, actionChannel:connection.actionChannel,
            confirmUnmanaged: input.confirmUnmanaged, signal: controller.signal };
          if (mode === 'inspect') return await inspectCli(connection.kind, cli);
          if (!('inspectionId' in input) || typeof input.inspectionId !== 'string') throw new CatalogError(400, '请先完成 CLI 预检。');
          const started = performance.now();
          const reservation = reserveBudget(db,scope);
          try {
            const result = await runCliProbe(connection.kind, { ...cli, approved: true, inspectionId: input.inspectionId });
            return { ok: true, text: result.text, elapsedMs: Math.round(performance.now() - started) };
          } catch (error) {
            if (error instanceof CliDiagnosticError && (error.kind === 'rate_limit' || error.kind === 'budget'))
              suspendPool(db,scope.poolId);
            throw error;
          } finally { settleBudget(db,reservation); }
        } finally {
          reply.raw.off('close', stop);
          probes.delete(probe);
        }
      });
    }
    for (const resource of ['connections', 'members'] as const) {
      registerProbe(resource, 'inspect');
      registerProbe(resource, 'test');
    }
  });
}
