import { ProposalReview } from './proposals.tsx';
import { ApprovalDetails, useApproval } from './approval.tsx';
import { useEffect, useRef, useState } from 'react';
import type { Catalog } from '@concordia/protocol/connections';
import type { Scheduler } from '../../../packages/core/src/workflow.ts';
import { api, browserFetch, useAction, useResource } from './api.ts';
import { InspectionPanel, type Inspection } from './inspection.tsx';
import { Empty, Field, Modal, Notice } from './ui.tsx';
import type { Worktrees } from './worktrees.tsx';

export type Board = ReturnType<Scheduler['board']>;
type Task = Board['tasks'][number];
const columns = { waiting: '等输入', doing: '进行中', review: '待验收', done: '已交付' };
const labels = {
  waiting: '等待依赖',
  ready: '已就绪',
  running: '运行中',
  decision: '等待用户决定',
  review: '审查中',
  paused: '已暂停',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};
type ControlName = 'pause' | 'resume' | 'retry' | 'accept' | 'rework' | 'cancel' | 'reassign';
export function filteredTasks(tasks: Task[], owner: string) {
  return owner === '' ? tasks : tasks.filter((t) => (owner === '(none)' ? !t.owner : t.owner === owner));
}

function waitDuration(ms: number, complete: boolean) {
  if (!complete && ms === 0) return '未知';
  const seconds = Math.floor(ms / 1000);
  const prefix = complete ? '' : '至少 ';
  if (ms > 0 && seconds === 0) return complete ? '不足 1 秒' : '已记录不足 1 秒';
  if (seconds < 60) return prefix + seconds + ' 秒';
  return prefix + Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
}

function waitSummary(task: Task) {
  const wait = task.waitTime;
  if (!wait || (!wait.complete && !wait.dependencyMs && !wait.queueMs)) return '等待耗时未知';
  return '等待依赖 ' + waitDuration(wait.dependencyMs, wait.complete) +
    ' · 就绪排队 ' + waitDuration(wait.queueMs, wait.complete) +
    ' · 等待验收 ' + waitDuration(wait.approvalMs ?? 0, !!wait.approvalTracked);
}

function TaskProgress({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await browserFetch('/api/tasks/' + encodeURIComponent(taskId) + '/progress', {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('无法读取任务进度（HTTP ' + response.status + '）');
        const latest = await response.text();
        if (!controller.signal.aborted) setText(latest);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '无法读取任务进度。');
      }
    };
    void load();
    return () => controller.abort();
  }, [taskId]);
  return (
    <section>
      <h3>最新进度</h3>
      <Notice error={error} />
      {text && <pre>{text}</pre>}
    </section>
  );
}

function TaskDetails({
  task,
  board,
  refresh,
  close,
}: {
  task: Task;
  board: Board;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const catalog = useResource<Catalog>('catalog');
  const work = useResource<Worktrees>('worktrees/state');
  const [owner, setOwner] = useState(task.owner);
  const [treeId, setTree] = useState('');
  const [maxCalls, setMax] = useState(1);
  const [unmanaged, setUnmanaged] = useState(false);
  const [inspection, setInspection] = useState<Inspection>();
  const [message, setMessage] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [askCancel, setAskCancel] = useState(false);
  const [reviewedExecution, setReviewedExecution] = useState(task.reviewExecutionId);
  const action = useAction(),
    control = useAction();
  const agent = board.agents.find((a) => a.id === task.owner);
  const member = catalog.data?.members.find((m) => m.id === task.owner);
  const connection = !agent?.connection.startsWith('mock-')
    ? catalog.data?.connections.find((c) => c.id === (member?.connectionId ?? agent?.connection))
    : undefined;
  const simulation = agent?.connection.startsWith('mock-');
  const isCli = connection?.kind === 'claude' || connection?.kind === 'codex';
  const eligibleTrees = work.data?.trees.filter((t) =>
    t.scope === work.data?.activeScope && t.taskId === task.id && t.kind === 'member' && t.status === 'ready'
  ) ?? [];
  const tree = eligibleTrees.find((t) => t.id === treeId);
  const approval = useApproval(!simulation && connection && task.status === 'ready' ? {
    purpose: 'task', id: task.id, maxCalls: String(isCli ? 1 : maxCalls), treeId: tree?.id, projectId: tree?.projectId,
  } : undefined);
  const needsUnmanaged = connection?.kind === 'claude';
  const id = 'tasks/' + encodeURIComponent(task.id) + '/';
  const perform = (name: ControlName) =>
    void control.run(async () => {
      await api(id + 'control', 'POST', {
        action: name,
        ...(name === 'reassign' && { owner }),
        ...((name === 'accept' || name === 'rework') && { expectedExecutionId: reviewedExecution }),
      });
      await refresh();
      setAskCancel(false);
    }, '任务状态已更新。');
  const relevant = board.executions
    .filter((e) => e.taskId === task.id)
    .slice()
    .reverse();
  const slotName = (id: string) => board.slots.find((s) => s.id === id)?.title ?? id;
  return (
    <Modal title={task.title} onClose={close}>
      {task.description && <p>{task.description}</p>}
      <div className="toolbar">
        <span className="tag on">{labels[task.status]}</span>
        <span>
          {agent?.name ?? task.owner} · {task.id}
        </span>
      </div>
      {task.reason && <p className="notice">{task.reason}</p>}
      <p>{waitSummary(task)}</p>
      {task.waitTime?.intervals.length > 0 && (
        <details>
          <summary>等待记录</summary>
          <ul>
            {task.waitTime.intervals.map((period, index) => (
              <li key={index}>
                {{ waiting:'等待依赖', ready:'就绪排队', review:'等待验收' }[period.kind]} ·{' '}
                {period.start === null ? '开始时间未知' : new Date(period.start).toLocaleString()}
                {period.end === null
                  ? '，截至 ' + new Date(task.waitTime.observedAt).toLocaleString() + ' 仍在等待'
                  : ' 至 ' + new Date(period.end).toLocaleString()}
                {period.blockedBy.map(({ slotId, owner }) => (
                  <span key={slotId}> · {slotName(slotId)}（{board.agents.find(a => a.id === owner)?.name ?? owner ?? '负责人未知'}）</span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
      {task.progressRef && <TaskProgress key={task.progressRef} taskId={task.id} />}
      <div className="diff-grid">
        <div>
          <strong>输入</strong>
          {task.consumes.map((c) => (
            <p key={c.slotId}>
              {slotName(c.slotId)} · {c.policy === 'pinned' ? c.version : '最新版本'}
            </p>
          ))}
        </div>
        <div>
          <strong>交付项</strong>
          {task.produces.map((s) => (
            <p key={s}>{slotName(s)}</p>
          ))}
        </div>
      </div>
      <Notice
        error={control.error || action.error || catalog.error || work.error}
        message={control.message || action.message}
      />
      {task.status === 'ready' && (
        <section className="panel">
          <h3>执行授权</h3>
          <div className="form-grid">
            {!isCli && !simulation && (
              <Field name="maxCalls" label="本次 API 请求次数上限">
                <input
                  id="maxCalls"
                  type="number"
                  min="1"
                  max={Math.min(task.maxCalls, 50)}
                  value={maxCalls}
                  onChange={(e) => setMax(Number(e.target.value))}
                />
              </Field>
            )}
            {!simulation && (
              <Field name="treeId" label="工作树">
                <select
                  id="treeId"
                  value={treeId}
                  onChange={(e) => {
                    setTree(e.target.value);
                    setInspection(undefined);
                  }}
                >
                  <option value="">仅文本</option>
                  {eligibleTrees.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.projectId} · {t.branch}
                      </option>
                    ))}
                </select>
              </Field>
            )}
          </div>
          {isCli && (
            <>
              {needsUnmanaged && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={unmanaged}
                    onChange={(e) => {
                      setUnmanaged(e.target.checked);
                      setInspection(undefined);
                    }}
                  />
                  已核对 Claude /status 没有受管设置
                </label>
              )}
              <div className="toolbar">
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () =>
                      setInspection(
                        await api(id + 'inspect', 'POST', {
                          ...(tree && { treeId: tree.id, projectId: tree.projectId }),
                          confirmUnmanaged: unmanaged,
                        }),
                      ),
                    )
                  }
                >
                  预检所选 CLI
                </button>
              </div>
              {inspection && <InspectionPanel result={inspection} />}
            </>
          )}
          {!simulation && <ApprovalDetails approval={approval}/>}
          <div className="toolbar">
            <button
              disabled={action.busy || !simulation}
              onClick={() =>
                void action.run(async () => {
                  await api(id + 'run', 'POST', { mode: 'simulation' });
                  await refresh();
                }, '已启动模拟执行。')
              }
            >
              模拟执行
            </button>
            <button
              className="primary"
              disabled={
                action.busy ||
                !connection?.enabled || !approval.preview ||
                Boolean(treeId && !tree) ||
                !Number.isInteger(maxCalls) ||
                maxCalls < 1 ||
                maxCalls > Math.min(50, task.maxCalls) ||
                (isCli && !inspection) ||
                (needsUnmanaged && !unmanaged)
              }
              onClick={() =>
                void action.run(async () => {
                  await api(id + 'run', 'POST', {
                    mode: 'live',
                    approved: true,
                    maxCalls: isCli ? 1 : maxCalls,
                    ...(tree && { treeId: tree.id, projectId: tree.projectId }),
                    ...(isCli && { confirmUnmanaged: unmanaged, inspectionId: inspection?.inspectionId }),
                  }, undefined, approval.preview?.stamp);
                  await refresh();
                }, '已启动真实执行。')
              }
            >
              {isCli ? '批准启动一次 CLI' : '批准真实执行（最多 ' + maxCalls + ' 次 API 请求）'}
            </button>
          </div>
          <p className="help">
            {isCli && 'CLI 内部可能发起多次模型调用，实际计费来源以预检和账单为准。'}
            {simulation
              ? '此任务使用假 Agent。'
              : connection
                ? connection.name + ' · ' + (member?.modelId ?? '默认模型')
                : '为此岗位绑定已启用的真实连接后可授权调用。'}
          </p>
        </section>
      )}
      <div className="toolbar">
        {['waiting', 'ready', 'running', 'decision', 'review'].includes(task.status) && (
          <button disabled={control.busy} onClick={() => perform('pause')}>
            暂停
          </button>
        )}
        {['paused', 'decision'].includes(task.status) && (
          <button disabled={control.busy} onClick={() => perform('resume')}>
            恢复
          </button>
        )}
        {task.status === 'failed' && (
          <button disabled={control.busy} onClick={() => perform('retry')}>
            手动重试
          </button>
        )}
        {task.status === 'review' && (
          <>
            <p>待审执行 {task.reviewExecutionId}</p>
            {reviewedExecution !== task.reviewExecutionId && (
              <button onClick={() => setReviewedExecution(task.reviewExecutionId)}>核对此次待审执行</button>
            )}
            <button className="primary" disabled={control.busy || reviewedExecution !== task.reviewExecutionId} onClick={() => perform('accept')}>
              验收通过
            </button>
            <button disabled={control.busy || reviewedExecution !== task.reviewExecutionId} onClick={() => perform('rework')}>
              打回返工
            </button>
          </>
        )}
        {!['cancelled', 'done', 'failed'].includes(task.status) && (
          <button
            className="danger"
            disabled={control.busy}
            onClick={() => (askCancel ? perform('cancel') : setAskCancel(true))}
          >
            {askCancel ? '确认取消本任务' : '取消任务'}
          </button>
        )}
      </div>
      {!['cancelled', 'done'].includes(task.status) && (
        <div className="toolbar">
          <select aria-label="改派负责人" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {board.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button disabled={control.busy || owner === task.owner} onClick={() => perform('reassign')}>
            改派负责人
          </button>
        </div>
      )}
      <details>
        <summary>执行记录（{relevant.length}）</summary>
        {relevant.map((e) => (
          <div key={e.id} className="history">
            <strong>
              {e.connection} · {e.status}
            </strong>
            <p>
              {new Date(e.started).toLocaleString()} · {e.calls} 次调用
            </p>
            <p>{e.id}</p>
            <pre>{JSON.stringify({ inputs: e.inputs, outputs: e.outputs, usage: e.usage }, null, 2)}</pre>
          </div>
        ))}
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void control.run(async () => {
            await api(id + 'message', 'POST', { message });
            setMessage('');
            await refresh();
          }, '消息已进入成员收件箱。');
        }}
      >
        <Field name="taskMessage" label="发送给负责人">
          <textarea
            id="taskMessage"
            value={message}
            maxLength={8000}
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
        <button disabled={control.busy || !message.trim()}>发送消息</button>
      </form>
      {board.questions
        .filter((q) => q.taskId === task.id)
        .map((q) => (
          <div className="history" key={q.id}>
            <strong>
              {q.from} → {q.to}
            </strong>
            <p>{q.question}</p>
            {q.answer && <p>答复：{q.answer}</p>}
            {q.to === 'user' && q.status === 'open' && (
              <>
                <textarea
                  aria-label={'答复 ' + q.question}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                />
                <button
                  disabled={control.busy || !answers[q.id]?.trim()}
                  onClick={() =>
                    void control.run(async () => {
                      await api('questions/' + encodeURIComponent(q.id) + '/answer', 'POST', {
                        answer: answers[q.id],
                      });
                      await refresh();
                    })
                  }
                >
                  回答问题
                </button>
              </>
            )}
          </div>
        ))}
    </Modal>
  );
}

export function BoardPage({ openPlans, events }: { openPlans: () => void; events: number }) {
  const { data: board, error, reload } = useResource<Board>('board');
  const [owner, setOwner] = useState('');
  const [selected, setSelected] = useState('');
  const openRequest = useRef(0);
  async function openTask(id: string) {
    const request = ++openRequest.current;
    await reload();
    if (openRequest.current === request) setSelected(id);
  }
  const [dialog, setDialog] = useState<'demo' | 'dispatch' | 'stop' | 'accept'>();
  const [expected, setExpected] = useState<Board['acceptanceCandidate']>(null);
  const [version, setVersion] = useState<{
    id: string;
    content: string;
    basedOn: Record<string, string>;
  }>();
  const [calls, setCalls] = useState(1);
  const approval = useApproval(dialog === 'dispatch' ? { purpose: 'dispatch', maxCalls: String(calls) } : undefined);
  const action = useAction();
  useEffect(() => {
    if (events) void reload();
  }, [events, reload]);
  const task = board?.tasks.find((t) => t.id === selected);
  const tasks = filteredTasks(board?.tasks ?? [], owner);
  const blocking = board?.slots.find((slot) => slot.id === board.criticalSlot);
  const demo = () => setDialog('demo');
  return (
    <>
      <header className="page-title">
        <div>
          <h1>协作任务板</h1>
          <p>{board?.spec?.goal || '查看成员分工、输入依赖与当前交付版本。'}</p>
        </div>
        <div className="actions">
          <button onClick={demo}>运行固定模拟</button>
          <button className="primary" onClick={openPlans}>
            工作流计划
          </button>
        </div>
      </header>
      <Notice error={error || action.error} message={action.message} />
      {board?.spec ? (
        <>
          {board.stoppedPools.map((pool) => (
            <div key={pool} className="notice">
              <strong>额度池已暂停 · {pool}</strong>{' '}
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api('pools/' + encodeURIComponent(pool) + '/resume', 'POST', {});
                    await reload();
                  })
                }
              >
                确认恢复派发
              </button>
            </div>
          ))}
          <section className="summary-band">
            <div>
              <span>当前需求</span>
              <h2>{board.spec.title}</h2>
              <p>
                修订 {board.revision} · {board.tasks.length} 项任务
              </p>
            </div>
            <div>
              <span>调用预算</span>
              <strong>
                {board.executions.reduce((sum, e) => sum + e.calls, 0)} / {board.spec.maxCalls}
              </strong>
            </div>
            <div>
              <span>优先交付</span>
              <strong>{blocking?.title ?? '无可单项解锁的输入'}</strong>
              {blocking && <p>可解除 {blocking.unblocks} 项任务的等待</p>}
            </div>
          </section>
          <div className="toolbar">
            <label>
              负责人{' '}
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">全部成员</option>
                <option value="(none)">未分配</option>
                {board.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {owner && <button onClick={() => setOwner('')}>清除筛选</button>}
            <button onClick={() => setDialog('dispatch')}>授权并发派发</button>
            <button onClick={() => { setExpected(board.acceptanceCandidate); setDialog('accept'); }}>验收主卡</button>
            <button className="danger" onClick={() => setDialog('stop')}>
              全局停止
            </button>
          </div>
          <ProposalReview key={board.spec.id} proposals={board.proposals ?? []} refresh={reload} />
          <div className="kanban">
            {(Object.keys(columns) as (keyof typeof columns)[]).map((col) => (
              <section key={col} className={'lane ' + col}>
                <h2>
                  {columns[col]} <span>{tasks.filter((t) => t.column === col).length}</span>
                </h2>
                {tasks
                  .filter((t) => t.column === col)
                  .map((t) => (
                    <button className="card" key={t.id} onClick={() => void openTask(t.id)}>
                      <span className={'tag status-' + t.status}>{labels[t.status]}</span>
                      <strong>{t.title}</strong>
                      <small>{board.agents.find((a) => a.id === t.owner)?.name || '未分配'}</small>
                      {(t.status === 'waiting' || t.status === 'ready') && <small>{waitSummary(t)}</small>}
                      {t.missing.length > 0 && (
                        <small>
                          等待{' '}
                          {t.missing
                            .map((id) => board.slots.find((s) => s.id === id)?.title ?? id)
                            .join('、')}
                        </small>
                      )}
                      {t.reason && <small>{t.reason}</small>}
                    </button>
                  ))}
              </section>
            ))}
          </div>
          <details className="panel">
            <summary>验收条件与交付版本（{board.versions.length}）</summary>
            <ul>
              {board.spec.acceptance.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            {board.versions.map((v) => (
              <div className="history" key={v.id}>
                <strong>
                  {board.slots.find((s) => s.id === v.slotId)?.title ?? v.slotId} · v{v.number}
                </strong>
                <button
                  className="text-button"
                  onClick={() =>
                    void action.run(async () =>
                      setVersion(await api('versions/' + encodeURIComponent(v.id))),
                    )
                  }
                >
                  查看交付物
                </button>
                <p>
                  {v.kind === 'git_commit' ? 'Git 提交' : '文本'} · {v.stale ? '基于旧版本' : '有效'} ·{' '}
                  {v.id}
                </p>
              </div>
            ))}
            {board.acceptance && <pre>{JSON.stringify(board.acceptance, null, 2)}</pre>}
          </details>
          {board.messages.length > 0 && (
            <details className="panel">
              <summary>交接消息（{board.messages.length}）</summary>
              {board.messages.map((m) => (
                <p key={m.id}>
                  {m.from} → {m.to} · {m.message}
                </p>
              ))}
            </details>
          )}
        </>
      ) : (
        board && (
          <section className="surface">
            <Empty>
              <strong>工作区尚无任务</strong>
              <p>从计划模板开始，或使用假 Agent 演示完整流程。</p>
              <button onClick={openPlans}>创建计划</button>
            </Empty>
          </section>
        )
      )}
      {version && (
        <Modal title="交付物版本" onClose={() => setVersion(undefined)}>
          <p>{version.id}</p>
          <pre>{version.content}</pre>
          <details>
            <summary>来源版本</summary>
            <pre>{JSON.stringify(version.basedOn, null, 2)}</pre>
          </details>
        </Modal>
      )}
      {task && board && (
        <TaskDetails
          key={task.id}
          task={task}
          board={board}
          close={() => setSelected('')}
          refresh={reload}
        />
      )}
      {dialog && (
        <Modal
          title={
            { demo: '运行固定模拟', dispatch: '并发派发', stop: '全局停止', accept: '验收主卡' }[dialog]
          }
          onClose={() => setDialog(undefined)}
        >
          <p>
            {
              {
                demo: '用假 Agent 运行「按负责人筛选」工作流，不调用真实模型。',
                dispatch: '批准本次派发中的真实模型调用。实际费用取决于所选连接。',
                stop: '取消当前工作区全部未结束任务并终止在途执行；已发出的调用可能已经计费。',
                accept: '按当前交付物版本快照检查验收条件。',
              }[dialog]
            }
          </p>
          {dialog === 'accept' && (expected ? <div>
            <p>计划 {expected.planId} · 修订 {expected.revision}</p>
            <p>交付物版本</p><pre>{JSON.stringify(expected.versions, null, 2)}</pre>
            <p>已审执行</p><pre>{JSON.stringify(expected.executions, null, 2)}</pre>
          </div> : <p>{board?.acceptanceBlocker ?? '尚无可验收的快照'}</p>)}
          {dialog === 'dispatch' && <ApprovalDetails approval={approval}/>}
          {dialog === 'dispatch' && (
            <Field name="callBudget" label="本次调用上限">
              <input
                type="number"
                id="callBudget"
                min={1}
                max={50}
                value={calls}
                onChange={(e) => setCalls(Number(e.target.value))}
              />
            </Field>
          )}
          <Notice error={action.error} />
          <div className="modal-actions">
            <button onClick={() => setDialog(undefined)}>关闭</button>
            <button
              className={dialog === 'stop' ? 'danger' : 'primary'}
              disabled={
                action.busy ||
                (dialog === 'accept' && !expected) ||
                (dialog === 'dispatch' && (!approval.preview || !Number.isInteger(calls) || calls < 1 || calls > 50))
              }
              onClick={() =>
                void action.run(async () => {
                  const url = { demo: 'demo/run', dispatch: 'dispatch', stop: 'stop', accept: 'accept' }[
                    dialog
                  ];
                  await api(url, 'POST', dialog === 'dispatch' ? { approved: true, maxCalls: calls } : dialog === 'accept' ? { expected } : {}, undefined, dialog === 'dispatch' ? approval.preview?.stamp : undefined);
                  await reload();
                  setDialog(undefined);
                }, '已更新任务板。')
              }
            >
              {{ demo: '运行模拟', dispatch: '批准并派发', stop: '确认停止', accept: '检查并验收' }[dialog]}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
