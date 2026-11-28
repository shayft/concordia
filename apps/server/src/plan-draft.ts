import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const save = z.strictObject({ revision: z.number().int().min(0), text: z.string().max(120_000) });
export function servePlanDraft(app: FastifyInstance, active: () => { id: string; boardDb: DatabaseSync }) {
  const path = '/api/plan-draft/:workspace';
  app.get<{ Params: { workspace: string } }>(path, async (req, reply) => {
    const { id, boardDb } = active();
    if (req.params.workspace !== id) return reply.code(409).send({ error: '工作区已切换，请重新选择。' });
    return boardDb.prepare('SELECT text,revision FROM plan_draft WHERE singleton=1').get();
  });
  app.put<{ Params: { workspace: string } }>(path, async (req, reply) => {
    const { id, boardDb } = active();
    if (req.params.workspace !== id) return reply.code(409).send({ error: '工作区已切换，请重新选择。' });
    const body = save.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '草稿格式或长度不合要求。' });
    const row = boardDb
      .prepare(
        'UPDATE plan_draft SET text=?, revision=revision+1 WHERE singleton=1 AND revision=? RETURNING revision',
      )
      .get(body.data.text, body.data.revision);
    if (!row)
      return reply.code(409).send({ error: '另一窗口已编辑草稿。可以复制当前文字，然后载入服务端草稿。' });
    return row;
  });
}
