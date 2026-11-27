import { afterEach, beforeEach, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serveDelivery } from '../src/delivery.ts';
import { exampleFiles } from '../src/delivery-example.ts';
import { git } from '../src/worktrees/git.ts';

let root: string;
let app: FastifyInstance;
let control: ReturnType<typeof serveDelivery>;
let permitted: boolean;
function open() {
  app = Fastify();
  control = serveDelivery(app, root, () => {
    if (!permitted) throw new Error('unresolved');
  });
}
beforeEach(() => {
  permitted = true;
  root = mkdtempSync(join(tmpdir(), 'concordia-delivery-'));
  open();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
function post(path: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/delivery/' + path, payload: body });
}
async function reopen() {
  await app.close();
  open();
}
it('keeps the target untouched until two separate approvals, and reopens the reviewed snapshot', async () => {
  expect((await app.inject('/api/delivery')).json()).toMatchObject({
    phase: 'idle',
    mode: 'simulated-agents',
  });
  expect((await post('start', {})).statusCode).toBe(400);
  expect(readdirSync(join(root, 'assignee-delivery')).filter((f) => f.startsWith('example-'))).toHaveLength(
    0,
  );
  const response = await post('start', { approved: true });
  expect(response.statusCode, response.body).toBe(200);
  const started = response.json();
  expect(started).toMatchObject({
    phase: 'approve-test',
    command: { name: 'test', executable: process.execPath, args: ['--test', 'filter.test.mjs'] },
  });
  expect(started.snapshot).toHaveLength(3);
  expect(new Set(started.snapshot.map((s: { treeId: string }) => s.treeId)).size).toBe(3);
  expect(new Set(started.snapshot.map((s: { sha: string }) => s.sha)).size).toBe(3);
  const api = started.board.executions.find((e: { taskId: string }) => e.taskId === 'api');
  const upstream = started.board.versions.find((v: { slotId: string }) => v.slotId === 'contract');
  for (const downstream of started.board.executions.filter(
    (e: { taskId: string }) => e.taskId === 'ui' || e.taskId === 'tests',
  )) {
    expect(downstream.inputs.contract).toBe(upstream.id);
    expect(downstream.started).toBeLessThanOrEqual(api.ended);
  }
  const base = git(started.repository, ['rev-parse', 'HEAD']).trim();
  expect(existsSync(join(started.repository, 'api.mjs'))).toBe(false);
  expect(started.board.tasks.find((t: { id: string }) => t.id === 'integrate').status).toBe('ready');
  expect(started.board.questions).toEqual([
    expect.objectContaining({ from: 'frontend', to: 'backend', status: 'answered' }),
  ]);
  expect((await post('start', { approved: true })).json().command.id).toBe(started.command.id);
  expect((await post('merge', { approved: true, approvalId: started.command.id })).statusCode).toBe(409);
  await reopen();
  expect((await app.inject('/api/delivery')).json().snapshot).toEqual(started.snapshot);
  const tested = await post('test', { approved: true, approvalId: started.command.id });
  expect(tested.statusCode, tested.body).toBe(200);
  const reviewed = tested.json();
  expect(reviewed).toMatchObject({
    phase: 'review-merge',
    result: { exitCode: 0, passed: true },
    review: { targetSha: base, sha: started.command.sha },
  });
  expect(reviewed.review.diff).toContain('diff --git a/filter.test.mjs');
  expect(reviewed.board.acceptance.integration).toBeTruthy();
  expect(git(started.repository, ['rev-parse', 'HEAD']).trim()).toBe(base);
  expect((await post('test', { approved: true, approvalId: started.command.id })).statusCode).toBe(409);
  await reopen();
  expect((await post('merge', { approved: true, approvalId: reviewed.review.id })).json().phase).toBe(
    'merged',
  );
  expect((await post('merge', { approved: true, approvalId: reviewed.review.id })).statusCode).toBe(409);
  expect(git(started.repository, ['rev-parse', 'HEAD']).trim()).toBe(reviewed.review.sha);
  expect(readFileSync(join(started.repository, 'api.mjs'), 'utf8')).toContain('handleTasks');
  expect(git(started.repository, ['remote'])).toBe('');
}, 60_000);
it('an interrupted rehearsal never launches another command or repurposes the previous repository', async () => {
  const started = (await post('start', { approved: true })).json();
  await app.close();
  const db = new DatabaseSync(join(root, 'assignee-delivery', 'delivery.sqlite'));
  const row = db.prepare('SELECT details FROM delivery_runs WHERE id=?').get(started.id);
  db.prepare('UPDATE delivery_runs SET details=? WHERE id=?').run(
    JSON.stringify({ ...JSON.parse(String(row?.details)), phase: 'testing' }),
    started.id,
  );
  db.close();
  open();
  expect((await app.inject('/api/delivery')).json().phase).toBe('interrupted');
  writeFileSync(join(started.repository, 'personal-notes'), 'keep');
  expect((await post('start', { approved: true })).json().id).toBe(started.id);
  const next = (await post('start', { approved: true, retryOf: started.id })).json();
  expect(next.phase).toBe('approve-test');
  expect(next.repository).not.toBe(started.repository);
  expect(readFileSync(join(started.repository, 'personal-notes'), 'utf8')).toBe('keep');
}, 60_000);

it('blocks new side effects while process recovery is unresolved without losing the approval', async () => {
  permitted = false;
  expect((await post('start', { approved: true })).statusCode).toBe(409);
  expect((await app.inject('/api/delivery')).json().phase).toBe('idle');
  permitted = true;
  const ready = (await post('start', { approved: true })).json();
  permitted = false;
  expect((await post('test', { approved: true, approvalId: ready.command.id })).statusCode).toBe(409);
  permitted = true;
  const review = (await post('test', { approved: true, approvalId: ready.command.id })).json();
  permitted = false;
  expect((await post('merge', { approved: true, approvalId: review.review.id })).statusCode).toBe(409);
  expect((await app.inject('/api/delivery')).json().phase).toBe('review-merge');
}, 60_000);

it('global stop waits for an active demonstration command and records its termination', async () => {
  const original = exampleFiles.qa['filter.test.mjs'];
  let ready;
  try {
    exampleFiles.qa['filter.test.mjs'] =
      "import {setTimeout} from 'node:timers/promises'; await setTimeout(30_000);";
    ready = (await post('start', { approved: true })).json();
  } finally {
    exampleFiles.qa['filter.test.mjs'] = original;
  }
  const request = post('test', { approved: true, approvalId: ready.command.id }).then((r) => r.statusCode);
  const deadline = Date.now() + 10000;
  while ((await app.inject('/api/delivery')).json().phase !== 'testing') {
    if (Date.now() > deadline) throw new Error('测试未启动');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await control.stop();
  expect(await request).toBe(409);
  expect((await app.inject('/api/delivery')).json().phase).toBe('failed');
  expect(git(ready.repository, ['rev-parse', 'HEAD']).trim()).toBe(ready.command.targetSha);
}, 60_000);
