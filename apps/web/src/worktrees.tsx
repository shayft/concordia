import { useState, type FormEvent } from 'react';
import { api, useAction, useResource } from './api.ts';
import { Delivery } from './delivery.tsx';
import { Empty, Field, Modal, Notice } from './ui.tsx';

type Command = { name: string; executable: string; args: string[] };
type Project = {
  id: string;
  repository: string;
  targetBranch: string;
  writeEnabled: boolean;
  commands: Command[];
};
export interface Tree {
  scope: string | null;
  id: string;
  projectId: string;
  taskId: string | null;
  kind: 'member' | 'integration';
  path: string;
  branch: string;
  base: string;
  status: string;
  sha: string | null;
  conflicts: string[];
  snapshot: { treeId: string; sha: string }[];
}
interface MemberDiff {
  treeId: string;
  baseSha: string;
  sha: string | null;
  diff: string;
  untracked: string[];
}
interface Approval {
  id: string;
  treeId: string;
  kind: 'command' | 'merge';
  available: boolean;
  diagnostic?: string;
  sha: string;
  name?: string;
  executable?: string;
  args?: string[];
  diff?: string;
  targetSha?: string;
  acceptance?: {
    workspaceId: string;
    planId: string;
    revision: number;
    sources: { versionId: string; treeId: string; sha: string }[];
  } | null;
  check?: {
    id: string;
    name: string;
    result: { exitCode: number | null; elapsedMs: number; passed: boolean };
  };
}
export interface Worktrees {
  activeScope: string | null;
  projects: Project[];
  trees: Tree[];
  approvals: Approval[];
  issues: { id: string; projectId: string; taskIds: string[]; paths: string[] }[];
  results: { treeId: string; name: string | null; status: string; result: unknown }[];
}
const base = 'worktrees/';
export function WorktreesPage() {
  const state = useResource<Worktrees>(base + 'state');
  const board = useResource<{ tasks: { id: string; title: string }[] }>('board');
  const feedback = useAction();
  const [projectId, setProjectId] = useState('');
  const [task, setTask] = useState('');
  const [selected, setSelected] = useState<{ treeId: string; sha: string }[]>([]);
  const [editing, setEditing] = useState<Project | null>();
  const [inspect, setInspect] = useState<Approval>();
  const [removing, setRemoving] = useState<Tree>();
  const [memberDiff, setMemberDiff] = useState<MemberDiff>();
  const cancel = useAction();
  const [review, setReview] = useState('');
  const selectedProject = state.data?.projects.find((p) => p.id === projectId) ?? state.data?.projects[0];
  const trees =
    state.data?.trees.filter((t) => t.projectId === selectedProject?.id && t.status !== 'removed') ?? [];
  async function mutate<T>(path: string, body: object) {
    const value = await api<T>(base + path, 'POST', body);
    await state.reload();
    return value;
  }
  function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void feedback.run(async () => {
      const raw = String(f.get('commands') ?? '').trim();
      let commands: unknown;
      try {
        commands = raw ? JSON.parse(raw) : [];
      } catch {
        throw new Error('命令清单需要 JSON 数组。');
      }
      const id = String(f.get('id')).trim();
      await mutate('projects', {
        id,
        repository: String(f.get('repository')).trim(),
        targetBranch: String(f.get('targetBranch')).trim(),
        writeEnabled: f.get('writeEnabled') === 'on',
        commands,
      });
      setProjectId(id);
      setEditing(undefined);
    }, '已保存项目授权。');
  }
  function showDiff(treeId: string, sha?: string) {
    void feedback.run(async () =>
      setMemberDiff(await api<MemberDiff>(base + 'diff', 'POST', { treeId, ...(sha && { sha }) })),
    );
  }
  function command(tree: Tree, name: string) {
    void feedback.run(async () => {
      await mutate('request-command', { treeId: tree.id, name });
    }, '命令已进入待审批列表。');
  }
  return (
    <>
      <header className="page-title">
        <div>
          <h1>代码与联调</h1>
          <p>按交付版本组装独立 worktree，审查命令与合并差异。</p>
        </div>
        <button className="primary" onClick={() => setEditing(null)}>
          ＋ 注册项目
        </button>
      </header>
      <Delivery />
      <Notice error={state.error || board.error || feedback.error} message={feedback.message} />
      <div className="toolbar">
        <label>
          Git 项目{' '}
          <select
            value={selectedProject?.id ?? ''}
            onChange={(e) => {
              setProjectId(e.target.value);
              setSelected([]);
              setReview('');
            }}
          >
            <option value="" disabled>
              选择项目
            </option>
            {state.data?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedProject ? (
        <>
          <section className="panel">
            <div className="section-head flush">
              <h2>{selectedProject.id}</h2>
              <button onClick={() => setEditing(selectedProject)}>编辑项目授权</button>
            </div>
            <p className="muted">
              {selectedProject.repository} · 目标分支 {selectedProject.targetBranch} ·{' '}
              {selectedProject.writeEnabled ? '已授权写入' : '只读'}
            </p>
            <div className="toolbar">
              <select
                aria-label="需要独立工作树的任务"
                value={task}
                onChange={(e) => setTask(e.target.value)}
              >
                <option value="">选择任务</option>
                {board.data?.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
              <button
                disabled={!task || !selectedProject.writeEnabled || feedback.busy}
                onClick={() =>
                  void feedback.run(async () => {
                    await mutate('member', { projectId: selectedProject.id, taskId: task });
                  }, '已创建任务 worktree。')
                }
              >
                创建成员 worktree
              </button>
            </div>
          </section>
          <section className="surface">
            <div className="section-head">
              <h2>工作树与提交</h2>
              <span>{trees.length} 项</span>
            </div>
            {!trees.length && <Empty>此项目尚无平台创建的 worktree。</Empty>}
            {trees.map((t) => (
              <article className="record" key={t.id}>
                <div className="record-info">
                  <h3>
                    {t.branch} <small className="tag">{t.kind === 'member' ? '成员' : '联调'}</small>
                  </h3>
                  <p>
                    {t.path} · {t.sha?.slice(0, 12) ?? t.status}
                  </p>
                  {t.conflicts?.length > 0 && <p>冲突文件：{t.conflicts.join('、')}</p>}
                  {t.kind === 'member' && t.sha && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={selected.some((s) => s.treeId === t.id && s.sha === t.sha)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked && t.sha
                              ? [...selected.filter((s) => s.treeId !== t.id), { treeId: t.id, sha: t.sha }]
                              : selected.filter((s) => s.treeId !== t.id),
                          )
                        }
                      />
                      选择提交 {t.sha.slice(0, 12)} 用于联调
                    </label>
                  )}
                </div>
                <div className="actions">
                  {t.kind === 'member' && (
                    <>
                      <button disabled={feedback.busy} onClick={() => showDiff(t.id)}>
                        查看未提交差异
                      </button>
                      {t.sha && (
                        <button disabled={feedback.busy} onClick={() => showDiff(t.id, t.sha!)}>
                          查看已发布差异
                        </button>
                      )}
                    </>
                  )}
                  {t.kind === 'member' && (
                    <button
                      disabled={feedback.busy}
                      onClick={() =>
                        void feedback.run(async () => {
                          await mutate('publish', { treeId: t.id });
                        }, '已提交此工作树当前的变更。')
                      }
                    >
                      提交交付版本
                    </button>
                  )}
                  {selectedProject.commands.map((c) => (
                    <button key={c.name} disabled={feedback.busy} onClick={() => command(t, c.name)}>
                      申请运行 {c.name}
                    </button>
                  ))}
                  {t.kind === 'integration' && (
                    <button
                      disabled={feedback.busy}
                      onClick={() =>
                        void feedback.run(async () => {
                          const result = await mutate<Approval>('review-merge', { treeId: t.id });
                          setInspect(result);
                        })
                      }
                    >
                      审查合并差异
                    </button>
                  )}
                  <button className="text-button danger" onClick={() => setRemoving(t)}>
                    清理
                  </button>
                </div>
              </article>
            ))}
          </section>
          {selected.length > 0 && (
            <p className="help">
              所选快照：{selected.map((s) => s.sha.slice(0, 12)).join(' · ')}{' '}
              <button onClick={() => setSelected([])}>清除选择</button>
            </p>
          )}
          <button
            disabled={!selected.length || feedback.busy}
            onClick={() =>
              void feedback.run(async () => {
                await mutate('integrate', { projectId: selectedProject.id, snapshot: selected });
                setSelected([]);
              }, '已按所选版本创建联调记录。')
            }
          >
            按所选提交联调（{selected.length}）
          </button>
        </>
      ) : (
        state.data && (
          <section className="surface">
            <Empty>注册本地 Git 项目，指定目标分支和允许执行的命令。</Empty>
          </section>
        )
      )}
      <section className="surface space-top">
        <div className="section-head">
          <h2>待审批</h2>
        </div>
        {state.data?.approvals
          .filter((a) => trees.some((t) => t.id === a.treeId))
          .map((a) => (
            <article className="record" key={a.id}>
              <div className="record-info">
                <h3>{a.kind === 'merge' ? '合并联调分支' : a.name ? '运行 ' + a.name : '运行项目命令'}</h3>
                <p>
                  {a.sha} · {a.treeId}
                </p>
                {a.diagnostic && <Notice error={a.diagnostic} />}
              </div>
              <button disabled={a.available === false} onClick={() => setInspect(a)}>
                查看并审批
              </button>
            </article>
          ))}
        {state.data && !state.data.approvals.some((a) => trees.some((t) => t.id === a.treeId)) && (
          <Empty>暂无待审批操作。</Empty>
        )}
      </section>
      {state.data?.issues
        ?.filter((i) => i.projectId === selectedProject?.id)
        .map((i) => (
          <div key={i.id} className="notice error">
            <strong>联调冲突</strong>
            <p>{i.paths.join('、')}</p>
            <p>已通知 {i.taskIds.join('、')}</p>
          </div>
        ))}
      {selectedProject && (
        <details className="panel">
          <summary>项目命令与合并记录</summary>
          {state.data?.results
            ?.filter((r) => trees.some((t) => t.id === r.treeId))
            .map((r, index) => (
              <div className="history" key={r.treeId + '-' + index}>
                <strong>
                  {r.name ?? '合并'} · {r.status}
                </strong>
                <p>{r.treeId}</p>
                {r.result != null && <pre>{JSON.stringify(r.result, null, 2)}</pre>}
                {r.status === 'running' && (
                  <button
                    disabled={cancel.busy}
                    onClick={() =>
                      void cancel.run(async () => {
                        await mutate('cancel-command', { treeId: r.treeId });
                      })
                    }
                  >
                    取消项目命令
                  </button>
                )}
              </div>
            ))}
        </details>
      )}
      <Notice error={cancel.error} />
      {review && (
        <p role="status" className="notice">
          {review}
        </p>
      )}
      {editing !== undefined && (
        <Modal title={editing ? '编辑项目授权' : '注册 Git 项目'} onClose={() => setEditing(undefined)}>
          <form onSubmit={saveProject}>
            <fieldset disabled={feedback.busy}>
              <div className="form-grid">
                <Field name="id" label="项目标识">
                  <input
                    id="id"
                    name="id"
                    required
                    readOnly={Boolean(editing)}
                    defaultValue={editing?.id}
                  />
                </Field>
                <Field name="targetBranch" label="目标分支">
                  <input
                    id="targetBranch"
                    name="targetBranch"
                    required
                    defaultValue={editing?.targetBranch}
                    placeholder="main"
                  />
                </Field>
              </div>
              <Field name="repository" label="本地 Git 仓库绝对路径">
                <input id="repository" name="repository" required defaultValue={editing?.repository} />
              </Field>
              <Field name="commands" label="命令清单（可选 JSON 数组）">
                <textarea
                  name="commands"
                  id="commands"
                  defaultValue={(editing && JSON.stringify(editing.commands, null, 2)) || ''}
                  placeholder='[{"name":"test","executable":"/absolute/path/to/node","args":["--test"]}]'
                />
              </Field>
              <label className="check">
                <input type="checkbox" name="writeEnabled" defaultChecked={editing?.writeEnabled} />
                允许 Concordia 在独立 worktree 中写代码
              </label>
              <Notice error={feedback.error} />
              <div className="modal-actions">
                <button>保存授权</button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {memberDiff && (
        <Modal
          title={memberDiff.sha ? '已发布提交差异' : '未提交的工作树差异'}
          onClose={() => setMemberDiff(undefined)}
        >
          <p>
            工作树 {memberDiff.treeId} · 基线 {memberDiff.baseSha}
          </p>
          {memberDiff.sha && <p>发布提交 {memberDiff.sha}</p>}
          <pre>{memberDiff.diff || '没有已跟踪文件的差异。'}</pre>
          {memberDiff.untracked.length > 0 && (
            <>
              <h3>未跟踪的文件</h3>
              <ul>
                {memberDiff.untracked.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </>
          )}
        </Modal>
      )}
      {inspect && (
        <Modal
          title={inspect.kind === 'merge' ? '审查合并差异' : '审批项目命令'}
          onClose={() => setInspect(undefined)}
        >
          <p>提交 {inspect.sha}</p>
          {inspect.kind === 'merge' && (
            <>
              <p>目标基线 {inspect.targetSha ?? '未知'}</p>
              {inspect.acceptance && (
                <section>
                  <h3>已验收的版本</h3>
                  <p>
                    工作区 {inspect.acceptance.workspaceId} · 计划 {inspect.acceptance.planId} · 修订{' '}
                    {inspect.acceptance.revision}
                  </p>
                  <ul>
                    {inspect.acceptance.sources.map((item) => (
                      <li key={item.versionId}>
                        版本 {item.versionId} · 工作树 {item.treeId} · 提交 {item.sha}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {inspect.check && (
                <section>
                  <h3>联调测试</h3>
                  <p>
                    {inspect.check.name} · {inspect.check.result.passed ? '通过' : '失败'} · 退出码{' '}
                    {inspect.check.result.exitCode ?? '未知'} · 耗时 {inspect.check.result.elapsedMs} ms
                  </p>
                </section>
              )}
            </>
          )}
          <pre>
            {inspect.kind === 'merge'
              ? inspect.diff
              : JSON.stringify([inspect.executable, ...(inspect.args ?? [])], null, 2)}
          </pre>
          <Notice error={feedback.error || cancel.error} />
          <div className="modal-actions">
            {feedback.busy && inspect.kind === 'command' && (
              <button
                disabled={cancel.busy}
                onClick={() =>
                  void cancel.run(async () => {
                    await api(base + 'cancel-command', 'POST', { treeId: inspect.treeId });
                  })
                }
              >
                取消正在运行的命令
              </button>
            )}
            <button onClick={() => setInspect(undefined)}>关闭</button>
            <button
              className="primary"
              disabled={feedback.busy}
              onClick={() =>
                void feedback.run(async () => {
                  if (inspect.kind === 'merge') {
                    const r = await mutate<{ merged: boolean; branch: string; reason?: string }>(
                      'approve-merge',
                      { id: inspect.id },
                    );
                    setReview(
                      r.merged ? '已合并 ' + r.branch : '已交付分支 ' + r.branch + '。' + (r.reason ?? ''),
                    );
                  } else {
                    const r = await mutate<{ exitCode: number; passed: boolean; elapsedMs: number }>(
                      'approve-command',
                      { id: inspect.id },
                    );
                    setReview(
                      (r.passed ? '命令通过' : '命令失败') +
                        ' · 退出码 ' +
                        r.exitCode +
                        ' · ' +
                        r.elapsedMs +
                        ' ms',
                    );
                  }
                  setInspect(undefined);
                })
              }
            >
              {inspect.kind === 'merge' ? '批准合并到目标分支' : '批准运行一次'}
            </button>
          </div>
        </Modal>
      )}
      {removing && (
        <Modal title="清理工作树" onClose={() => setRemoving(undefined)}>
          <p>将移除 {removing.path}。平台创建的分支保留。</p>
          <Notice error={feedback.error} />
          <div className="modal-actions">
            <button onClick={() => setRemoving(undefined)}>取消</button>
            <button
              className="danger"
              disabled={feedback.busy}
              onClick={() =>
                void feedback.run(async () => {
                  await mutate('remove', { treeId: removing.id });
                  setRemoving(undefined);
                })
              }
            >
              确认清理
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
