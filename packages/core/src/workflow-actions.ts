import { proposedSpec, proposals, type Proposal } from './proposals.ts';
import type { PlatformAction } from '@concordia/protocol';
import type { CoreDependencies } from './index.ts';
import {
  activePlan,
  entity,
  fence,
  latest,
  makeTask,
  refresh,
  reopen,
  transition,
  type Append,
  type Execution,
  type Question,
  type State,
  type Task,
  type WorkflowStorage,
} from './state.ts';

export function scheduleReply(
  state: State,
  q: Question,
  log: Append,
  deps: CoreDependencies<WorkflowStorage>,
  requireDecision = false,
) {
  if (!q.blocking || q.to === 'user' || q.status !== 'open') return;
  // A reply explicitly cancelled or paused by the user stays in that state.
  if (q.replyTaskId && state.tasks.some(t => t.id === q.replyTaskId)) return;
  const assigned = state.tasks.find(t => t.owner === q.to && t.replyFor === q.taskId &&
    ['waiting','ready','decision','failed','paused'].includes(t.status));
  if (assigned) {
    q.replyTaskId = assigned.id;
    return;
  }
  if (state.tasks.some(t => t.owner === q.to && t.status === 'running')) return;
  const reply = makeTask({
    id: 'reply-' + deps.nextId(),
    title: '答复 · ' + entity(state.tasks, q.taskId).title,
    owner: q.to,
    consumes: [],
    produces: [],
    maxCalls: 3,
    maxRework: 1,
    maxRetries: 1,
  });
  reply.replyFor = q.taskId;
  q.replyTaskId = reply.id;
  if (requireDecision) transition(reply, 'decision', '收件人的执行已结束，请决定是否答复');
  else refresh(reply, state);
  state.tasks.push(reply);
  log('reply.scheduled', { taskId: reply.id, to: q.to });
}

export function reconcileReplies(state: State, owner: string, log: Append, deps: CoreDependencies<WorkflowStorage>) {
  for (const question of state.questions) {
    if (question.to === owner && question.blocking && question.status === 'open')
      scheduleReply(state, question, log, deps, true);
  }
}

export function applyAction(
  s: State,
  exec: Execution,
  task: Task,
  action: PlatformAction,
  log: Append,
  deps: CoreDependencies<WorkflowStorage>,
): unknown {
  const plan = activePlan(s);
  switch (action.type) {
    case 'publish_artifact': {
      if (!task.produces.includes(action.slotId)) throw new Error('任务未声明该产出槽位');
      const old = latest(s, action.slotId);
      const version = {
        id: deps.nextId(),
        slotId: action.slotId,
        number: (old?.number ?? 0) + 1,
        taskId: task.id,
        executionId: exec.id,
        kind: action.kind ?? ('text' as const),
        contentRef: deps.storage.putContent(action.content),
        basedOn: { ...exec.inputs },
        incompatible: action.incompatible ?? false,
        stale: Object.values(exec.inputs).some((id) => entity(s.versions, id).stale),
        time: deps.now(),
      };
      if (
        old &&
        old.executionId === exec.id &&
        old.contentRef === version.contentRef &&
        old.kind === version.kind &&
        old.incompatible === version.incompatible
      )
        return old;
      if (version.incompatible) {
        for (const v of s.versions) {
          if (
            v.slotId === action.slotId ||
            Object.values(v.basedOn).some((id) => entity(s.versions, id).stale)
          )
            v.stale = true;
        }
      }
      s.versions.push(version);
      exec.outputs[action.slotId] = version.id;
      log('artifact.published', {
        id: version.id,
        slotId: version.slotId,
        executionId: exec.id,
        number: version.number,
      });
      if (s.acceptance && Object.values(s.acceptance).some((id) => entity(s.versions, id).stale))
        s.acceptance = null;
      const interruptedOwners = new Set<string>();
      for (const downstream of s.tasks) {
        const last = s.executions.findLast((e) => e.taskId === downstream.id);
        if (
          version.incompatible &&
          last &&
          !['paused', 'cancelled', 'failed', 'waiting', 'ready', 'decision'].includes(downstream.status) &&
          downstream.consumes.some(
            (c) =>
              c.policy === 'latest' &&
              last.inputs[c.slotId] &&
              entity(s.versions, last.inputs[c.slotId]).stale,
          )
        ) {
          if (downstream.active) interruptedOwners.add(downstream.owner);
          reopen(downstream, s, deps.now());
          log('task.stale', { taskId: downstream.id, versionId: version.id });
          continue;
        }
        if (downstream.status === 'ready' || downstream.status === 'waiting') refresh(downstream, s);
        if (!downstream.consumes.some((c) => c.slotId === action.slotId)) continue;
        const key = JSON.stringify([downstream.id, version.id]);
        if (!s.wakeups.includes(key)) {
          s.wakeups.push(key);
          log('dependency.updated', {
            taskId: downstream.id,
            versionId: version.id,
            status: downstream.status,
          });
        }
      }
      for (const owner of interruptedOwners) reconcileReplies(s, owner, log, deps);
      return version;
    }
    case 'read_artifact': {
      if (!task.consumes.some((c) => c.slotId === action.slotId) && !task.produces.includes(action.slotId))
        throw new Error('无权读取此槽位');
      const bound = exec.inputs[action.slotId] ?? exec.outputs[action.slotId];
      if (action.versionId && action.versionId !== bound) throw new Error('执行只能读取绑定的版本');
      const id = bound;
      const v = id ? entity(s.versions, id) : undefined;
      if (!v || v.slotId !== action.slotId) throw new Error('版本不存在');
      const content = deps.storage.getContent(v.contentRef);
      if (v.kind === 'git_commit') {
        if (action.offset !== undefined || action.limit !== undefined) throw new Error('文本分页仅适用于文本版本');
        return { ...v, content };
      }
      const points = Array.from(content);
      const offset = action.offset ?? 0;
      if (offset > points.length) throw new Error('读取位置超出版本长度');
      const end = Math.min(points.length, offset + (action.limit ?? 2048));
      return { ...v, content: points.slice(offset, end).join(''), ...(end < points.length && { nextOffset: end }) };
    }
    case 'ask_question': {
      if (action.to !== 'user') entity(plan.agents, action.to);
      const previous = action.replyTo ? entity(s.questions, action.replyTo) : undefined;
      if (previous && previous.to !== exec.owner) throw new Error('仅收件人能继续问题链');
      const hops = (previous?.hops ?? 0) + 1,
        lead = plan.agents.find((a) => a.role === 'lead')?.id;
      const to =
        hops > plan.maxHops
          ? !lead || previous?.to === lead || exec.owner === lead
            ? 'user'
            : lead
          : action.to;
      const q: Question = {
        id: deps.nextId(),
        taskId: task.replyFor ?? task.id,
        from: exec.owner,
        to,
        question: action.question,
        blocking: action.blocking,
        hops,
        replyTo: action.replyTo,
        status: 'open',
      };
      s.questions.push(q);
      log('question.asked', { id: q.id, to, taskId: q.taskId, hops });
      scheduleReply(s, q, log, deps);
      return q;
    }
    case 'answer_question': {
      const q = entity(s.questions, action.questionId);
      if (q.to !== exec.owner || q.status !== 'open') throw new Error('只有问题收件人可以答复未结问题');
      q.answer = action.answer;
      q.status = 'answered';
      s.messages.push({
        id: deps.nextId(),
        taskId: q.taskId,
        from: exec.owner,
        to: q.from,
        message: action.answer,
        forTask: q.taskId,
      });
      log('question.answered', { id: q.id, to: q.from });
      return q;
    }
    case 'send_message':
      if (action.to !== 'user') entity(plan.agents, action.to);
      s.messages.push({
        id: deps.nextId(),
        taskId: task.id,
        from: exec.owner,
        to: action.to,
        message: action.message,
      });
      log('message.sent', { taskId: task.id, to: action.to });
      return { delivered: true };
    case 'progress':
      task.progressRef = deps.storage.putContent(action.message);
      log('task.progress', { taskId: task.id, contentRef: task.progressRef });
      return { recorded: true };
    case 'request_review':
    case 'submit_result':
      if (action.type === 'request_review' && action.taskId !== task.id)
        throw new Error('只能提交当前任务的审查');
      if (task.produces.some((slot) => !exec.outputs[slot])) throw new Error('声明的交付物尚未全部发布');
      if (
        task.replyFor &&
        s.questions.some(
          (q) => q.replyTaskId === task.id && q.to === exec.owner && q.status === 'open' && q.blocking,
        )
      )
        throw new Error('待答复问题尚未处理');
      if (action.type === 'submit_result') exec.resultRef = deps.storage.putContent(action.summary);
      fence(s, task, 'success', deps.now());
      transition(task, 'review');
      log('execution.submitted', { id: exec.id, taskId: task.id });
      for (const question of s.questions.filter((q) => q.to === exec.owner))
        scheduleReply(s, question, log, deps);
      return { status: 'review' };
    case 'create_task':
    case 'assign_task': {
      if (entity(plan.agents, exec.owner).role !== 'lead') throw new Error('只有负责人可以提议修改计划');
      const existing = proposals(s).find(p => p.executionId === exec.id && JSON.stringify(p.action) === JSON.stringify(action));
      if (existing) return { approvalRequired: existing.status === 'pending', proposalId: existing.id };
      proposedSpec(s, action);
      const proposal: Proposal = { id: deps.nextId(), planId: plan.id, submittedRevision: s.revision,
        executionId: exec.id, action, status: 'pending' };
      s.proposals ??= [];
      s.proposals.push(proposal);
      log('plan.proposed', { id: proposal.id, executionId: exec.id, kind: action.type });
      return { approvalRequired: true, proposalId: proposal.id };
    }
    case 'write_file':
    case 'read_file':
    case 'commit_artifact':
    case 'run_project_command':
      throw new Error('项目命令需要项目级配置和用户批准');
  }
}
