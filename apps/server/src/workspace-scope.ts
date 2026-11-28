import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface BrowserWorkspace { active: string; generation: string }

/** Check both the scope the UI saw and the board instance captured before reading the request body. */
export function protectWorkspaceWrites(app: FastifyInstance, selected: () => BrowserWorkspace) {
  const captured = new WeakMap<FastifyRequest, BrowserWorkspace>();
  const isWrite = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const conflict = { error: '活动工作区已变更，请刷新页面' };
  app.addHook('onRequest', async (request, reply) => {
    if (!isWrite(request.method) || !request.routeOptions.url?.startsWith('/api/')) return;
    const workspace = selected();
    if (request.headers['x-concordia-workspace'] !== workspace.active ||
        request.headers['x-concordia-generation'] !== workspace.generation)
      return reply.code(409).send(conflict);
    captured.set(request, workspace);
  });
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/') || ![route.method].flat().some(isWrite)) return;
    const handler = route.handler;
    route.handler = function (request, reply) {
      // The original handler captures its board/worker synchronously, before its first await.
      if (captured.get(request) !== selected()) return reply.code(409).send(conflict);
      return handler.call(this, request, reply);
    };
  });
}
