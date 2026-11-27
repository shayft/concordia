import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectSchema, snapshotSchema, type WorktreeService } from './worktrees/service.ts';
export { openWorktrees, WorktreeService } from './worktrees/service.ts';

/** Register only on the user-session server, never on the execution MCP channel. */
export function serveWorktrees(
  app: FastifyInstance,
  service: WorktreeService,
  assertCanExecute?: () => void,
) {
  const treeId = z.uuid();
  const tree = z.strictObject({ treeId });
  const approval = z.strictObject({ id: z.uuid() });
  function post<T>(path: string, schema: z.ZodType<T>, action: (input: T) => unknown) {
    app.post('/api/worktrees/' + path, async (req, reply) => {
      const input = schema.safeParse(req.body);
      if (!input.success) return reply.code(400).send({ error: '工作区请求字段无效。' });
      try {
        return await action(input.data);
      } catch (error) {
        const message =
          error instanceof Error && /^[\p{Script=Han}]/u.test(error.message)
            ? error.message
            : '工作区操作未完成。';
        return reply.code(409).send({ error: message });
      }
    });
  }
  app.get('/api/worktrees/state', async () => service.state());
  post('projects', projectSchema, (value) => service.configure(value));
  post('member', z.strictObject({ projectId: z.string(), taskId: z.string() }), (v) =>
    service.member(v.projectId, v.taskId),
  );
  post('publish', tree, (v) => service.publish(v.treeId));
  post('integrate', z.strictObject({ projectId: z.string(), snapshot: snapshotSchema }), (v) =>
    service.integrate(v.projectId, v.snapshot),
  );
  post('request-command', tree.extend({ name: z.string() }), (v) => service.requestCommand(v.treeId, v.name));
  post('approve-command', approval, (v) => {
    assertCanExecute?.();
    return service.approveCommand(v.id);
  });
  post('cancel-command', tree, (v) => {
    service.cancelCommand(v.treeId);
    return { cancelled: true };
  });
  post('review-merge', tree, (v) => service.reviewMerge(v.treeId));
  post('approve-merge', approval, (v) => service.approveMerge(v.id));
  post('remove', tree, (v) => service.remove(v.treeId));
}
