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
  settleBudget,
  suspendPool,
} from './budget-ledger.ts';
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
  allowed?: ReadonlySet<PlatformAction['type']>;
  finished?: Promise<void>;
};
const fileActions = new Set(['read_file', 'write_file', 'commit_artifact', 'run_project_command']);

export class Worker {
  readonly mcp = new ExecutionMcpServer((id, action) => this.dispatch(id, action));
  private jobs = new Map<string, LiveJob>();
  private batch?: { remaining: number; routes: Map<string, string> };
  private scheduling = false;
  private stopping = false;

  constructor(
    readonly scheduler: Scheduler,
    private db: DatabaseSync,
    private trees: WorktreeService,
    private directory: string,
    private workspace: string,
    private origin: () => string,
  ) {}

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
    const exec = this.scheduler.claim(taskId, binding?.model ?? undefined);
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
            ? err.kind === 'budget'
              ? 'rate_limit'
              : err.kind
            : err instanceof ModelCallError && err.httpStatus === 402
              ? 'rate_limit'
              : failure,
        );
      })
      .finally(() => {
        this.mcp.close(exec.id);
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
    if ('baseUrl' in binding.connection) {
      await runBuiltin({
        provider: this.provider(binding, job),
        prompt,
        instruction,
        mode: binding.model?.toolMode ?? 'native',
        signal: job.controller.signal,
        maxCalls: options.maxCalls,
        allowed: new Set(job.allowed),
        beforeCall: (round) => {
          if (!round) return;
          if (shared && shared.remaining < 1) throw new ModelCallError('budget', '已达批次上限');
          this.scheduler.reserveCall(exec.id);
          if (shared) shared.remaining--;
        },
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
    });
    if (this.scheduler.board().tasks.find((t) => t.id === task.id)?.active === exec.id)
      await this.dispatch(exec.id, {
        type: 'submit_result',
        summary: text.trim().slice(0, 32768) || 'CLI 已结束',
      });
  }

  private async cli(
    binding: Binding,
    job: LiveJob,
    id: string,
    prompt: string,
    options: Pick<Options, 'confirmUnmanaged' | 'inspectionId'>,
    emit: (event: AgentRuntimeEvent) => void,
    outputOnly = false,
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
    const checked = await inspectCli(c.kind, config);
    if (checked.inspectionId !== options.inspectionId) throw new Error('CLI 预检已变化');
    const key = createHash('sha256')
      .update(JSON.stringify([this.workspace, this.scheduler.board().spec?.id, job.task]))
      .digest('hex');
    const cwd = job.tree
      ? this.trees.executionTree(job.project!, job.task, job.tree, this.treeScope()).path
      : (c.cwd ?? safeDataDirectory(this.directory, 'cli-work', key));
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
    const reservation = reserveBudget(this.db, this.budgetScope(job));
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
      await runtime.run(
        {
          executionId: id,
          memberId: job.member,
          taskId: this.workspace + ':' + key,
          cwd,
          prompt,
          approvedDiagnostic: checked,
          outputOnly,
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
    } catch (error) {
      if (error instanceof CliDiagnosticError && ['rate_limit', 'budget'].includes(error.kind))
        suspendPool(this.db, job.pool);
      throw error;
    } finally {
      settleBudget(this.db, reservation, usage);
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
    this.batch = { remaining: maxCalls, routes };
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
          this.start(
            task.id,
            { mode: fake ? 'simulation' : 'live', approved: true, maxCalls: batch.remaining },
            batch,
          );
        } catch {
          /* A disabled, saturated or waiting connection does not block other members. */
        }
      }
      if (!batch.remaining || !this.jobs.size) this.batch = undefined;
    });
  }
  cancelTask(id: string) {
    for (const [execution, job] of this.jobs)
      if (job.task === id) {
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

  async generate(
    goal: string,
    agentId: string,
    options: Pick<Options, 'inspectionId' | 'confirmUnmanaged'>,
    validate: (raw: unknown) => WorkflowSpec,
  ) {
    const binding = resolveMember(this.db, agentId);
    this.checkConnection(binding);
    const id = randomUUID(),
      job: LiveJob = {
        controller: new AbortController(),
        task: 'plan-' + id,
        member: agentId,
        connection: binding.connection.id,
        pool: binding.poolId,
      };
    if (this.stopping) throw new Error('服务正在关闭');
    const catalog = getCatalog(this.db);
    const prompt = JSON.stringify({
      goal,
      members: catalog.members
        .filter((m) => m.enabled)
        .map((m) => ({ id: m.id, name: m.name, connection: m.connectionId, role: m.role })),
      schema: z.toJSONSchema(workflowSpecSchema, { io: 'input', unrepresentable: 'any' }),
      instruction: '根据用户目标生成一份符合 schema 的工作流，只返回单个 JSON 对象。不要执行任务。',
    });
    this.db
      .prepare('INSERT INTO plan_requests(id,workspace,member,connection,started,status) VALUES(?,?,?,?,?,?)')
      .run(id, this.workspace, agentId, binding.connection.id, Date.now(), 'running');
    this.jobs.set(id, job);
    let status = 'failed';
    const pending = (async () => {
      let text = '';
      if ('baseUrl' in binding.connection) {
        const provider = this.provider(binding, job);
        let done = false;
        for await (const event of provider.stream([{ role: 'user', content: prompt }], [], {
          signal: job.controller.signal,
        })) {
          if (event.type === 'text_delta') text += event.text;
          if (event.type === 'completed') done = true;
          if (event.type === 'error') throw new ModelCallError(event.kind, event.message);
          if (text.length > 131072) throw new Error('计划过大');
        }
        if (!done) throw new Error('计划响应未完成');
      } else
        await this.cli(
          binding,
          job,
          id,
          prompt,
          options,
          (e) => {
            if (e.type === 'text_delta') text += e.text;
          },
          true,
        );
      job.controller.signal.throwIfAborted();
      const spec = validate(JSON.parse(text.trim()));
      for (const agent of spec.agents) {
        const selected = resolveMember(this.db, agent.id);
        if (selected.connection.id !== agent.connection) throw new Error('计划成员连接与配置不符');
      }
      status = 'proposed';
      return { spec, preview: this.scheduler.preview(spec) };
    })();
    job.finished = pending.then(
      () => {},
      () => {},
    );
    try {
      return await pending;
    } finally {
      this.jobs.delete(id);
      this.mcp.close(id);
      this.db.prepare('UPDATE plan_requests SET status=?,finished=? WHERE id=?').run(status, Date.now(), id);
    }
  }
}
