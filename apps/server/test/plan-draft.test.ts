import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { openStore } from '@concordia/store';
import { servePlanDraft } from '../src/plan-draft.ts';

it('工作区草稿重开可恢复；过期修订、不同工作区及额外批准字段均不可写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concordia-draft-'));
  let db = openStore(join(dir, 'a.sqlite'));
  let id = 'a';
  const app = Fastify();
  servePlanDraft(app, () => ({ id, boardDb: db }));
  const get = () => app.inject({ method: 'GET', url: '/api/plan-draft/a' });
  const put = (body: object) => app.inject({ method: 'PUT', url: '/api/plan-draft/a', payload: body });
  try {
    expect((await get()).json()).toEqual({ revision: 0, text: '' });
    const text = '未完成的工作流 {';
    expect((await put({ revision: 0, text })).json()).toEqual({ revision: 1 });
    expect((await put({ revision: 0, text: '旧窗口' })).statusCode).toBe(409);
    expect((await put({ revision: 1, text: '另一个', approved: true })).statusCode).toBe(400);
    db.close();
    db = openStore(join(dir, 'a.sqlite'));
    expect((await get()).json()).toEqual({ revision: 1, text });
    id = 'b';
    expect((await get()).statusCode).toBe(409);
    expect((await put({ revision: 1, text: '迟到' })).statusCode).toBe(409);
    db.close();
    db = openStore(join(dir, 'b.sqlite'));
    expect((await app.inject('/api/plan-draft/b')).json()).toEqual({ revision: 0, text: '' });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
