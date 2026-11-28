import { captureLegacyWaits, recordWaits, waitTime } from './timing.ts';
import type { ModelSnapshot } from '@concordia/protocol/pricing';
import { exhausted } from './budget.ts';
import { platformActionSchema } from '@concordia/protocol';
import { workflowSpecSchema, type PlanPreview, type WorkflowSpec } from '@concordia/protocol/workflow';
import type { CoreDependencies } from './index.ts';
import {
  activePlan,
  column,
  emptyState,
  entity,
  fence,
  inputsFor,
  latest,
  makeTask,
  refresh,
  reopen,
  transition,
  type Append,
  type Control,
  type Execution,
  type Failure,
  type State,
  type WorkflowStorage,
} from './state.ts';
import { acceptanceCandidate, sameAcceptance, reviewExecution } from './acceptance.ts';
import type { AcceptanceSnapshot } from '@concordia/protocol/workflow';
import { applyAction, scheduleReply, reconcileReplies } from './workflow-actions.ts';
export * from './state.ts';
export * from './templates.ts';

function planDiff(state: State, spec: WorkflowSpec): PlanPreview {
  const prior = state.spec?.tasks ?? [];
  const before = new Map(prior.map((task) => [task.id, task]));
  const after = new Set(spec.tasks.map((task) => task.id));
  const fields = new Set([...Object.keys(state.spec ?? {}), ...Object.keys(spec)] as (keyof WorkflowSpec)[]);
  const settings = [...fields]
    .filter(
      (field) => field !== 'tasks' && JSON.stringify(state.spec?.[field]) !== JSON.stringify(spec[field]),
    )
    .map((field) => ({ field, before: state.spec?.[field] ?? null, after: spec[field] ?? null }));
  const taskChanges = spec.tasks.flatMap((task) => {
    const previous = before.get(task.id);
    if (!previous || JSON.stringify(task) === JSON.stringify(previous)) return [];
    return [{ id: task.id, before: previous, after: task }];
  });
  return {
    spec,
    baselineId: state.spec?.id ?? null,
    settings,
    revision: state.revision,
    added: spec.tasks.filter((task) => !before.has(task.id)).map((task) => task.id),
    removed: prior.filter((task) => !after.has(task.id)).map((task) => task.id),
    changed: taskChanges.map((change) => change.id),
    taskChanges,
  };
}

function validateInputs(state: State, spec: WorkflowSpec) {
  for (const task of spec.tasks)
    for (const input of task.consumes) {
      if (
        input.policy === 'pinned' &&
        !state.versions.some((v) => v.id === input.version && v.slotId === input.slotId)
      )
        throw new Error('钉住的交付物版本不存在');
    }
}

export class Scheduler {
  constructor(private readonly deps: CoreDependencies<WorkflowStorage>) {}
  private write<T>(callback: (state: State, append: Append) => T): T {
    return this.deps.storage.transaction((state, append) => {
      const now = this.deps.now();
      captureLegacyWaits(state);
      const result = callback(state, (type, data) => append(type, { ...data, time: now }));
      if (state.acceptance && typeof acceptanceCandidate(state) === 'string') {
        state.acceptance = null;
        append('plan.acceptance_invalidated', { time: now });
      }
      if (!state.acceptance) delete state.acceptedSnapshot;
      recordWaits(state, now);
      return result;
    });
  }
  private switchState(s: State, id: string) {
    if (!s.spec || s.spec.id === id) return;
    if (s.tasks.some((t) => t.active)) throw new Error('请先暂停运行中的工作流');
    const archive = s.archives.find((w) => w.id === id);
    const previous = {
      id: s.spec.id,
      title: s.spec.title,
      ref: this.deps.storage.putContent(JSON.stringify({ ...s, archives: [] })),
    };
    const next = archive ? (JSON.parse(this.deps.storage.getContent(archive.ref)) as State) : emptyState();
    const archives = [...s.archives.filter((w) => w.id !== id), previous];
    delete s.acceptedSnapshot;
    delete s.conflicts;
    Object.assign(s, next, { archives, revision: s.revision });
  }
  switchWorkspace(id: string) {
    return this.write((s, log) => {
      if (s.spec?.id === id) return;
      if (!s.archives.some((w) => w.id === id)) throw new Error('工作流不存在');
      this.switchState(s, id);
      s.revision++;
      log('plan.switched', { id, revision: s.revision });
    });
  }
  plans() {
    const state = this.deps.storage.read();
    return [
      ...(state.spec ? [{ id:state.spec.id, title:state.spec.title, active:true }] : []),
      ...state.archives.map(({id,title}) => ({id,title,active:false})),
    ];
  }
  private stateForPlan(state: State, id: string): State | undefined {
    if (state.spec?.id === id) return state;
    const archived = state.archives.find(plan => plan.id === id);
    if (archived) return JSON.parse(this.deps.storage.getContent(archived.ref)) as State;
  }
  planSpec(id: string) {
    const spec = this.stateForPlan(this.deps.storage.read(), id)?.spec;
    if (!spec) throw new Error('指定的计划不存在');
    return spec;
  }
  preview(input: unknown, revisionOf?: string) {
    const state = this.deps.storage.read(), spec = workflowSpecSchema.parse(input);
    const target = this.stateForPlan(state, spec.id);
    if (revisionOf !== undefined && (spec.id !== revisionOf || !target))
      throw new Error('修订草案必须引用所选计划');
    const baseline = target ?? emptyState();
    validateInputs(baseline, spec);
    // Compare against the target instance, but bind approval to the current workspace revision.
    return { ...planDiff(baseline, spec), revision: state.revision };
  }
  apply(input: unknown, expectedRevision?: number, revisionOf?: string) {
    const spec = workflowSpecSchema.parse(input);
    return this.write((s, log) => {
      if (expectedRevision !== undefined && s.revision !== expectedRevision)
        throw new Error('计划版本已改变，请重新预览');
      if (revisionOf !== undefined && (spec.id !== revisionOf || !this.stateForPlan(s, revisionOf)))
        throw new Error('修订草案必须引用所选计划');
      const switching = Boolean(s.spec && s.spec.id !== spec.id);
      this.switchState(s, spec.id);
      if (JSON.stringify(spec) === JSON.stringify(s.spec)) {
        if (switching) {
          s.revision++;
          log('plan.switched', { id: spec.id, revision: s.revision });
        }
        return { revision: s.revision };
      }
      const diff = planDiff(s, spec);

      if (s.tasks.some((t) => t.active)) throw new Error('请先暂停运行中的任务');
      const revised = new Set([...diff.removed, ...diff.changed]);
      // Budget edits are safe between executions; existing lineage and ownership are immutable in a spec edit.
      const structure = ({
        maxCalls: _calls,
        maxRetries: _tries,
        maxRework: _rework,
        maxCallsPerExecution: _execCalls,
        maxTokens: _tokens,
        priority: _priority,
        ...rest
      }: WorkflowSpec['tasks'][number]) => JSON.stringify(rest);
      for (const id of revised) {
        if (!s.executions.some((e) => e.taskId === id)) continue;
        const old = s.spec?.tasks.find((t) => t.id === id),
          replacement = spec.tasks.find((t) => t.id === id);
        if (!old || !replacement || structure(old) !== structure(replacement))
          throw new Error('已有执行的任务须通过改派或返工更新');
        const task = entity(s.tasks, id);
        task.maxCalls = replacement.maxCalls;
        task.maxCallsPerExecution = replacement.maxCallsPerExecution;
        task.maxTokens = replacement.maxTokens;
        task.priority = replacement.priority;
        task.maxRetries = replacement.maxRetries;
        task.maxRework = replacement.maxRework;
        revised.delete(id);
      }
      if (
        s.questions.some(
          (q) => q.status === 'open' && q.to !== 'user' && !spec.agents.some((a) => a.id === q.to),
        )
      )
        throw new Error('仍有问题等待该成员答复');
      validateInputs(s, spec);
      s.spec = spec;
      s.tasks = [
        ...spec.tasks.map((t) => {
          const old = s.tasks.find((task) => task.id === t.id);
          if (old && !revised.has(t.id)) return old;
          const task = makeTask(t);
          if (old) task.waitHistory = old.waitHistory;
          return task;
        }),
        ...s.tasks.filter((t) => t.replyFor),
      ];
      for (const task of s.tasks) if (task.status === 'ready' || task.status === 'waiting') refresh(task, s);
      s.revision++;
      s.plans.push(this.deps.storage.putContent(JSON.stringify(spec)));
      s.acceptance = null;
      log('plan.applied', {
        revision: s.revision,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
      });
      return { revision: s.revision };
    });
  }
  board() {
    const s = this.deps.storage.read();
    const now = this.deps.now();
    const tasks = [...s.tasks]
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map((t) => {
        const inputs = inputsFor(t, s);
        const card = {
          ...t,
          reviewExecutionId: t.status === 'review' ? reviewExecution(s, t)?.id : undefined,
          waitTime: waitTime(t, s, now),
          column: column(t),
          missing: t.consumes.filter((c) => !inputs[c.slotId]).map((c) => c.slotId),
        };
        delete card.waitHistory;
        return card;
      });
    const slots = (s.spec?.slots ?? []).map((slot) => ({
      ...slot,
      producer: tasks.find((t) => t.produces.includes(slot.id))?.id,
      waiting: tasks.filter((t) => t.status === 'waiting' && t.missing.includes(slot.id)).map((t) => t.id),
      unblocks: tasks.filter(
        (t) => t.status === 'waiting' && t.missing.length === 1 && t.missing[0] === slot.id,
      ).length,
    }));
    const versions = s.versions.map((v) => ({
      ...v,
      outdatedInputs: Object.entries(v.basedOn)
        .filter(([slot, id]) => latest(s, slot)?.id !== id)
        .map(([slot]) => slot),
    }));
    const candidate = acceptanceCandidate(s);
    const eligible = typeof candidate !== 'string';
    const nextSlot = [...slots].sort((a, b) => b.unblocks - a.unblocks)[0];
    return {
      ...s,
      tasks,
      slots,
      versions,
      acceptance: eligible ? s.acceptance : null,
      acceptedSnapshot: eligible && s.acceptance ? s.acceptedSnapshot ?? null : null,
      acceptanceCandidate: eligible ? candidate : null,
      acceptanceBlocker: eligible ? null : candidate,
      criticalSlot: nextSlot?.unblocks ? nextSlot.id : null,
      agents: s.spec?.agents ?? [],
    };
  }
  events(after = 0) {
    return this.deps.storage.events(after);
  }
  context(executionId: string) {
    return JSON.parse(
      this.deps.storage.getContent(entity(this.deps.storage.read().executions, executionId).contextRef),
    ) as {
      goal: string;
      acceptance: string[];
      task: string;
      inputs: Record<string, string>;
      questions: State['questions'];
      messages: State['messages'];
    };
  }
  readProgress(taskId: string) {
    const ref = entity(this.deps.storage.read().tasks, taskId).progressRef;
    return ref ? this.deps.storage.getContent(ref) : null;
  }
  readVersion(versionId: string) {
    const version = entity(this.deps.storage.read().versions, versionId);
    return { ...version, content: this.deps.storage.getContent(version.contentRef) };
  }
  isRunning(filter: { memberId?: string; connectionId?: string; poolId?: string } = {}) {
    return this.deps.storage
      .read()
      .executions.some(
        (e) =>
          e.status === 'running' &&
          (!filter.memberId || e.owner === filter.memberId) &&
          (!filter.connectionId || e.connection === filter.connectionId) &&
          (!filter.poolId || e.pool === filter.poolId),
      );
  }
  claim(taskId: string, model?: ModelSnapshot, options: { deferCall?: boolean } = {}): Execution {
    const result = this.write((s, log) => {
      const task = entity(s.tasks, taskId),
        plan = activePlan(s),
        agent = entity(plan.agents, task.owner);
      if (task.status !== 'ready') throw new Error('任务尚未就绪');
      const pool = agent.pool ?? 'connection:' + agent.connection;
      const active = s.executions.filter((e) => e.status === 'running');
      if (plan.maxConcurrent !== undefined && active.length >= plan.maxConcurrent)
        throw new Error('工作流并发已满');
      const running = active.filter((e) => e.pool === pool).length;
      if (s.stoppedPools.includes(pool) || running >= (plan.poolLimits[pool] ?? 1))
        throw new Error('额度池暂停或并发已满');
      if (exhausted(plan, s, task)) {
        transition(task, 'decision', '调用预算已用尽');
        log('budget.exhausted', { taskId });
        return null;
      }
      if (task.replyFor) {
        for (const q of s.questions)
          if (q.to === agent.id && q.taskId === task.replyFor && q.status === 'open') q.replyTaskId = task.id;
      }
      const id = this.deps.nextId(),
        inputs = inputsFor(task, s);
      if (Object.keys(inputs).length !== task.consumes.length) throw new Error('依赖尚未满足');
      const context = {
        goal: plan.goal,
        acceptance: plan.acceptance,
        task: task.title,
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([slot, ver]) => [
            slot,
            this.deps.storage.getContent(entity(s.versions, ver).contentRef),
          ]),
        ),
        questions: s.questions.filter(
          (q) => q.to === agent.id && q.status === 'open' && (!task.replyFor || q.taskId === task.replyFor),
        ),
        messages: s.messages.filter(
          (m) =>
            m.to === agent.id &&
            (!m.forTask || m.forTask === task.id || m.forTask === task.replyFor) &&
            (!m.deliveredTo || m.deliveredTo === task.id),
        ),
      };
      const encoded = JSON.stringify(context);
      // Byte count conservatively bounds byte-level tokenizer input even for non-ASCII text.
      if (new TextEncoder().encode(encoded).byteLength > (plan.maxContextTokens ?? 128_000))
        throw new Error('输入超过上下文限制');
      const execution: Execution = {
        ...(model && {
          modelSnapshot: {
            modelId: model.modelId,
            ...(model.pricing && { pricing: { ...model.pricing } }),
          },
        }),
        id,
        taskId,
        owner: agent.id,
        connection: agent.connection,
        pool,
        inputs,
        outputs: {},
        contextRef: this.deps.storage.putContent(encoded),
        started: this.deps.now(),
        calls: options.deferCall ? 0 : 1,
        meters: options.deferCall ? [] : [{ reserved: plan.estimatedTokensPerCall ?? 1024 }],
        status: 'running',
      };
      for (const message of context.messages) message.deliveredTo = task.id;
      task.active = id;
      transition(task, 'running');
      s.executions.push(execution);
      log('execution.started', { id, taskId, inputs, connection: agent.connection });
      return execution;
    });
    if (!result) throw new Error('调用预算已用尽');
    return result;
  }
  act(executionId: string, input: unknown, deliveryId?: string): unknown {
    const action = platformActionSchema.parse(input);
    return this.write((s, log) => {
      const exec = entity(s.executions, executionId),
        task = entity(s.tasks, exec.taskId);
      const key = deliveryId ? JSON.stringify([executionId, deliveryId]) : undefined;
      const fingerprint = key ? this.deps.storage.putContent(JSON.stringify(action)) : '';
      if (key && Object.hasOwn(s.receipts, key)) {
        if (s.receipts[key].fingerprint !== fingerprint) throw new Error('重复消息编号的内容不同');
        const receipt = s.receipts[key];
        return receipt.resultRef
          ? JSON.parse(this.deps.storage.getContent(receipt.resultRef))
          : receipt.result;
      }
      if (task.active !== exec.id || exec.status !== 'running') {
        const previousStatus = exec.status;
        if (exec.status !== 'success') exec.status = 'obsolete';
        log('execution.late', {
          previousStatus,
          id: executionId,
          action: action.type,
          contentRef: this.deps.storage.putContent(JSON.stringify(action)),
        });
        return { obsolete: true };
      }
      const result = applyAction(s, exec, task, action, log, this.deps);
      if (key)
        s.receipts[key] = {
          fingerprint,
          resultRef: this.deps.storage.putContent(JSON.stringify(result ?? null)),
        };
      return result;
    });
  }
  reserveCall(executionId: string, reservationId?: string) {
    const ok = this.write((s, log) => {
      const exec = entity(s.executions, executionId),
        task = entity(s.tasks, exec.taskId),
        plan = activePlan(s);
      if (exec.status !== 'running' || task.active !== exec.id) throw new Error('执行已结束');
      if (exhausted(plan, s, task, exec)) {
        fence(s, task, 'failed', this.deps.now());
        transition(task, 'decision', '调用预算已用尽');
        reconcileReplies(s, exec.owner, log, this.deps);
        log('budget.exhausted', { taskId: task.id, id: exec.id });
        return false;
      }
      exec.meters ??= Array.from({ length: exec.calls }, () => ({
        reserved: plan.estimatedTokensPerCall ?? 1024,
      }));
      exec.meters.push({ reserved: plan.estimatedTokensPerCall ?? 1024, ...(reservationId && { reservationId }) });
      exec.calls++;
      log('call.reserved', { id: exec.id, calls: exec.calls });
      return true;
    });
    if (!ok) throw new Error('调用预算已用尽');
  }
  /** The catalog ledger or trusted supervisor confirmed that this exact request never left. */
  refundUnstartedCall(executionId: string, reservationId: string) {
    this.write((s, log) => {
      const exec = entity(s.executions, executionId);
      const meters = exec.meters;
      const index = meters?.findIndex(m => m.reservationId === reservationId) ?? -1;
      if (!meters || index < 0 || meters[index].input !== undefined || meters[index].output !== undefined) return;
      meters.splice(index, 1);
      exec.calls--;
      log('call.not_sent', { id: executionId, calls: exec.calls });
    });
  }
  recordUsage(executionId: string, usage: { inputTokens?: number; outputTokens?: number }) {
    this.write((s, log) => {
      const e = entity(s.executions, executionId);
      for (const count of Object.values(usage))
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new Error('用量无效');
      if (usage.inputTokens === undefined && usage.outputTokens === undefined) return;
      e.usage ??= {};
      const meter = e.meters?.at(-1);
      if (usage.inputTokens !== undefined) {
        e.usage.input = (e.usage.input ?? 0) + usage.inputTokens - (meter?.input ?? 0);
        if (meter) meter.input = usage.inputTokens;
      }
      if (usage.outputTokens !== undefined) {
        e.usage.output = (e.usage.output ?? 0) + usage.outputTokens - (meter?.output ?? 0);
        if (meter) meter.output = usage.outputTokens;
      }
      log('usage.recorded', { id: executionId, ...usage });
    });
  }
  fail(executionId: string, kind: Failure) {
    return this.write((s, log) => {
      const exec = entity(s.executions, executionId),
        task = entity(s.tasks, exec.taskId);
      if (task.active !== exec.id) {
        log('execution.late', { id: executionId, kind });
        return;
      }
      fence(s, task, 'failed', this.deps.now());
      if (kind === 'rate_limit' && !s.stoppedPools.includes(exec.pool)) s.stoppedPools.push(exec.pool);
      if (kind === 'transient' && task.retries < task.maxRetries) {
        task.retries++;
        refresh(task, s);
      } else transition(task, kind === 'fatal' || kind === 'transient' ? 'failed' : 'decision', kind);
      reconcileReplies(s, exec.owner, log, this.deps);
      log('execution.failed', { id: exec.id, kind, status: task.status });
    });
  }
  resumePool(pool: string) {
    this.write((s, log) => {
      s.stoppedPools = s.stoppedPools.filter((p) => p !== pool);
      log('pool.resumed', { pool });
    });
  }
  control(taskId: string, operation: Control, expectedExecutionId?: string) {
    return this.write((s, log) => {
      const task = entity(s.tasks, taskId);
      switch (operation) {
        case 'cancel':
        case 'pause':
          if (['done', 'failed', 'cancelled'].includes(task.status)) throw new Error('任务已经结束');
          fence(s, task, 'cancelled', this.deps.now());
          transition(task, operation === 'pause' ? 'paused' : 'cancelled');
          reconcileReplies(s, task.owner, log, this.deps);
          break;
        case 'resume':
        case 'retry':
          if (!['paused', 'decision', 'failed'].includes(task.status)) throw new Error('当前状态无法恢复');
          refresh(task, s);
          break;
        case 'accept':
        case 'rework': {
          if (task.status !== 'review') throw new Error('任务尚未进入审查');
          const result = reviewExecution(s, task);
          if (!result || (expectedExecutionId !== undefined && result.id !== expectedExecutionId))
            throw new Error('待审执行已改变，请重新核对');
          if (operation === 'accept') {
            task.acceptedExecution = result.id;
            transition(task, 'done');
          } else reopen(task, s, this.deps.now());
          break;
        }
        default:
          throw new Error('未知控制指令');
      }
      log('task.control', { taskId, operation, status: task.status });
      return task;
    });
  }
  reassign(taskId: string, owner: string) {
    return this.write((s, log) => {
      const task = entity(s.tasks, taskId),
        plan = activePlan(s);
      entity(plan.agents, owner);
      if (task.replyFor || ['done', 'cancelled'].includes(task.status)) throw new Error('此任务不能改派');
      fence(s, task, 'obsolete', this.deps.now());
      const previousOwner = task.owner;
      task.owner = owner;
      reconcileReplies(s, previousOwner, log, this.deps);
      entity(plan.tasks, taskId).owner = owner;
      s.revision++;
      s.plans.push(this.deps.storage.putContent(JSON.stringify(plan)));
      refresh(task, s);
      s.acceptance = null;
      log('task.reassigned', { taskId, owner, revision: s.revision });
      return task;
    });
  }
  reportConflict(issue: { id: string; taskIds: string[]; paths: string[] }) {
    if (
      !issue.id ||
      issue.id.length > 200 ||
      !issue.taskIds.length ||
      issue.taskIds.length > 256 ||
      issue.paths.length > 256
    )
      throw new Error('冲突记录无效');
    const paths = [...new Set(issue.paths)].sort(),
      taskIds = [...new Set(issue.taskIds)].sort();
    if (paths.some((path) => !path || path.length > 1024 || path.startsWith('/') || path.includes('\0')))
      throw new Error('冲突路径无效');
    return this.write((s, log) => {
      const key = JSON.stringify([issue.id]);
      const fingerprint = this.deps.storage.putContent(JSON.stringify({ taskIds, paths }));
      if (s.conflicts?.[key]) {
        if (s.conflicts[key] !== fingerprint) throw new Error('冲突编号已用于其他快照');
        return { duplicate: true };
      }
      const tasks = taskIds.map((id) => entity(s.tasks, id));
      s.conflicts ??= {};
      s.conflicts[key] = fingerprint;
      for (const task of tasks) {
        const message = '联调快照出现合并冲突，请协调修复并发布新版本。' + paths.join('、');
        const question = {
          id: this.deps.nextId(),
          taskId: task.id,
          from: 'integration',
          to: task.owner,
          question: message,
          blocking: true,
          hops: 1,
          status: 'open' as const,
        };
        s.questions.push(question);
        s.messages.push({
          id: this.deps.nextId(),
          taskId: task.id,
          forTask: task.id,
          from: 'integration',
          to: task.owner,
          message,
        });
        if (task.status === 'done' || task.status === 'review') reopen(task, s, this.deps.now());
        if (task.status !== 'ready') scheduleReply(s, question, log, this.deps);
        log('integration.conflict', {
          issueId: issue.id,
          taskId: task.id,
          to: task.owner,
          questionId: question.id,
        });
      }
      s.acceptance = null;
      return { duplicate: false };
    });
  }
  answerAsUser(questionId: string, answer: string) {
    if (!answer.trim() || answer.length > 32_768) throw new Error('答复长度无效');
    return this.write((s, log) => {
      const q = entity(s.questions, questionId);
      if (q.status !== 'open' || q.to !== 'user') throw new Error('该问题未等待用户答复');
      q.answer = answer;
      q.status = 'answered';
      s.messages.push({
        id: this.deps.nextId(),
        taskId: q.taskId,
        from: 'user',
        forTask: q.taskId,
        to: q.from,
        message: answer,
      });
      log('question.answered', { id: q.id, to: q.from });
      return q;
    });
  }
  sendAsUser(taskId: string, message: string) {
    if (!message.trim() || message.length > 32_768) throw new Error('消息长度无效');
    return this.write((s, log) => {
      const task = entity(s.tasks, taskId);
      s.messages.push({
        id: this.deps.nextId(),
        taskId,
        forTask: taskId,
        from: 'user',
        to: task.owner,
        message,
      });
      log('message.sent', { taskId, to: task.owner });
    });
  }
  stopAll() {
    return this.write((s, log) => {
      for (const task of s.tasks)
        if (!['done', 'cancelled', 'failed'].includes(task.status)) {
          fence(s, task, 'cancelled', this.deps.now());
          transition(task, 'cancelled');
          log('task.cancelled', { taskId: task.id });
        }
    });
  }
  recover() {
    return this.write((s, log) => {
      let count = 0;
      const interrupted = new Set<string>();
      for (const task of s.tasks)
        if (task.active) {
          const id = task.active;
          fence(s, task, 'interrupted', this.deps.now());
          transition(task, 'decision', '上次执行中断');
          interrupted.add(task.owner);
          log('execution.interrupted', { id, taskId: task.id });
          count++;
        }
      for (const owner of interrupted) reconcileReplies(s, owner, log, this.deps);
      return count;
    });
  }
  accept(expected?: AcceptanceSnapshot) {
    return this.write((s, log) => {
      const candidate = acceptanceCandidate(s);
      if (typeof candidate === 'string') throw new Error(candidate);
      if (expected && !sameAcceptance(candidate, expected)) throw new Error('验收快照已改变，请重新核对');
      s.acceptance = candidate.versions;
      s.acceptedSnapshot = candidate;
      log('plan.accepted', { snapshot: candidate.versions, acceptedExecutions: candidate.executions, revision: s.revision });
      return candidate.versions;
    });
  }
}
