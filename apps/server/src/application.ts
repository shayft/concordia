import { PlanningRequests } from './planning-requests.ts';
import { planningRosterSchema } from '@concordia/protocol/planning';
import { servePlanDraft } from './plan-draft.ts';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CliDiagnosticError } from '@concordia/runtimes';
import { z } from 'zod';
import { demoSpec, meetingSpec, parallelSpec, reviewSpec, Scheduler } from '@concordia/core/workflow';
import { runDemo } from '@concordia/core/demo';
import { acceptanceSnapshotSchema, workflowSpecSchema } from '@concordia/protocol/workflow';
import { openCatalog, worktreeLedgerExpected } from './ledger-presence.ts';
import { initialWorkspace, openWorkspaceStore } from './workspace-storage.ts';
import { WorkflowStore } from '@concordia/store/workflow';
import { startProcessRecovery } from '@concordia/runtimes/process';
import { acquireDataDirectory, safeDataDirectory } from './data-directory.ts';
import { getCatalog, registerConnectionRoutes, resolveMember, cancelCatalogProbes } from './connections.ts';
import type { WorktreeIssue } from './worktrees/service.ts';
import { openWorktrees, serveWorktrees } from './worktrees.ts';
import { acceptedCommits } from './worktrees/acceptance.ts';
import { Worker, runOptions } from './worker.ts';
import { pausedPools, resumeSharedPool } from './budget-ledger.ts';
import { reconcileApprovedExecutions, registerGovernance } from './governance.ts';
import { serveAuditExport } from './audit.ts';
import { eventPage, historyQuery, streamHistory } from './event-history.ts';
import { serveExecutionCosts } from './execution-cost.ts';
import { protectPaidCalls } from './approval-route.ts';
import { protectWorkspaceWrites } from './workspace-scope.ts';
import { serveDelivery } from './delivery.ts';

const text = z.string().trim().min(1).max(8000);
const approval = z.literal(true);
const identifier = z.string().min(1).max(128);
const taskControl = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['cancel', 'pause', 'resume', 'retry']) }),
  z.strictObject({ action: z.enum(['accept', 'rework']), expectedExecutionId: identifier }),
  z.strictObject({ action: z.literal('reassign'), owner: identifier }),
]);
const empty = z.strictObject({});
function rejected(reply: FastifyReply, error: unknown) {
  if (error instanceof CliDiagnosticError) return reply.code(409).send({ error: error.message });
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
  const db = openCatalog(directory);
  app.addHook('onClose', async () => db.close());
  const recovery = await startProcessRecovery(safeDataDirectory(directory, 'processes'));
  const assertRecovered = () => {
    if (recovery.report().unresolved.length) throw new Error('上次执行的进程尚待人工核对');
  };
  db.prepare("UPDATE plan_requests SET status='interrupted',phase='finished',finished=? WHERE status='running'").run(
    Date.now(),
  );
  const trees = openWorktrees(directory, syncConflict, undefined, (scope, project, inputs) =>
    acceptedCommits(current.scheduler, db, current.id, scope, project, inputs), worktreeLedgerExpected(directory, db));
  app.addHook('onClose', async () => trees.close());
  const workspaces = () =>
    db.prepare('SELECT id,name FROM workspaces ORDER BY rowid').all() as { id: string; name: string }[];
  function openBoard(id: string, create: boolean) {
    const { dir, boardDb } = openWorkspaceStore(directory, id, create);
    try {
      const storage = new WorkflowStore(boardDb, dir);
      const scheduler = new Scheduler({
        storage,
        now: Date.now,
        nextId: randomUUID,
      });
      const requests = new PlanningRequests(db, id, dir);
      const worker = new Worker(scheduler, db, trees, directory, id, requests, () => {
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('本地服务未监听');
        return 'http://127.0.0.1:' + address.port;
      });
      scheduler.recover();
      reconcileApprovedExecutions(db, id, storage);
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
      return { id, boardDb, scheduler, worker, close: () => boardDb.close() };
    } catch (error) {
      boardDb.close();
      throw error;
    }
  }
  let current = initialWorkspace(db, directory, openBoard);
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
  let browserWorkspace = { active: current.id, generation: randomUUID() };
  protectWorkspaceWrites(app, () => browserWorkspace);
  protectPaidCalls(app, db, () => ({ ...current, generation: browserWorkspace.generation }));
  registerConnectionRoutes(app, db, {
    isRunning: (f) => current.worker.editingBlocked(f),
    runningCount: (f) => current.worker.count(f),
    assertCanExecute: assertRecovered,
  });
  serveWorktrees(app, trees, assertRecovered, () =>
    current.scheduler.board().spec ? current.worker.treeScope() : undefined,
    (id) => current.worker.revokeProjectWrites(id),
  );
  registerGovernance(app, db, () => current.id);
  serveAuditExport(app, () => current.scheduler.board());
  serveExecutionCosts(app, () => current.scheduler.board().executions);
  const delivery = serveDelivery(app, directory, assertRecovered);

  function switchBoard(id: string, newName?: string) {
    if (current.id === id) return;
    if (current.worker.occupied()) throw new Error('工作区仍有执行或已授权批次');
    current.worker.requests.flushInterrupted();
    if (!newName && !workspaces().some((w) => w.id === id)) throw new Error('工作区不存在');
    const next = openBoard(id, newName !== undefined);
    try {
      db.exec('BEGIN IMMEDIATE');
      if (newName) db.prepare('INSERT INTO workspaces(id,name,active) VALUES(?,?,0)').run(id, newName);
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
    browserWorkspace = { active: id, generation: randomUUID() };
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
  servePlanDraft(app, () => current);
  app.get('/api/workspaces', async () => ({ ...browserWorkspace, workspaces: workspaces() }));
  app.get('/api/recovery', async () => recovery.report());
  app.post('/api/recovery/recheck', async (req, reply) => {
    if (!empty.safeParse(req.body).success) return reply.code(400).send();
    return recovery.recheck();
  });
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
  app.get('/api/history/page', async (req, reply) => {
    try {
      return eventPage(current.boardDb, historyQuery.parse(req.query));
    } catch (error) { return rejected(reply, error); }
  });
  app.get('/api/history', async (req, reply) => {
    try {
      const { after, limit } = historyQuery.parse(req.query);
      const page = eventPage(current.boardDb, { after: after ?? 0, limit });
      if (page.hasMore) reply.header('link', '</api/history?after=' + page.events.at(-1)!.seq + '>; rel="next"');
      return page.events;
    } catch (error) { return rejected(reply, error); }
  });
  app.get('/api/events', async (req, reply) => {
    const query = z.strictObject({ tail: z.literal('1').optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send();
    const tail = query.data.tail && req.headers['last-event-id'] === undefined;
    const sequence = tail
      ? Number(current.boardDb.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM workflow_events').get()!.seq)
      : Number(req.headers['last-event-id'] ?? 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) return reply.code(400).send();
    reply.hijack();
    const output = reply.raw;
    output.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    output.write(tail ? 'id: ' + sequence + '\n: connected\n\n' : ': connected\n\n');
    const stop = streamHistory(output, current.boardDb, sequence, () => feeds.delete(stop));
    feeds.add(stop);
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
    switchBoard(id, name);
    return { active: id };
  });
  post('/api/workspaces/:id/select', empty, (_, p) => {
    switchBoard(p.id);
    return { active: current.id };
  });
  app.get('/api/plans', async () => current.scheduler.plans());
  app.get<{Params: {id:string}}>('/api/plans/:id/spec', async (req, reply) => {
    try { return current.scheduler.planSpec(identifier.parse(req.params.id)); }
    catch (error) { return rejected(reply, error); }
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
        spec.id = type + '-' + randomUUID();
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
  post('/api/spec/preview', z.strictObject({ spec: z.unknown(), revisionOf: identifier.optional() }), ({ spec, revisionOf }) =>
    current.scheduler.preview(checkedSpec(spec), revisionOf),
  );
  post(
    '/api/spec/apply',
    z.strictObject({ spec: z.unknown(), revisionOf: identifier.optional(), expectedRevision: z.number().int().min(0), approved: approval }),
    (input) => {
      if (current.worker.occupied()) throw new Error('请先停止当前运行');
      return current.scheduler.apply(checkedSpec(input.spec), input.expectedRevision, input.revisionOf);
    },
  );
  post('/api/proposals/:id/preview', empty, (_, p) => current.scheduler.previewProposal(identifier.parse(p.id)));
  post('/api/proposals/:id/decide', z.strictObject({
    decision: z.enum(['approved', 'rejected']),
    expected: z.strictObject({
      proposalId: identifier, planId: identifier, revision: z.number().int().min(0),
      target: z.strictObject({
        status: z.enum(['waiting','ready','running','decision','review','paused','done','failed','cancelled']),
        executionId: identifier.nullable(),
      }).nullable(),
    }),
  }), ({ decision, expected }, p) =>
    current.scheduler.decideProposal(identifier.parse(p.id), decision, expected, spec => {
      if (current.worker.occupied()) throw new Error('请先停止当前运行');
      if (JSON.stringify(checkedSpec(spec)) !== JSON.stringify(spec)) throw new Error('成员配置已改变，请重新核对计划');
    }));
  post('/api/demo/run', empty, () => {
    if (current.worker.occupied()) throw new Error('请先停止当前运行');
    return runDemo(current.scheduler);
  });
  post('/api/tasks/:id/inspect', z.strictObject({
    confirmUnmanaged: z.boolean().optional(), projectId: identifier.optional(), treeId: z.uuid().optional(),
  }).refine(x => Boolean(x.projectId) === Boolean(x.treeId)), (input, p) => {
    assertRecovered();
    return current.worker.inspectExecution({ taskId: p.id, projectId: input.projectId, treeId: input.treeId }, input.confirmUnmanaged);
  });
  post('/api/plans/inspect', z.strictObject({ agentId: identifier, confirmUnmanaged: z.boolean().optional() }), input => {
    assertRecovered();
    return current.worker.inspectExecution({ planner: input.agentId }, input.confirmUnmanaged);
  });
  post('/api/tasks/:id/run', runOptions, (opts, p) => {
    assertRecovered();
    return current.worker.start(p.id, opts);
  });
  post(
    '/api/tasks/:id/control',
    taskControl,
    (data, p) => {
      if (data.action === 'reassign') current.scheduler.reassign(p.id, identifier.parse(data.owner));
      else current.scheduler.control(p.id, data.action, 'expectedExecutionId' in data ? data.expectedExecutionId : undefined);
      if (['reassign', 'pause', 'cancel', 'rework'].includes(data.action)) current.worker.cancelTask(p.id);
      return { ok: true };
    },
  );
  post('/api/accept', z.strictObject({ expected: acceptanceSnapshotSchema }), ({ expected }) => ({
    snapshot: current.scheduler.accept(expected),
  }));
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
  const planningPath = '/api/workspaces/:workspace/plan-requests';
  function planningWorker(workspace: string) {
    if (workspace !== current.id) throw new Error('请选择所属工作区');
    return current.worker;
  }
  app.get<{ Params: { workspace: string } }>(planningPath, async (req, reply) => {
    try { return planningWorker(req.params.workspace).requests.list(); }
    catch (error) { return rejected(reply, error); }
  });
  app.get<{ Params: { workspace: string; id: string } }>(planningPath + '/:id/result', async (req, reply) => {
    try {
      const worker = planningWorker(req.params.workspace);
      const spec = worker.requests.result(req.params.id);
      // Old approved roster entries may since have been disabled. The original draft
      // remains readable; applying it still requires validation against today's catalog.
      try { return { spec, preview: worker.scheduler.preview(checkedSpec(spec)) }; }
      catch { return { spec, preview: null }; }
    } catch (error) { return rejected(reply, error); }
  });
  post(planningPath + '/:id/cancel', empty, (_, p) => planningWorker(p.workspace).cancelPlanning(p.id));
  post(
    '/api/plans/generate',
    z.strictObject({
      goal: text,
      agentId: identifier,
      members: planningRosterSchema,
      requestKey: z.uuid().optional(),
      background: z.boolean().optional(),
      approved: approval,
      confirmUnmanaged: z.boolean().optional(),
      inspectionId: z.string().max(128).optional(),
    }),
    async (input) => {
      assertRecovered();
      if (input.background && !input.requestKey) throw new Error('后台规划需要请求标识');
      return current.worker.generate(input.goal, input.agentId, input, raw => ({
        ...checkedSpec(raw), id: 'plan-' + randomUUID(),
      }));
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
