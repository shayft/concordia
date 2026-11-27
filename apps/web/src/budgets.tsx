import { useEffect, useState, type FormEvent } from 'react';
import type { BudgetLimit, BudgetReport, BudgetScope } from '@concordia/protocol/budgets';
import type { Catalog } from '@concordia/protocol/connections';
import { api, useAction, useResource } from './api.ts';
import { Empty, Field, Modal, Notice } from './ui.tsx';

const scopes: Record<BudgetScope, string> = {
  global: '全局',
  workspace: '工作区',
  member: '岗位',
  connection: '连接',
  pool: '额度池',
};
const labels = { maxCalls: '累计调用上限', maxTokens: '累计 token 上限', maxConcurrent: '并发上限' };
type Key = keyof typeof labels;
type Target = { id: string; name: string };
type Workspace = { id: string; name: string };

function targets(scope: BudgetScope, catalog: Catalog | undefined, workspace?: Workspace): Target[] {
  switch (scope) {
    case 'global':
      return [{ id: 'all', name: '全部工作区' }];
    case 'workspace':
      return workspace ? [workspace] : [];
    case 'connection':
      return catalog?.connections ?? [];
    case 'member':
      return catalog?.members ?? [];
    case 'pool':
      return catalog
        ? [
            ...catalog.pools,
            ...catalog.connections
              .filter((c) => !c.poolId)
              .map((c) => ({ id: 'connection:' + c.id, name: c.name + '（独享）' })),
          ]
        : [];
  }
}

export function BudgetsPage({ workspace, events }: { workspace?: Workspace; events: number }) {
  const catalog = useResource<Catalog>('catalog');
  const { data: report, reload, error } = useResource<BudgetReport>('budgets');
  const [scope, setScope] = useState<BudgetScope>('global');
  const [selected, setSelected] = useState<Target>();
  const [removing, setRemoving] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (events) void reload();
  }, [events, reload]);
  const entities = targets(scope, catalog.data, workspace);
  const limitFor = (id: string) => report?.limits.find((l) => l.scope === scope && l.id === id);
  const limit = selected && limitFor(selected.id);
  const path = selected ? 'budgets/' + scope + '/' + encodeURIComponent(selected.id) : '';
  function close() {
    setSelected(undefined);
    setRemoving(false);
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void action.run(async () => {
      const limits: Partial<Pick<BudgetLimit, Key>> = {};
      for (const key of Object.keys(labels) as Key[]) {
        const value = String(values.get(key) ?? '').trim();
        if (!value) continue;
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error(labels[key] + '须为正整数。');
        limits[key] = number;
      }
      if (!Object.keys(limits).length)
        throw new Error('请至少设置一项上限。已有上限可单独选择“移除全部限额”。');
      await api(path, 'PUT', limits);
      await reload();
      close();
    }, '预算上限已保存。');
  }
  return (
    <>
      <header className="page-title">
        <div>
          <h1>调用预算</h1>
          <p>按作用范围限制累计消耗和同时运行数，多层预算共同生效。</p>
        </div>
        <button onClick={() => void reload()}>刷新用量</button>
      </header>
      <nav className="tabs" aria-label="限额范围">
        {(Object.keys(scopes) as BudgetScope[]).map((k) => (
          <button key={k} aria-current={k === scope ? 'page' : undefined} onClick={() => setScope(k)}>
            {scopes[k]}
          </button>
        ))}
      </nav>
      <Notice
        error={error || catalog.error || (!selected ? action.error : '')}
        message={!selected ? action.message : ''}
      />
      <section className="surface">
        <div className="section-head">
          <h2>{scopes[scope]}预算</h2>
        </div>
        {entities.map((entry) => {
          const current = limitFor(entry.id),
            usage = report?.usage.find((u) => u.scope === scope && u.id === entry.id);
          return (
            <article key={entry.id} className="record">
              <div className="record-info">
                <h3>{entry.name}</h3>
                <p>{entry.id}</p>
                <div className="budget-counters">
                  <span>
                    调用 <b>{report ? (usage?.calls ?? 0) : '—'}</b> / {report ? (current?.maxCalls ?? '不限') : '—'}
                  </span>
                  <span>
                    token <b>{report ? (usage?.tokens ?? 0) : '—'}</b> / {report ? (current?.maxTokens ?? '不限') : '—'}
                  </span>
                  <span>
                    在途 <b>{report ? (usage?.active ?? 0) : '—'}</b> / {report ? (current?.maxConcurrent ?? '不限') : '—'}
                  </span>
                </div>
              </div>
              <button
                disabled={!report}
                onClick={() => {
                  setSelected(entry);
                  setRemoving(false);
                }}
              >
                设置上限
              </button>
            </article>
          );
        })}
        {!entities.length && <Empty>此范围尚无可配置的对象。</Empty>}
      </section>
      <p className="help">
        API 按实际发出的请求计次，CLI 按启动次数计次。token 包含输入与输出；供应方未返回用量时保留估计值。
      </p>
      {selected && (
        <Modal
          title={scopes[scope] + '预算 · ' + selected.name}
          onClose={() => {
            if (!action.busy) close();
          }}
        >
          <form onSubmit={save}>
            <fieldset disabled={action.busy}>
              <div className="form-grid">
                {(Object.keys(labels) as Key[]).map((key) => (
                  <Field key={key} name={key} label={labels[key]}>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      id={key}
                      name={key}
                      defaultValue={limit?.[key]}
                      placeholder="当前范围不限"
                    />
                  </Field>
                ))}
              </div>
              <Notice error={action.error} />
              <div className="modal-actions">
                <button type="button" onClick={close}>
                  取消
                </button>
                <button className="primary">保存上限</button>
              </div>
            </fieldset>
          </form>
          {limit && (
            <div className="toolbar">
              <button
                type="button"
                className="danger"
                disabled={action.busy}
                onClick={() => {
                  if (!removing) {
                    setRemoving(true);
                    return;
                  }
                  void action.run(async () => {
                    await api(path, 'DELETE');
                    await reload();
                    close();
                  }, '已移除此范围的限额，累计用量已保留。');
                }}
              >
                {removing ? '确认移除，此范围累计用量将保留' : '移除全部限额'}
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
