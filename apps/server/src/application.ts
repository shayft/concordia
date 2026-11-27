import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { demoSpec, meetingSpec, parallelSpec, reviewSpec, Scheduler } from '@concordia/core/workflow';
import { runDemo } from '@concordia/core/demo';
import { workflowSpecSchema } from '@concordia/protocol/workflow';
import { openStore } from '@concordia/store';
import { WorkflowStore } from '@concordia/store/workflow';
import { recoverProcessGroups } from '@concordia/runtimes/process';
import { acquireDataDirectory, safeDatabasePath, safeDataDirectory } from './data-directory.ts';
import { getCatalog, registerConnectionRoutes, resolveMember, cancelCatalogProbes } from './connections.ts';
import type { WorktreeIssue } from './worktrees/service.ts';
import { openWorktrees, serveWorktrees } from './worktrees.ts';
import { Worker, runOptions } from './worker.ts';
import { pausedPools, resumeSharedPool } from './budget-ledger.ts';
import { auditEvent, serveAuditExport } from './audit.ts';
import { serveExecutionCosts } from './execution-cost.ts';
import { serveDelivery } from './delivery.ts';

const text = z.string().trim().min(1).max(8000);
const approval = z.literal(true);
const identifier = z.string().min(1).max(128);
const taskOp = z.enum(['cancel', 'pause', 'resume', 'retry', 'accept', 'rework', 'reassign']);
const empty = z.strictObject({});
function rejected(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      error: '参数、动作或工作流格式无效',
      fields: error.issues.slice(0, 8).map((i) => i.path.join('.')),
    });
  // Native, network, model, and database diagnostics must not reach the UI.
  const message =
    error instanceof Error && /^[\u4e00-\u9fff][\u4e00-\u9fff，。、：或\s]{1,95}$/u.test(error.message)
      ? error.message
      : '操作无法在当前状态或权限下完成';
  return reply.code(409).send({ error: message });
}
export async function registerApplication(app: FastifyInstance, path: string) {
  const lease = acquireDataDirectory(path),
    directory = lease.directory;
  app.addHook('onClose', async () => lease.release());
  const recovery = await recoverProcessGroups(safeDataDirectory(directory, 'processes'));
  const assertRecovered = () => {
    if (recovery.unresolved.length) throw new Error('上次执行的进程尚待人工核对');
  };
  const db = openStore(safeDatabasePath(directory, 'catalog.sqlite'));
  app.addHook('onClose', async () => db.close());
  db.prepare("UPDATE plan_requests SET status='interrupted',finished=? WHERE status='running'").run(
    Date.now(),
  );
  db.prepare("INSERT OR IGNORE INTO workspaces VALUES('default','默认工作区',1)").run();
  const trees = openWorktrees(directory, syncConflict);
  app.addHook('onClose', async () => trees.close());
  const workspaces = () =>
    db.prepare('SELECT id,name FROM workspaces ORDER BY rowid').all() as { id: string; name: string }[];
  function openBoard(id: string) {
    const dir = safeDataDirectory(directory, 'boards', id);
    const boardDb = openStore(safeDatabasePath(dir, 'workspace.sqlite'));
    const scheduler = new Scheduler({
      storage: new WorkflowStore(boardDb, dir),
      now: Date.now,
      nextId: randomUUID,
    });
    const worker = new Worker(scheduler, db, trees, directory, id, () => {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('本地服务未监听');
      return 'http://127.0.0.1:' + address.port;
    });
    scheduler.recover();
    // A user may have resumed a shared account from a different workspace.
    const board = scheduler.board();
    const shared = pausedPools(db);
    for (const pool of board.stoppedPools) {
      if (
        !shared.includes(pool) &&
        board.agents.some((agent) => !agent.connection.startsWith('mock-') && agent.pool === pool)
      ) {
        scheduler.resumePool(pool);
      }
    }
    return { id, scheduler, worker, close: () => boardDb.close() };
  }
  let current = openBoard(String(db.prepare('SELECT id FROM workspaces WHERE active=1').get()!.id));
  const feeds = new Set<() => void>();
  function closeFeeds() {
    for (const stop of [...feeds]) stop();
  }
  app.addHook('preClose', async () => {
    closeFeeds();
    cancelCatalogProbes(db);
    await Promise.all([current.worker.shutdown(), trees.cancelAll()]);
  });
  app.addHook('onClose', async () => current.close());
  // Task names may repeat in different plans. Route an issue only when all source
  // commits were actually published as versions on the currently selected board.
  function syncConflict(issue: WorktreeIssue): void {
    const snapshot = trees.issueSnapshot(issue.treeId);
    if (!issue.taskIds.length || !snapshot.length) return;
    const board = current.scheduler.board();
    if (!issue.taskIds.every((id) => board.tasks.some((task) => task.id === id))) return;
    for (const source of snapshot) {
      const rows = db
        .prepare('SELECT execution FROM version_sources WHERE workspace=? AND project=? AND tree=? AND sha=?')
        .all(current.id, issue.projectId, source.treeId, source.sha);
      if (
        !rows.some((row) =>
          board.versions.some(
            (v) =>
              v.kind === 'git_commit' &&
              v.executionId === row.execution &&
              current.scheduler.readVersion(v.id).content === source.sha,
          ),
        )
      )
        return;
    }
    const paths = issue.paths
      .filter((path) => path.length <= 1024 && !path.startsWith('/') && !path.includes('\0'))
      .sort()
      .slice(0, 256);
    current.scheduler.reportConflict({ ...issue, paths });
  }
  for (const issue of trees.issues()) syncConflict(issue);
  app.addHook('onRequest', async (req, reply) => {
    const scope = req.headers['x-concordia-workspace'];
    if (scope !== undefined && scope !== current.id && req.method !== 'GET')
      return reply.code(409).send({ error: '活动工作区已变更，请刷新页面' });
  });
  registerConnectionRoutes(app, db, {
    isRunning: (f) => current.worker.editingBlocked(f),
    runningCount: (f) => current.worker.count(f),
    assertCanExecute: assertRecovered,
  });
  serveWorktrees(app, trees, assertRecovered, () =>
    current.scheduler.board().spec ? current.worker.treeScope() : undefined,
  );
  serveAuditExport(app, () => current.scheduler.board());
  serveExecutionCosts(app, () => current.scheduler.board().executions);
  const delivery = serveDelivery(app, directory, assertRecovered);

  function switchBoard(id: string) {
    if (current.id === id) return;
    if (current.worker.occupied()) throw new Error('工作区仍有执行或已授权批次');
    if (!workspaces().some((w) => w.id === id)) throw new Error('工作区不存在');
    const next = openBoard(id);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE workspaces SET active=0 WHERE active=1').run();
      db.prepare('UPDATE workspaces SET active=1 WHERE id=?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      next.close();
      throw e;
    }
    closeFeeds();
    current.close();
    current = next;
    for (const issue of trees.issues()) syncConflict(issue);
  }
  function checkedSpec(raw: unknown) {
    const spec = workflowSpecSchema.parse(raw);
    for (const agent of spec.agents) {
      if (agent.connection.startsWith('mock-')) continue;
      const selected = resolveMember(db, agent.id);
      if (selected.connection.id !== agent.connection) throw new Error('计划与成员当前连接不匹配');
      // Pool identity and concurrency are user-owned. A generated plan may only lower a limit.
      const pool = selected.poolId;
      if (agent.pool !== undefined && agent.pool !== pool) throw new Error('计划中的额度池不匹配');
      agent.pool = pool;
      spec.poolLimits[pool] = Math.min(spec.poolLimits[pool] ?? selected.poolLimit, selected.poolLimit);
    }
    return spec;
  }
  app.get('/api/board', async () => {
    const { receipts: _, wakeups: __, ...board } = current.scheduler.board();
    void _;
    void __;
    return { ...board, stoppedPools: [...new Set([...board.stoppedPools, ...pausedPools(db)])] };
  });
  app.get('/api/workspaces', async () => ({ active: current.id, workspaces: workspaces() }));
  app.get('/api/recovery', async () => recovery);
  app.get('/api/templates/demo', async () => demoSpec());
  app.get('/api/tasks/:id/progress', async (req, reply) => {
    try {
      return current.scheduler.readProgress(z.object({ id: identifier }).parse(req.params).id);
    } catch (error) {
      return rejected(reply, error);
    }
  });
  app.get('/api/versions/:id', async (req, reply) => {
    try {
      return current.scheduler.readVersion(z.object({ id: identifier }).parse(req.params).id);
    } catch (e) {
      return rejected(reply, e);
    }
  });
  app.get('/api/history', async (req, reply) => {
    try {
      return current.scheduler
        .events(z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query).after)
        .map(auditEvent);
    } catch (e) {
      return rejected(reply, e);
    }
  });
  app.get('/api/events', async (req, reply) => {
    let sequence = Number(req.headers['last-event-id'] ?? 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) return reply.code(400).send();
    reply.hijack();
    const output = reply.raw;
    output.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    output.write(': connected\n\n');
    const send = () => {
      if (output.destroyed || output.writableEnded) return stop();
      try {
        for (const event of current.scheduler.events(sequence)) {
          if (output.writableLength > 262144) return stop();
          output.write('id: ' + event.seq + '\ndata: ' + JSON.stringify(auditEvent(event)) + '\n\n');
          sequence = event.seq;
        }
      } catch {
        stop();
      }
    };
    const timer = setInterval(send, 250);
    timer.unref();
    function stop() {
      clearInterval(timer);
      feeds.delete(stop);
      output.end();
    }
    feeds.add(stop);
    output.once('close', stop);
    send();
  });
  function post<T extends z.ZodType>(
    url: string,
    schema: T,
    handler: (data: z.output<T>, params: Record<string, string>) => unknown,
  ) {
    app.post<{ Params: Record<string, string> }>(url, async (req, reply) => {
      try {
        return await handler(schema.parse(req.body ?? {}), req.params);
      } catch (e) {
        return rejected(reply, e);
      }
    });
  }
  post('/api/workspaces', z.strictObject({ name: text.max(120) }), ({ name }) => {
    if (current.worker.occupied()) throw new Error('工作区正在运行');
    const id = randomUUID();
    db.prepare('INSERT INTO workspaces(id,name,active) VALUES(?,?,0)').run(id, name);
    switchBoard(id);
    return { active: id };
  });
  post('/api/workspaces/:id/select', empty, (_, p) => {
    switchBoard(p.id);
    return { active: current.id };
  });
  for (const type of ['meeting', 'parallel', 'review'])
    post(
      '/api/templates/' + type,
      z.strictObject({ goal: text, members: z.array(identifier).min(1).max(30) }),
      ({ goal, members }) => {
        if (type === 'review' && members.length < 2) throw new Error('审查需要生产者和审查者');
        const spec =
          type === 'review'
            ? reviewSpec(goal, members[0], members.slice(1))
            : type === 'parallel'
              ? parallelSpec(goal, members)
              : meetingSpec(goal, members);
        const catalog = getCatalog(db);
        for (const agent of spec.agents) {
          const member = catalog.members.find((m) => m.id === agent.id);
          if (!member) throw new Error('会议成员不存在');
          agent.connection = member.connectionId;
          agent.name = member.name;
        }
        return checkedSpec(spec);
      },
    );
  post('/api/spec/preview', z.strictObject({ spec: z.unknown() }), ({ spec }) =>
    current.scheduler.preview(checkedSpec(spec)),
  );
  post(
    '/api/spec/apply',
    z.strictObject({ spec: z.unknown(), expectedRevision: z.number().int().min(0), approved: approval }),
    (input) => {
      if (current.worker.occupied()) throw new Error('请先停止当前运行');
      return current.scheduler.apply(checkedSpec(input.spec), input.expectedRevision);
    },
  );
  post('/api/demo/run', empty, () => {
    if (current.worker.occupied()) throw new Error('请先停止当前运行');
    return runDemo(current.scheduler);
  });
  post('/api/tasks/:id/run', runOptions, (opts, p) => {
    assertRecovered();
    return current.worker.start(p.id, opts);
  });
  post(
    '/api/tasks/:id/control',
    z.strictObject({ action: taskOp, owner: identifier.optional() }),
    (data, p) => {
      if (data.action === 'reassign') current.scheduler.reassign(p.id, identifier.parse(data.owner));
      else current.scheduler.control(p.id, data.action);
      if (['reassign', 'pause', 'cancel', 'rework'].includes(data.action)) current.worker.cancelTask(p.id);
      return { ok: true };
    },
  );
  post('/api/accept', empty, () => ({ snapshot: current.scheduler.accept() }));
  post(
    '/api/dispatch',
    z.strictObject({ maxCalls: z.number().int().min(1).max(50), approved: approval }),
    ({ maxCalls }) => {
      assertRecovered();
      return current.worker.startBatch(maxCalls);
    },
  );
  post('/api/stop', empty, async () => {
    current.worker.stop();
    cancelCatalogProbes(db);
    await Promise.all([current.worker.drain(), trees.cancelAll(), delivery.stop()]);
    return { ok: true };
  });
  post('/api/pools/:id/resume', empty, (_, p) => {
    resumeSharedPool(db, p.id);
    current.scheduler.resumePool(p.id);
    return { ok: true };
  });
  post('/api/questions/:id/answer', z.strictObject({ answer: text }), ({ answer }, p) => {
    current.scheduler.answerAsUser(p.id, answer);
    return { ok: true };
  });
  post('/api/tasks/:id/message', z.strictObject({ message: text }), ({ message }, p) => {
    current.scheduler.sendAsUser(p.id, message);
    return { ok: true };
  });
  post(
    '/api/plans/generate',
    z.strictObject({
      goal: text,
      agentId: identifier,
      approved: approval,
      confirmUnmanaged: z.boolean().optional(),
      inspectionId: z.string().max(128).optional(),
    }),
    async (input) => {
      assertRecovered();
      return current.worker.generate(input.goal, input.agentId, input, checkedSpec);
    },
  );
  app.post<{ Params: { id: string } }>('/mcp/:id', async (req, reply) => {
    const header = req.headers['mcp-protocol-version'];
    const result = await current.worker.mcp.handle({
      executionId: req.params.id,
      authorization: req.headers.authorization,
      protocolVersion: typeof header === 'string' ? header : undefined,
      body: req.body,
    });
    return reply.code(result.status).send(result.body);
  });
}
