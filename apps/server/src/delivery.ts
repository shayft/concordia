import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { demoSpec, Scheduler } from '@concordia/core/workflow';
import { openStore } from '@concordia/store';
import { safeDatabasePath, safeDataDirectory } from '@concordia/store/paths';
import { WorkflowStore } from '@concordia/store/workflow';
import { git } from './worktrees/git.ts';
import { WorktreeService } from './worktrees/service.ts';
import { preflightWorktreeLedger, worktreeLedgerExpected } from './ledger-presence.ts';
import { exampleFiles } from './delivery-example.ts';

type Phase =
  | 'building'
  | 'approve-test'
  | 'testing'
  | 'review-merge'
  | 'merging'
  | 'merged'
  | 'branch-only'
  | 'interrupted'
  | 'failed';
type Ticket = ReturnType<WorktreeService['requestCommand']>;
type TestResult = Awaited<ReturnType<WorktreeService['approveCommand']>>;
type Snapshot = { taskId: string; slotId: string; versionId: string; treeId: string; sha: string }[];
type Run = {
  id: string;
  phase: Phase;
  repository: string;
  snapshot?: Snapshot;
  treeId?: string;
  branch?: string;
  command?: Ticket;
  result?: TestResult;
  review?: Ticket;
  reason?: string;
};
const approval = z.strictObject({ approved: z.literal(true), approvalId: z.uuid() });
const start = z.strictObject({ approved: z.literal(true), retryOf: z.uuid().optional() });

/** The rehearsal has its own scheduler and Git ledger, outside all user-configured projects. */
export function serveDelivery(app: FastifyInstance, dataDirectory: string, assertCanExecute?: () => void) {
  const directory = safeDataDirectory(dataDirectory, 'assignee-delivery');
  safeDataDirectory(directory, 'objects');
  const file = safeDatabasePath(directory, 'delivery.sqlite');
  preflightWorktreeLedger(directory, file);
  const db = openStore(file);
  app.addHook('onClose', async () => db.close());
  db.exec(readFileSync(new URL('./delivery.sql', import.meta.url), 'utf8'));
  const scheduler = new Scheduler({
    now: Date.now,
    nextId: randomUUID,
    storage: new WorkflowStore(db, directory),
  });
  const worktrees = new WorktreeService(directory, undefined, join(dataDirectory, 'processes'), undefined, worktreeLedgerExpected(directory, db));
  let activeRequest: Promise<void> | undefined;
  let closing = false;
  function allowed() {
    try {
      assertCanExecute?.();
      return !closing;
    } catch {
      return false;
    }
  }
  async function stop() {
    const settled = activeRequest;
    await worktrees.cancelAll();
    await settled;
  }
  app.addHook('preClose', async () => {
    closing = true;
    await stop();
  });
  app.addHook('onClose', async () => {
    await worktrees.close();
  });

  function current(): Run | undefined {
    const row = db.prepare('SELECT details FROM delivery_runs ORDER BY rowid DESC LIMIT 1').get();
    return row ? (JSON.parse(String(row.details)) as Run) : undefined;
  }
  function save(run: Run) {
    db.prepare(
      'INSERT INTO delivery_runs(id,details) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET details=excluded.details',
    ).run(run.id, JSON.stringify(run));
  }
  const previous = current();
  if (previous && ['building', 'testing', 'merging'].includes(previous.phase)) {
    scheduler.recover();
    save({
      ...previous,
      phase: 'interrupted',
      reason: '上次操作中断。保留已有仓库和分支，重新演练将创建独立仓库。',
    });
  }
  function state() {
    const run = current();
    return run
      ? { mode: 'simulated-agents', ...run, board: scheduler.board() }
      : { mode: 'simulated-agents', phase: 'idle' };
  }
  function complete(executionId: string, taskId: string, summary: string) {
    scheduler.act(executionId, { type: 'submit_result', summary });
    scheduler.control(taskId, 'accept');
  }

  function prepare(run: Run) {
    // Never reuse an existing repository or resolve the demo target from an HTTP input.
    mkdirSync(run.repository, { mode: 0o700 });
    if (safeDataDirectory(directory, 'example-' + run.id) !== run.repository)
      throw new Error('演练仓库路径已改变。');
    git(run.repository, ['init', '-b', 'main', '--template=']);
    writeFileSync(join(run.repository, 'README.md'), '# 按负责人筛选\n\nConcordia 的本地代码交付演练。\n', {
      flag: 'wx',
    });
    git(run.repository, ['add', '--', 'README.md']);
    git(run.repository, ['commit', '-m', '建立本地筛选演练的共同基线']);
    worktrees.configure({
      id: run.id,
      repository: run.repository,
      targetBranch: 'main',
      writeEnabled: true,
      commands: [{ name: 'test', executable: process.execPath, args: ['--test', 'filter.test.mjs'] }],
    });
    const spec = demoSpec();
    spec.id = run.id;
    scheduler.apply(spec);
    const api = scheduler.claim('api');
    scheduler.act(api.id, {
      type: 'publish_artifact',
      slotId: 'contract',
      content:
        'GET /tasks 返回含 id、title、assignee 的数组。指定成员用 assignee=成员；未分配用 unassigned；清除时省略参数。',
    });
    const ui = scheduler.claim('ui');
    const tests = scheduler.claim('tests');
    const clarification = scheduler.act(ui.id, {
      type: 'ask_question',
      to: 'backend',
      question: '清除筛选后是否返回所有任务？',
      blocking: true,
    }) as { id: string };
    scheduler.act(api.id, {
      type: 'answer_question',
      questionId: clarification.id,
      answer: '是，省略 assignee 即可返回全部。',
    });
    const snapshot: Snapshot = [];
    for (const [exec, slotId, files] of [
      [ui, 'frontend-code', exampleFiles.frontend],
      [tests, 'cases', exampleFiles.qa],
      [api, 'backend-code', exampleFiles.backend],
    ] as const) {
      const tree = worktrees.member(run.id, exec.taskId);
      for (const [file, source] of Object.entries(files)) worktrees.write(tree.id, file, source);
      const publication = worktrees.publishForTask(run.id, exec.taskId, tree.id);
      const version = scheduler.act(exec.id, {
        type: 'publish_artifact',
        slotId,
        kind: 'git_commit',
        content: publication.sha,
      }) as { id: string };
      snapshot.push({ ...publication, slotId, versionId: version.id });
      complete(exec.id, exec.taskId, '已发布演练成员的 Git 提交。');
    }
    const integration = worktrees.integrate(
      run.id,
      snapshot.map(({ treeId, sha }) => ({ treeId, sha })),
    );
    if (integration.conflicts.length) throw new Error('演练提交存在合并冲突。');
    const command = worktrees.requestCommand(integration.tree.id, 'test');
    save({
      ...run,
      snapshot,
      treeId: integration.tree.id,
      branch: integration.tree.branch,
      phase: 'approve-test',
      command,
    });
  }

  app.get('/api/delivery', async () => state());
  app.post('/api/delivery/start', async (req, reply) => {
    const args = start.safeParse(req.body);
    if (!args.success)
      return reply.code(400).send({ error: '需要明确批准在平台数据目录内创建本地演练仓库。' });
    const existing = current();
    if (!args.data.retryOf && existing) return state();
    if (
      args.data.retryOf &&
      (!existing ||
        existing.id !== args.data.retryOf ||
        !['failed', 'interrupted', 'merged', 'branch-only'].includes(existing.phase))
    )
      return reply.code(409).send({ error: '请重新查看当前演练状态。' });
    if (!allowed()) return reply.code(409).send({ error: '请先核对中断执行并确认服务仍可运行。' });
    const id = randomUUID();
    const run: Run = { id, phase: 'building', repository: join(directory, 'example-' + id) };
    save(run);
    try {
      prepare(run);
    } catch {
      scheduler.recover();
      save({ ...run, phase: 'failed', reason: '未完成演练准备；已保留本次创建的文件及分支。' });
      return reply.code(409).send(state());
    }
    return state();
  });

  app.post('/api/delivery/test', async (req, reply) => {
    const args = approval.safeParse(req.body);
    const run = current();
    if (!args.success) return reply.code(400).send({ error: '需要单独批准所示的项目命令。' });
    if (
      !run ||
      run.phase !== 'approve-test' ||
      !run.treeId ||
      !run.snapshot ||
      run.command?.id !== args.data.approvalId
    )
      return reply.code(409).send({ error: '项目命令票据已失效或与当前快照不符。' });
    if (!allowed()) return reply.code(409).send({ error: '请先核对中断执行并确认服务仍可运行。' });
    save({ ...run, phase: 'testing' });
    let settle!: () => void;
    activeRequest = new Promise((resolve) => {
      settle = resolve;
    });
    try {
      const execution = scheduler.claim('integrate');
      for (const v of run.snapshot) {
        if (
          execution.inputs[v.slotId] !== v.versionId ||
          scheduler.readVersion(v.versionId).content !== v.sha
        )
          throw new Error('快照已改变。');
      }
      const result = await worktrees.approveCommand(args.data.approvalId);
      if (!result.passed) {
        scheduler.fail(execution.id, 'fatal');
        save({ ...run, result, phase: 'failed', reason: '批准的项目测试失败，目标分支未更新。' });
        return reply.code(409).send(state());
      }
      scheduler.act(execution.id, {
        type: 'publish_artifact',
        slotId: 'integration',
        content: JSON.stringify({ snapshot: run.snapshot, command: run.command.name, ...result }),
      });
      complete(execution.id, 'integrate', '指定成员、未分配以及清除筛选均通过实际项目测试。');
      const reviewTask = scheduler.claim('accept');
      complete(reviewTask.id, 'accept', '模拟负责人已核对联调记录。');
      scheduler.accept();
      const review = worktrees.reviewMerge(run.treeId);
      save({ ...run, result, review, phase: 'review-merge' });
    } catch {
      scheduler.recover();
      save({ ...run, phase: 'failed', reason: '联调未完成，请检查工作区和测试命令。' });
      return reply.code(409).send(state());
    } finally {
      activeRequest = undefined;
      settle();
    }
    return state();
  });

  app.post('/api/delivery/merge', async (req, reply) => {
    const args = approval.safeParse(req.body);
    const run = current();
    if (!args.success) return reply.code(400).send({ error: '需要在审阅 diff 后批准此合并。' });
    if (!run || run.phase !== 'review-merge' || run.review?.id !== args.data.approvalId)
      return reply.code(409).send({ error: '合并票据已失效或与当前快照不符。' });
    if (!allowed()) return reply.code(409).send({ error: '请先核对中断执行并确认服务仍可运行。' });
    save({ ...run, phase: 'merging' });
    try {
      const result = worktrees.approveMerge(args.data.approvalId);
      save({
        ...run,
        phase: result.merged ? 'merged' : 'branch-only',
        branch: result.branch,
        reason: result.reason,
      });
    } catch {
      save({ ...run, phase: 'failed', reason: '合并未完成，请检查目标分支。' });
      return reply.code(409).send(state());
    }
    return state();
  });
  return { stop };
}
