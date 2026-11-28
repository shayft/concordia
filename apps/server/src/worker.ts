import { currentApprovalId, withApproval } from './governance.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Scheduler, Execution, Failure } from '@concordia/core/workflow';
import { actionTools, type PlatformAction } from '@concordia/protocol';
import { workflowSpecSchema, type WorkflowSpec } from '@concordia/protocol/workflow';
import { createModelProvider } from '@concordia/providers';
import {
  CliAgentRuntime,
  CliDiagnosticError,
  ExecutionMcpServer,
  inspectCli,
  type AgentRuntimeEvent,
} from '@concordia/runtimes';
import { ModelCallError, runBuiltin } from '@concordia/runtimes/builtin';
import { z } from 'zod';
import { getCatalog, providerConfig, resolveMember, probeCount, type RunningFilter } from './connections.ts';
import {
  assertPoolAvailable,
  BudgetExceeded,
  PoolSuspended,
  meterProvider,
  reserveBudget,
  dispatchBudget,
  noTargetStarted,
  settleBudget,
  suspendPool,
} from './budget-ledger.ts';
import type { PlanningRequests } from './planning-requests.ts';
import { planningRoster } from './planning-roster.ts';
import { safeDataDirectory } from './data-directory.ts';
import type { WorktreeService } from './worktrees/service.ts';

export const runOptions = z
  .strictObject({
    mode: z.enum(['live', 'simulation']),
    approved: z.literal(true).optional(),
    maxCalls: z.number().int().min(1).max(50).default(1),
    projectId: z.string().min(1).max(180).optional(),
    treeId: z.uuid().optional(),
    confirmUnmanaged: z.boolean().optional(),
    inspectionId: z.string().max(128).optional(),
  })
  .refine((x) => Boolean(x.projectId) === Boolean(x.treeId), '项目和工作树须同时指定');
type Options = z.infer<typeof runOptions>;
type Binding = ReturnType<typeof resolveMember>;
type LiveJob = {
  controller: AbortController;
  task: string;
  member: string;
  connection: string;
  pool: string;
  project?: string;
  tree?: string;
  firstDispatched?: boolean;
  planning?: boolean;
  allowed?: ReadonlySet<PlatformAction['type']>;
  finished?: Promise<void>;
};
const fileActions = new Set(['read_file', 'write_file', 'commit_artifact', 'run_project_command']);

export class Worker {
  readonly mcp = new ExecutionMcpServer((id, action) => this.dispatch(id, action));
  private jobs = new Map<string, LiveJob>();
  private batch?: { remaining: number; routes: Map<string, string>; approvalId?: string };
  private scheduling = false;
  private stopping = false;

  constructor(
    readonly scheduler: Scheduler,
    private db: DatabaseSync,
    private trees: WorktreeService,
    private directory: string,
    private workspace: string,
    readonly requests: PlanningRequests,
    private origin: () => string,
  ) {
    // Board and catalog have separate SQLite files. A crash between the two
    // commits leaves an identifiable, unissued reservation in the catalog.
    const state = db.prepare('SELECT status FROM budget_calls WHERE id=?');
    for (const execution of scheduler.board().executions) {
      for (const meter of execution.meters ?? []) {
        if (!meter.reservationId) continue;
        const phase = state.get(meter.reservationId)?.status;
        if (phase === 'preparing' || phase === 'not_sent')
          scheduler.refundUnstartedCall(execution.id, meter.reservationId);
      }
    }
  }

  busy(filter: RunningFilter = {}) {
    return this.count(filter) > 0;
  }
  editingBlocked(filter: RunningFilter) {
    return Boolean(this.batch) || this.busy(filter);
  }
  occupied() {
    return this.busy() || Boolean(this.batch);
  }
  count(filter: RunningFilter = {}) {
    return [...this.jobs.values()].filter(
      (job) =>
        (!filter.memberId || job.member === filter.memberId) &&
        (!filter.connectionId || job.connection === filter.connectionId) &&
        (!filter.poolId || job.pool === filter.poolId),
    ).length;
  }
  private checkConnection(binding: Binding) {
    assertPoolAvailable(this.db, binding.poolId);
    const all = [...this.jobs.values()];
    if (
      all.filter((j) => j.connection === binding.connection.id).length +
        probeCount(this.db, { connectionId: binding.connection.id }) >=
        binding.connection.maxConcurrent ||
      all.filter((j) => j.pool === binding.poolId).length + probeCount(this.db, { poolId: binding.poolId }) >=
        binding.poolLimit
    )
      throw new Error('连接或额度池并发已满');
  }

  treeScope(): string {
    return JSON.stringify([this.workspace, this.scheduler.board().spec?.id ?? null]);
  }
  private budgetScope(job: LiveJob) {
    return {
      workspaceId: this.workspace,
      memberId: job.member,
      connectionId: job.connection,
      poolId: job.pool,
      estimate: this.scheduler.board().spec?.estimatedTokensPerCall,
    };
  }
  private provider(binding: Binding, job: LiveJob) {
    return meterProvider(
      this.db,
      this.budgetScope(job),
      createModelProvider(providerConfig(binding.connection, binding.model)),
    );
  }
  async dispatch(id: string, action: PlatformAction, deliveryId?: string): Promise<unknown> {
    const job = this.jobs.get(id);
    if (!job || job.controller.signal.aborted) throw new Error('执行已结束');
    if (job.allowed && !job.allowed.has(action.type))
      throw new CliDiagnosticError('此动作未获得成员授权。', 'permission');
    const board = this.scheduler.board();
    const task = board.tasks.find((t) => t.id === job.task);
    if (!task || task.active !== id) throw new Error('执行已失效');
    if (action.type === 'read_artifact' && action.path !== undefined) {
      const v = this.scheduler.act(id, action) as { executionId: string; content: string; kind: string };
      if (v.kind !== 'git_commit') throw new Error('此版本没有文件');
      const row = this.db
        .prepare('SELECT project,tree FROM version_sources WHERE workspace=? AND execution=? AND sha=?')
        .get(this.workspace, v.executionId, v.content);
      if (!row) throw new Error('提交来源无法核实');
      return {
        content: this.trees.readPublication(String(row.project), String(row.tree), v.content, action.path),
      };
    }
    if (
      fileActions.has(action.type) ||
      (action.type === 'publish_artifact' && action.kind === 'git_commit')
    ) {
      if (!job.tree || !job.project) throw new Error('此执行没有绑定可写工作树');
      this.trees.executionTree(job.project, job.task, job.tree, this.treeScope());
      switch (action.type) {
        case 'read_file':
          return { content: this.trees.read(job.tree, action.path) };
        case 'write_file':
          this.trees.write(job.tree, action.path, action.content);
          return { ok: true };
        case 'run_project_command':
          return this.trees.requestCommand(job.tree, action.name);
        case 'publish_artifact':
          throw new Error('请用 commit_artifact 发布当前工作树的提交');
        case 'commit_artifact': {
          if (!task.produces.includes(action.slotId)) throw new Error('任务没有声明此槽位');
          const published = this.trees.publishForTask(job.project, job.task, job.tree, this.treeScope());
          this.db
            .prepare('INSERT OR IGNORE INTO version_sources VALUES(?,?,?,?,?)')
            .run(this.workspace, id, published.sha, job.project, job.tree);
          const result = this.scheduler.act(
            id,
            {
              type: 'publish_artifact',
              slotId: action.slotId,
              kind: 'git_commit',
              content: published.sha,
              incompatible: action.incompatible,
            },
            deliveryId,
          );
          if (action.incompatible) this.abortObsolete();
          this.wake();
          return result;
        }
      }
    }
    const result = this.scheduler.act(id, action, deliveryId);
    if (action.type === 'publish_artifact' && action.incompatible) this.abortObsolete();
    this.wake();
    return result;
  }

  private abortObsolete() {
    const obsolete = new Set(
      this.scheduler
        .board()
        .executions.filter((e) => e.status === 'obsolete' || e.status === 'cancelled')
        .map((e) => e.id),
    );
    for (const [id, job] of this.jobs)
      if (obsolete.has(id)) {
        this.mcp.close(id);
        job.controller.abort();
      }
  }
  start(taskId: string, options: Options, shared?: { remaining: number }) {
    if (this.stopping) throw new Error('服务正在关闭');
    const board = this.scheduler.board(),
      task = board.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== 'ready') throw new Error('任务尚未就绪');
    const agent = board.agents.find((a) => a.id === task.owner);
    if (!agent) throw new Error('任务没有有效成员');
    const mock = agent.connection.startsWith('mock-');
    if (mock && getCatalog(this.db).connections.some((c) => c.id === agent.connection))
      throw new Error('真实连接与模拟标识冲突');
    if ([...this.jobs.values()].some((j) => j.task === taskId)) throw new Error('上一执行仍在退出');
    if (mock !== (options.mode === 'simulation')) throw new Error('执行模式与计划中的连接不匹配');
    if (!mock && !options.approved) throw new Error('真实连接调用需要批准');
    if (mock && options.treeId) throw new Error('模拟执行不能写入工作树');
    const binding = mock ? undefined : resolveMember(this.db, agent.id);
    if (binding && binding.connection.id !== agent.connection)
      throw new Error('成员连接已变化，请重新批准计划');
    if (binding) this.checkConnection(binding);
    if (binding && !('baseUrl' in binding.connection) && !options.inspectionId)
      throw new Error('CLI 实跑需要预检 ID');
    if (options.treeId)
      this.trees.executionTree(options.projectId!, taskId, options.treeId, this.treeScope());
    if (shared && shared.remaining < 1) throw new Error('本批调用用尽');
    const canRead = binding && (!binding.member.allowedActions || binding.member.allowedActions.includes('read_artifact'));
    // API tools (including JSON actions) need one more approved request to use a read result.
    // Final-output-only CLI actions have no return path to the model.
    const canReceive = binding && ('baseUrl' in binding.connection
      ? options.maxCalls > 1 && (task.maxCallsPerExecution ?? 2) > 1
        && task.maxCalls - board.executions.filter(e => e.taskId === task.id).reduce((n, e) => n + e.calls, 0) > 1
        && (board.spec?.maxCalls ?? 0) - board.executions.reduce((n, e) => n + e.calls, 0) > 1
      : binding.connection.actionChannel === 'mcp' || (binding.connection.kind === 'codex' && binding.connection.actionChannel !== 'json'));
    const exec = this.scheduler.claim(taskId, binding?.model ?? undefined, {
      deferCall: !!binding, readArtifacts: !!canRead && !!canReceive,
    });
    const approvalId = currentApprovalId();
    if (approvalId) this.db.prepare("INSERT INTO approved_executions(execution,approval_id,status) VALUES(?,?,'running')")
      .run(exec.id, approvalId);
    if (shared) shared.remaining--;
    const job: LiveJob = {
      controller: new AbortController(),
      task: taskId,
      member: agent.id,
      connection: agent.connection,
      pool: binding?.poolId ?? exec.pool,
      allowed: new Set(
        actionTools
          .map((tool) => tool.name)
          .filter(
            (name) =>
              (!fileActions.has(name) || options.treeId) &&
              (!binding?.member.allowedActions || binding.member.allowedActions.includes(name)) &&
              (!['create_task', 'assign_task'].includes(name) || agent.role === 'lead'),
          ),
      ),
      tree: options.treeId,
      project: options.projectId,
    };
    this.jobs.set(exec.id, job);
    job.finished = Promise.resolve()
      .then(async () => {
        if (binding) await this.execute(exec, job, binding, options, shared);
        else {
          for (const slotId of task.produces)
            await this.dispatch(exec.id, {
              type: 'publish_artifact',
              slotId,
              content: '模拟交付 · ' + task.title,
            });
          await this.dispatch(exec.id, { type: 'submit_result', summary: '模拟执行完成' });
        }
      })
      .catch((err: unknown) => {
        if (job.controller.signal.aborted) return;
        const kind =
          err instanceof PoolSuspended
            ? 'rate_limit'
            : err instanceof BudgetExceeded
              ? 'budget'
              : err instanceof ModelCallError
                ? err.kind
                : 'invalid';
        const failure: Failure =
          kind === 'auth' || kind === 'rate_limit' || kind === 'budget'
            ? kind
            : ['timeout', 'transport', 'server'].includes(kind)
              ? 'transient'
              : 'fatal';
        this.scheduler.fail(
          exec.id,
          err instanceof CliDiagnosticError
            ? err.kind === 'budget' ? 'rate_limit' : err.kind === 'context' ? 'budget' : err.kind
            : err instanceof ModelCallError && err.kind === 'budget' && err.httpStatus !== undefined
              ? 'rate_limit'
              : failure,
        );
      })
      .finally(() => {
        this.mcp.close(exec.id);
        if (shared && binding && !job.firstDispatched) shared.remaining++;
        if (approvalId) {
          const outcome = this.scheduler.board().executions.find(e => e.id === exec.id)?.status ?? 'unknown';
          this.db.prepare('UPDATE approved_executions SET status=? WHERE execution=?').run(outcome,exec.id);
        }
        this.jobs.delete(exec.id);
        this.wake();
      });
    return { executionId: exec.id };
  }

  private async execute(
    exec: Execution,
    job: LiveJob,
    binding: Binding,
    options: Options,
    shared?: { remaining: number },
  ) {
    const context = this.scheduler.context(exec.id);
    const task = this.scheduler.board().tasks.find((t) => t.id === exec.taskId)!;
    const prompt = JSON.stringify({
      ...context,
      produces: task.produces,
      consumes: task.consumes,
      role: binding.member.role,
    });
    const instruction = binding.member.systemPrompt ?? '你负责 ' + binding.member.role;
    const beforeSend = (reservationId?: string) => {
      if (job.firstDispatched && shared && shared.remaining < 1) throw new ModelCallError('budget', '已达批次上限');
      this.scheduler.reserveCall(exec.id, reservationId);
      if (shared && job.firstDispatched) shared.remaining--;
      job.firstDispatched = true;
    };
    if ('baseUrl' in binding.connection) {
      await runBuiltin({
        provider: this.provider(binding, job),
        prompt,
        instruction,
        mode: binding.model?.toolMode ?? 'native',
        signal: job.controller.signal,
        maxCalls: options.maxCalls,
        maxContextBytes: this.scheduler.board().spec?.maxContextTokens,
        allowed: new Set(job.allowed),
        beforeCall: (_round, id) => beforeSend(id),
        usage: (value) => this.scheduler.recordUsage(exec.id, value),
        dispatch: (action, deliveryId) => this.dispatch(exec.id, action, deliveryId),
      });
      return;
    }
    let text = '';
    await this.cli(binding, job, exec.id, instruction + '\n' + prompt, options, (event) => {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'usage')
        this.scheduler.recordUsage(exec.id, {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        });
    }, false, beforeSend);
    if (this.scheduler.board().tasks.find((t) => t.id === task.id)?.active === exec.id)
      await this.dispatch(exec.id, {
        type: 'submit_result',
        summary: text.trim().slice(0, 32768) || 'CLI 已结束',
      });
  }

  private cliLocation(binding: Binding, task: string, tree?: string, project?: string, planning = false) {
    const c = binding.connection;
    if ('baseUrl' in c) throw new Error('当前连接不是本地命令行');
    const key = createHash('sha256')
      .update(JSON.stringify([this.workspace, this.scheduler.board().spec?.id,
        planning ? ['plan', binding.member.id] : task]))
      .digest('hex');
    const cwd = tree ? this.trees.executionTree(project!, task, tree, this.treeScope()).path
      : (c.cwd ?? safeDataDirectory(this.directory, 'cli-work', key));
    return { key, cwd };
  }

  async inspectExecution(target: { taskId: string; treeId?: string; projectId?: string } | { planner: string },
    confirmUnmanaged?: boolean) {
    const task = 'taskId' in target ? this.scheduler.board().tasks.find(t => t.id === target.taskId) : undefined;
    if ('taskId' in target && task?.status !== 'ready') throw new Error('任务尚未就绪');
    const binding = resolveMember(this.db, 'planner' in target ? target.planner : task!.owner);
    const c = binding.connection;
    if ('baseUrl' in c) throw new Error('当前连接不是本地命令行');
    if (task && this.scheduler.board().agents.find(a => a.id === task.owner)?.connection !== c.id)
      throw new Error('计划与成员当前连接不匹配');
    this.checkConnection(binding);
    const planning = 'planner' in target;
    const taskId = task?.id ?? 'plan';
    const { cwd } = this.cliLocation(binding, taskId, 'treeId' in target ? target.treeId : undefined,
      'projectId' in target ? target.projectId : undefined, planning);
    const id = randomUUID();
    const job: LiveJob = { controller: new AbortController(), task: taskId, member: binding.member.id,
      connection: c.id, pool: binding.poolId };
    this.jobs.set(id, job);
    const pending = inspectCli(c.kind, { cwd, executable: c.executable, model: binding.model?.modelId,
      confirmUnmanaged, actionChannel: c.actionChannel, signal: job.controller.signal,
      requiresPlatformMcp: !planning && c.actionChannel !== 'json' });
    job.finished = pending.then(() => {}, () => {});
    try {
      const result = await pending;
      const writable = 'treeId' in target && !!target.treeId &&
        (!binding.member.allowedActions || binding.member.allowedActions.includes('write_file'));
      return { ...result, executionAccess: planning ? '只读，生成计划文本' :
        writable ? '可在所选成员工作树写入' : '只读任务',
        selectedChannel: planning ? 'text' : c.actionChannel ?? (c.kind === 'codex' ? 'mcp' : 'auto') };
    } finally { this.jobs.delete(id); }
  }

  private async cli(
    binding: Binding,
    job: LiveJob,
    id: string,
    prompt: string,
    options: Pick<Options, 'confirmUnmanaged' | 'inspectionId'>,
    emit: (event: AgentRuntimeEvent) => void,
    outputOnly = false,
    beforeSend?: (reservationId: string) => void,
  ) {
    const c = binding.connection;
    if ('baseUrl' in c) throw new Error('连接类型不匹配');
    const config = {
      kind: c.kind,
      actionChannel: c.actionChannel,
      connectionId: c.id,
      executable: c.executable,
      cwd: c.cwd,
      model: binding.model?.modelId,
      confirmUnmanaged: options.confirmUnmanaged,
      signal: job.controller.signal,
    };
    if (!options.inspectionId) throw new Error('请先完成实际工作目录的预检');
    const { key, cwd } = this.cliLocation(binding, job.task, job.tree, job.project, outputOnly);
    const runtime = new CliAgentRuntime(config, this.mcp, {
      get: (key) =>
        this.db.prepare('SELECT session FROM cli_sessions WHERE binding=?').get(this.workspace + '|' + key)
          ?.session as string | undefined,
      set: (key, value) => {
        this.db
          .prepare(
            'INSERT INTO cli_sessions VALUES (?,?) ON CONFLICT(binding) DO UPDATE SET session=excluded.session',
          )
          .run(this.workspace + '|' + key, value);
      },
    });
    const reservation = reserveBudget(this.db, this.budgetScope(job), 'preparing');
    let success = false;
    let dispatchFailure: {error: unknown} | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
      await runtime.run(
        {
          executionId: id,
          memberId: job.member,
          taskId: this.workspace + ':' + (outputOnly ? id : key),
          cwd,
          prompt,
          approvedInspectionId: options.inspectionId,
          outputOnly,
          maxContextBytes: this.scheduler.board().spec?.maxContextTokens,
          onDispatch: () => {
            try { dispatchBudget(this.db, reservation, beforeSend); }
            catch (error) { dispatchFailure = {error}; throw error; }
          },
          onSpawnRejected: () => {
            noTargetStarted(this.db, reservation);
            if (beforeSend && job.firstDispatched) {
              this.scheduler.refundUnstartedCall(id, reservation);
              job.firstDispatched = false;
            }
          },
          allowedActions: outputOnly ? new Set<never>() : job.allowed,
          permission: job.tree && job.allowed?.has('write_file') ? 'worktree-write' : 'read-only',
          authorizedWorktree: job.tree ? cwd : undefined,
          recoveryDir: safeDataDirectory(this.directory, 'processes'),
          mcpOrigin: this.origin(),
          signal: job.controller.signal,
        },
        (event) => {
          if (event.type === 'usage')
            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
          emit(event);
        },
      );
      success = true;
    } catch (error) {
      if (dispatchFailure) throw dispatchFailure.error;
      if (error instanceof CliDiagnosticError && ['rate_limit', 'budget'].includes(error.kind))
        suspendPool(this.db, job.pool);
      throw error;
    } finally {
      settleBudget(this.db, reservation, usage, job.controller.signal.aborted ? 'cancelled' : success ? 'success' : 'error');
    }
  }

  startBatch(maxCalls: number) {
    if (this.batch || this.stopping) throw new Error('批次正在运行或服务即将关闭');
    const routes = new Map<string, string>();
    for (const agent of this.scheduler.board().agents) {
      if (agent.connection.startsWith('mock-')) continue;
      const selected = resolveMember(this.db, agent.id);
      if (selected.connection.id !== agent.connection) throw new Error('计划与成员路由不符');
      routes.set(agent.id, JSON.stringify(selected));
    }
    this.batch = { remaining: maxCalls, routes, approvalId: currentApprovalId() };
    this.wake();
    return { approvedCalls: maxCalls };
  }
  private wake() {
    if (!this.batch || this.scheduling || this.stopping) return;
    this.scheduling = true;
    setImmediate(() => {
      this.scheduling = false;
      const batch = this.batch;
      if (!batch || this.stopping) return;
      const board = this.scheduler.board();
      for (const task of board.tasks.filter((t) => t.status === 'ready')) {
        if (!batch.remaining) break;
        const agent = board.agents.find((a) => a.id === task.owner);
        if (!agent) continue;
        const fake = agent.connection.startsWith('mock-');
        try {
          if (!fake) {
            const route = resolveMember(this.db, agent.id);
            if (batch.routes.get(agent.id) !== JSON.stringify(route)) {
              this.batch = undefined;
              return;
            }
            if (!('baseUrl' in route.connection)) continue;
          }
          withApproval(batch.approvalId, () => this.start(
            task.id,
            { mode: fake ? 'simulation' : 'live', approved: true, maxCalls: batch.remaining },
            batch,
          ));
        } catch {
          /* A disabled, saturated or waiting connection does not block other members. */
        }
      }
      if (!this.jobs.size) this.batch = undefined;
    });
  }
  async revokeProjectWrites(projectId: string) {
    const active = [...this.jobs].filter(([,job]) => job.project === projectId && job.tree &&
      (job.allowed?.has('write_file') || job.allowed?.has('commit_artifact') || job.allowed?.has('run_project_command')));
    for (const [execution, job] of active) {
      this.mcp.close(execution);
      job.controller.abort();
    }
    try {
      for (const [execution, job] of active) {
        if (this.scheduler.board().tasks.some(task => task.id === job.task && task.active === execution))
          this.scheduler.control(job.task, 'cancel');
      }
    } finally {
      await Promise.allSettled(active.map(([,job]) => job.finished));
    }
  }

  cancelTask(id: string) {
    for (const [execution, job] of this.jobs)
      if (!job.planning && job.task === id) {
        this.mcp.close(execution);
        job.controller.abort();
      }
  }
  stop() {
    this.batch = undefined;
    for (const [id, job] of this.jobs) {
      this.mcp.close(id);
      job.controller.abort();
    }
    this.scheduler.stopAll();
  }
  async drain() {
    await Promise.allSettled([...this.jobs.values()].map((job) => job.finished));
  }
  async shutdown() {
    this.stopping = true;
    this.batch = undefined;
    for (const [id, job] of this.jobs) {
      this.mcp.close(id);
      job.controller.abort();
    }
    await this.drain();
    this.scheduler.recover();
  }

  async cancelPlanning(id: string) {
    const request = this.requests.get(id);
    if (request.status !== 'running') return request;
    const job = this.jobs.get(id);
    if (!job || !job.planning) throw new Error('规划执行需要重新核对');
    this.mcp.close(id);
    job.controller.abort();
    await job.finished;
    return this.requests.get(id);
  }

  async generate(
    goal: string,
    agentId: string,
    options: Pick<Options, 'inspectionId' | 'confirmUnmanaged'> & { members: string[]; requestKey?: string; background?: boolean },
    validate: (raw: unknown) => WorkflowSpec,
  ) {
    if (this.stopping) throw new Error('服务正在关闭');
    const binding = resolveMember(this.db, agentId);
    const roster = planningRoster(this.db, options.members);
    const hash = createHash('sha256').update(JSON.stringify([goal, binding, roster, options.inspectionId, options.confirmUnmanaged])).digest('hex');
    const previous = options.requestKey && this.requests.byKey(options.requestKey);
    const respond = async (id: string) => {
      if (options.background) return this.requests.get(id);
      await this.jobs.get(id)?.finished;
      const spec = this.requests.result(id);
      return { spec, preview: this.scheduler.preview(spec) };
    };
    if (previous) {
      if (previous.request_hash !== hash) throw new Error('此规划请求标识已关联其他内容');
      return respond(previous.id);
    }
    this.checkConnection(binding);
    const id = randomUUID();
    const job: LiveJob = {
      controller: new AbortController(), task: 'plan-' + id, planning: true,
      member: agentId, connection: binding.connection.id, pool: binding.poolId,
    };
    const prompt = JSON.stringify({
      goal, members: roster,
      schema: z.toJSONSchema(workflowSpecSchema, { io: 'input', unrepresentable: 'any' }),
      instruction: '根据用户目标生成一份符合 schema 的工作流，只返回单个 JSON 对象。只可从名单选择岗位，保留标识、名称与连接。不要执行任务。',
    });
    this.requests.start(id, agentId, binding.connection.id, roster.map((m) => m.id), options.requestKey, hash);
    this.jobs.set(id, job);
    let bytes = 0;
    const run = async () => {
      let text = '';
      let lastProgress = 0;
      const signal = job.controller.signal;
      function append(delta: string) {
        signal.throwIfAborted();
        bytes += Buffer.byteLength(delta);
        if (bytes > 128 * 1024) throw new Error('计划过大');
        text += delta;
      }
      const receive = (delta: string) => {
        append(delta);
        if (bytes && (!lastProgress || bytes - lastProgress >= 4096)) {
          this.requests.progress(id, bytes);
          lastProgress = bytes;
        }
      };
      const sent = () => this.requests.sent(id);
      try {
        signal.throwIfAborted();
        if ('baseUrl' in binding.connection) {
          let complete = false;
          for await (const event of this.provider(binding, job).stream([{ role: 'user', content: prompt }], [], { signal, onDispatch: sent })) {
            signal.throwIfAborted();
            if (event.type === 'text_delta') receive(event.text);
            if (event.type === 'completed') complete = true;
            if (event.type === 'error') throw new ModelCallError(event.kind, event.message);
          }
          if (!complete) throw new Error('计划响应未完成');
        } else {
          await this.cli(binding, job, id, prompt, options, (event) => {
            if (event.type === 'text_delta') receive(event.text);
          }, true, sent);
        }
        signal.throwIfAborted();
        const parsed = workflowSpecSchema.parse(JSON.parse(text.trim()));
        for (const agent of parsed.agents) {
          const approved = roster.find((member) => member.id === agent.id);
          if (!approved || approved.connection !== agent.connection || approved.name !== agent.name)
            throw new Error('返回的计划岗位与批准名单不符');
        }
        this.requests.finish(id, 'proposed', bytes, validate(parsed));
      } catch {
        this.requests.finish(id, signal.aborted ? (this.stopping ? 'interrupted' : 'cancelled') : 'failed', bytes);
      } finally {
        this.mcp.close(id);
        this.jobs.delete(id);
      }
    };
    // A background request has no waiting HTTP handler. Retain an unresolved write in
    // memory and try to persist an interruption on the next status read or on startup.
    job.finished = Promise.resolve().then(run).catch(() => this.requests.rememberWriteFailure(id, bytes));
    return respond(id);
  }
}
