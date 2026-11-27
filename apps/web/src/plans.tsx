import { useState } from 'react';
import type { Catalog } from '@concordia/protocol/connections';
import type { WorkflowSpec } from '@concordia/protocol/workflow';
import { api, useAction, useResource } from './api.ts';
import { Field, Notice } from './ui.tsx';

interface Preview {
  spec: WorkflowSpec;
  revision: number;
  added: string[];
  changed: string[];
  removed: string[];
}
export function PlansPage({ openBoard }: { openBoard: () => void }) {
  const catalog = useResource<Catalog>('catalog');
  const [source, setSource] = useState('demo');
  const [draft, setDraft] = useState('');
  const [goal, setGoal] = useState('');
  const [agent, setAgent] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [unmanaged, setUnmanaged] = useState(false);
  const [inspection, setInspection] = useState<{
    inspectionId: string;
    version: string;
    billing: string;
    login: string;
  }>();
  const [preview, setPreview] = useState<Preview>();
  const action = useAction();
  function edit(value: string) {
    setDraft(value);
    setPreview(undefined);
  }
  const enabled = catalog.data?.members.filter((m) => m.enabled) ?? [];
  const member = enabled.find((m) => m.id === agent);
  const connection = catalog.data?.connections.find((c) => c.id === member?.connectionId);
  const cli = connection && !('baseUrl' in connection);
  const group = ['meeting', 'review', 'parallel'].includes(source);
  async function load() {
    if (source === 'lead') {
      const result = await api<{ spec: WorkflowSpec; preview: Preview }>('plans/generate', 'POST', {
        goal,
        agentId: agent,
        approved: true,
        ...(cli && { inspectionId: inspection?.inspectionId, confirmUnmanaged: unmanaged }),
      });
      edit(JSON.stringify(result.spec, null, 2));
      setPreview(result.preview);
    } else {
      const spec =
        source === 'demo'
          ? await api<WorkflowSpec>('templates/demo')
          : await api<WorkflowSpec>('templates/' + source, 'POST', { goal, members });
      edit(JSON.stringify(spec, null, 2));
    }
  }
  return (
    <>
      <header className="page-title">
        <div>
          <h1>计划与审批</h1>
          <p>检查目标、输入依赖和调用预算，再把计划应用到任务板。</p>
        </div>
      </header>
      <Notice error={action.error || catalog.error} message={action.message} />
      <section className="panel">
        <h2>生成计划草案</h2>
        <div className="toolbar">
          <select
            aria-label="草案来源"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              edit('');
            }}
          >
            <option value="demo">固定示范 · 按负责人筛选</option>
            <option value="meeting">成员会议</option>
            <option value="parallel">并行比较</option>
            <option value="review">成员审查</option>
            <option value="lead">负责人生成计划</option>
            <option value="manual">手工编写</option>
          </select>
        </div>
        {(source === 'lead' || group) && (
          <Field name="goal" label="工作目标">
            <textarea
              id="goal"
              value={goal}
              onChange={(e) => {
                setGoal(e.target.value);
                setPreview(undefined);
              }}
            />
          </Field>
        )}
        {group && (
          <>
            <p className="help">
              {source === 'meeting'
                ? '按发言顺序选择成员，首位成员负责总结。'
                : source === 'parallel'
                  ? '首位成员比较各方结果，随后选择并行执行的成员。'
                  : '首位成员产出成果，随后至少选择一名审查人。'}
            </p>
            {enabled.map((m) => (
              <label key={m.id} className="check">
                <input
                  type="checkbox"
                  checked={members.includes(m.id)}
                  onChange={(e) =>
                    setMembers(e.target.checked ? [...members, m.id] : members.filter((id) => id !== m.id))
                  }
                />
                {m.name} {members.includes(m.id) && '· 第 ' + (members.indexOf(m.id) + 1) + ' 位'}
              </label>
            ))}
          </>
        )}
        {source === 'lead' && (
          <>
            <Field name="lead" label="生成计划的岗位">
              <select
                id="lead"
                value={agent}
                onChange={(e) => {
                  setAgent(e.target.value);
                  setPreview(undefined);
                  setInspection(undefined);
                  setUnmanaged(false);
                }}
              >
                <option value="">选择已启用成员</option>
                {enabled.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.role}
                  </option>
                ))}
              </select>
            </Field>
            <p className="help">
              {cli
                ? '启动一次负责人 CLI，内部可能多次调用模型并计费。'
                : '生成草案会调用所选岗位的模型，可能产生费用。'}
            </p>
          </>
        )}
        {source === 'lead' && cli && (
          <>
            <p className="help">
              {connection.name} · {member?.name}
            </p>
            {connection.kind === 'claude' && (
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
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  setInspection(
                    await api('members/' + encodeURIComponent(agent) + '/inspect', 'POST', {
                      confirmUnmanaged: unmanaged,
                    }),
                  );
                })
              }
            >
              预检负责人 CLI
            </button>
            {inspection && (
              <p>
                版本 {inspection.version} · {inspection.login} · 计费来源 {inspection.billing}
              </p>
            )}
          </>
        )}
        {source !== 'manual' && (
          <div className="toolbar">
            <button
              disabled={
                action.busy ||
                (source === 'lead' &&
                  (!agent ||
                    !goal.trim() ||
                    (cli && !inspection) ||
                    (connection?.kind === 'claude' && !unmanaged))) ||
                (group && (members.length < (source === 'meeting' ? 1 : 2) || !goal.trim()))
              }
              onClick={() => void action.run(load)}
            >
              {source === 'lead' ? '批准模型调用并生成草案' : '载入模板'}
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>工作流 spec</h2>
        <label className="sr-only" htmlFor="draft">
          工作流 JSON 草案
        </label>
        <textarea
          id="draft"
          className="code-input"
          rows={12}
          value={draft}
          onChange={(e) => edit(e.target.value)}
          placeholder="载入模板或粘贴工作流 JSON"
          spellCheck={false}
        />
        <button
          disabled={action.busy || !draft.trim()}
          onClick={() =>
            void action.run(async () => {
              setPreview(undefined);
              let spec: unknown;
              try {
                spec = JSON.parse(draft);
              } catch {
                throw new Error('草案 JSON 语法有误。');
              }
              setPreview(await api<Preview>('spec/preview', 'POST', { spec }));
            })
          }
        >
          校验并预览差异
        </button>
      </section>
      {preview && (
        <section className="panel">
          <div className="section-head flush">
            <h2>{preview.spec.title}</h2>
            <span>基于修订 {preview.revision}</span>
          </div>
          <p>{preview.spec.goal}</p>
          <p className="muted">
            调用上限 {preview.spec.maxCalls} · {preview.spec.tasks.length} 项任务 ·{' '}
            {preview.spec.agents.length} 位成员
          </p>
          <ul>
            {preview.spec.acceptance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="diff-grid">
            {(['added', 'changed', 'removed'] as const).map((key) => (
              <div key={key}>
                <strong>
                  {{ added: '新增', changed: '改动', removed: '移除' }[key]} {preview[key].length}
                </strong>
                <ul>
                  {preview[key].map((id) => (
                    <li key={id}>{preview.spec.tasks.find((t) => t.id === id)?.title ?? id}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api('spec/apply', 'POST', {
                  spec: preview.spec,
                  expectedRevision: preview.revision,
                  approved: true,
                });
                openBoard();
              })
            }
          >
            批准并应用此版本
          </button>
        </section>
      )}
    </>
  );
}
