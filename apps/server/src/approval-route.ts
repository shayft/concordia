import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Scheduler } from '@concordia/core/workflow';
import type { Connection, CatalogModel, Member } from '@concordia/protocol/connections';
import { modelEndpoint } from '@concordia/providers/model-endpoint';
import { getCatalog, resolveMember, providerConfig } from './connections.ts';

const id = z.string().min(1).max(180);
const querySchema = z.strictObject({
  purpose: z.enum(['task', 'dispatch', 'plan', 'connection-test', 'member-test']),
  id: id.optional(), modelId: id.optional(), projectId: id.optional(), treeId: id.optional(),
});
type Selection = z.infer<typeof querySchema>;
type Binding = { connection: Connection; model?: CatalogModel | null; member?: Member; poolId: string; poolLimit: number };
type Context = { id: string; scheduler: Scheduler; generation: string };

function selectionFor(request: FastifyRequest): Selection | undefined {
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (body.approved !== true) return;
  const { id } = request.params as { id?: string };
  const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
  switch (request.routeOptions.url) {
    case '/api/tasks/:id/run':
      if (body.mode !== 'live') return;
      return { purpose: 'task', id, projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        treeId: typeof body.treeId === 'string' ? body.treeId : undefined };
    case '/api/plans/generate': return { purpose: 'plan', id: String(body.agentId) };
    case '/api/dispatch': return { purpose: 'dispatch' };
    case '/api/connections/:id/test': return { purpose: 'connection-test', id, modelId };
    case '/api/members/:id/test': return { purpose: 'member-test', id, modelId };
  }
}

export function protectPaidCalls(app: FastifyInstance, db: DatabaseSync, workspace: () => Context) {
  function preview(raw: Selection) {
    const selection = querySchema.parse(raw);
    const current = workspace();
    const board = current.scheduler.board();
    const bindings: Binding[] = [];
    if (selection.purpose === 'task' || selection.purpose === 'dispatch') {
      const target = board.tasks.find((t) => t.id === selection.id);
      if (selection.purpose === 'task' && !target) throw new Error();
      const agents = target ? board.agents.filter((a) => a.id === target.owner) : board.agents;
      for (const agent of agents) {
        if (agent.connection.startsWith('mock-')) continue;
        const selected = resolveMember(db, agent.id);
        if (selected.connection.id !== agent.connection) throw new Error();
        bindings.push(selected);
      }
    } else if (selection.purpose === 'connection-test') {
      const catalog = getCatalog(db);
      const connection = catalog.connections.find((c) => c.id === selection.id && c.enabled);
      if (!connection) throw new Error();
      const model = catalog.models.find((m) => m.id === selection.modelId && m.connectionId === connection.id && m.enabled);
      if (!model && (selection.modelId || 'baseUrl' in connection)) throw new Error();
      const pool = catalog.pools.find((p) => p.id === connection.poolId);
      bindings.push({ connection, model, poolId: pool?.id ?? 'connection:' + connection.id, poolLimit: pool?.maxConcurrent ?? connection.maxConcurrent });
    } else {
      const binding = resolveMember(db, selection.id ?? '');
      if (selection.modelId && selection.modelId !== binding.model?.id) throw new Error();
      bindings.push(binding);
    }
    const route = bindings.map(({ connection: c, model, member, poolId }) => ({
      connection: c.name + ' (' + c.id + ')', protocol: c.kind, member: member?.name,
      individual: selection.purpose === 'dispatch' && !('baseUrl' in c),
      destination: 'baseUrl' in c ? modelEndpoint(providerConfig(c, model ?? null), selection.purpose.endsWith('-test') ? false : c.stream).href : (c.executable ?? c.kind),
      model: model?.modelId ?? 'CLI 默认模型',
      credentials: 'baseUrl' in c ? [c.credentialRef, ...Object.values(c.headerRefs ?? {})].filter(Boolean) : [],
      permissions: ['connection-test', 'member-test', 'plan'].includes(selection.purpose) ? '仅生成文本'
        : member?.allowedActions === undefined ? '岗位默认动作' : member.allowedActions.join('、') || '无平台动作',
      pool: poolId,
    }));
    // Zod normalises key order for the GET snapshot and its matching POST selection.
    const stamp = createHash('sha256').update(JSON.stringify({
      workspace: current.id, generation: current.generation, plan: board.spec?.id, revision: board.revision,
      selection, bindings, agents: board.agents.map((a) => [a.id, a.role]),
    })).digest('hex');
    return { stamp, routes: route, revision: board.revision,
      simulated: selection.purpose === 'dispatch' ? board.agents.filter((a) => a.connection.startsWith('mock-')).map((a) => a.name) : [],
    };
  }
  app.get('/api/approval-route', async (request, reply) => {
    try { return preview(querySchema.parse(request.query)); }
    catch { return reply.code(409).send({ error: '当前绑定无法用于本次调用，请检查连接、模型和计划。' }); }
  });
  app.addHook('onRoute', (route) => {
    if (route.method !== 'POST' || !route.url.startsWith('/api/')) return;
    const handler = route.handler;
    route.handler = function (req, reply) {
      const selection = selectionFor(req);
      if (selection) {
        try {
          const expected = req.headers['x-concordia-approval'];
          if (typeof expected !== 'string' || expected !== preview(selection).stamp) throw new Error();
        } catch {
          return reply.code(409).send({ error: '调用配置或计划已改变，请重新查看调用信息后批准。' });
        }
      }
      return handler.call(this, req, reply);
    };
  });
}
