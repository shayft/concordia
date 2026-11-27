import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { type z } from 'zod';
import {
  catalogModelSchema, connectionSchema, inspectConnectionSchema, memberSchema, quotaPoolSchema, testConnectionSchema,
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
  if (key === 'members' && 'role' in data) {
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
  const probes = new Map<string, AbortController>();
  app.addHook('preClose', async () => { for (const controller of probes.values()) controller.abort(); });

  const active = (connectionId: string) => probes.has(connectionId) || options.isRunning({ connectionId });
  function checkIdle(key: Resource, id: string) {
    let busy: boolean;
    if (key === 'connections') busy = active(id);
    else if (key === 'members') busy = options.isRunning({ memberId: id });
    else if (key === 'models') {
      const model = find(db, key, id);
      const members = db.prepare('SELECT id FROM members WHERE model_id = ?').all(id);
      busy = probes.has(model.connectionId) || members.some(m => options.isRunning({ memberId: String(m.id) }));
    } else {
      busy = options.isRunning({ poolId: id }) || db.prepare('SELECT id FROM connections WHERE pool_id = ?').all(id)
        .some(c => probes.has(String(c.id)));
    }
    if (busy) throw new CatalogError(409, '配置正在使用，请先停止当前执行。');
  }

  // Keep this error handler confined to catalog routes. The parent owns session and Origin checks.
  app.register(async api => {
    api.setErrorHandler((error, _request, reply) => {
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

    for (const mode of ['inspect', 'test'] as const) {
      api.post<ResourceParams>('/api/connections/:id/' + mode, async (request, reply) => {
        const connection = find(db, 'connections', request.params.id);
        const input = mode === 'test' ? parse(testConnectionSchema, request.body) : parse(inspectConnectionSchema, request.body);
        if (!connection.enabled) throw new CatalogError(409, '连接已禁用。');
        if (active(connection.id)) throw new CatalogError(409, '连接正在使用。');
        const model = selectedModel(db, connection, input.modelId);
        const controller = new AbortController();
        probes.set(connection.id, controller);
        const stop = () => controller.abort();
        reply.raw.once('close', stop);
        try {
          if ('baseUrl' in connection) {
            if (mode === 'inspect') throw new CatalogError(400, 'API 连接无需 CLI 预检。');
            const start = performance.now();
            const result = await createModelProvider(providerConfig(connection, model)).validateConnection(controller.signal);
            const elapsedMs = Math.round(performance.now() - start);
            return result.ok ? { ...result, elapsedMs } : { ok: false, error: result.error.message,
              httpStatus: result.error.httpStatus, elapsedMs };
          }
          const cli = { executable: connection.executable, cwd: connection.cwd, model: model?.modelId,
            confirmUnmanaged: input.confirmUnmanaged, signal: controller.signal };
          if (mode === 'inspect') return await inspectCli(connection.kind, cli);
          if (!('inspectionId' in input) || typeof input.inspectionId !== 'string') throw new CatalogError(400, '请先完成 CLI 预检。');
          const started = performance.now();
          const result = await runCliProbe(connection.kind, { ...cli, approved: true, inspectionId: input.inspectionId });
          return { ok: true, text: result.text, elapsedMs: Math.round(performance.now() - started) };
        } finally {
          reply.raw.off('close', stop);
          probes.delete(connection.id);
        }
      });
    }
  });
}
