import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, setActiveWorkspace, useAction, useResource } from './api.ts';
import { subscribeEvents } from './events.ts';
import { CatalogPage } from './catalog.tsx';
import { BoardPage } from './board.tsx';
import { PlansPage } from './plans.tsx';
import { BudgetsPage } from './budgets.tsx';
import { HistoryPage } from './history.tsx';
import { WorktreesPage } from './worktrees.tsx';
import { Field, Modal, Notice } from './ui.tsx';
import './style.css';

const pages = {
  connections: ['⌘', '连接与成员'],
  board: ['▦', '协作任务板'],
  plans: ['≡', '计划与审批'],
  worktrees: ['⑂', '代码与联调'],
  budgets: ['∑', '调用预算'],
  history: ['◷', '活动记录'],
};
type Page = keyof typeof pages;
function current(): Page {
  const key = location.hash.slice(1);
  return Object.hasOwn(pages, key) ? (key as Page) : 'connections';
}
function Workspace({ data, refresh }: { data?: WorkspaceList; refresh: () => Promise<void> }) {
  const [page, setPage] = useState<Page>(current);
  const [online, setOnline] = useState(false);
  const [events, setEvents] = useState(0);
  const content = useRef<HTMLElement>(null);
  const previousPage = useRef(page);
  function focusContent() {
    const target = content.current?.querySelector('h1') ?? content.current;
    if (target) {
      target.tabIndex = -1;
      target.focus();
    }
  }
  useEffect(() => {
    document.title = pages[page][1] + ' · Concordia';
    if (previousPage.current !== page) focusContent();
    previousPage.current = page;
  }, [page]);
  useEffect(() => {
    const onHash = () => setPage(current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!data?.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        setEvents((n) => n + 1);
      }, 90);
    };
    const close = subscribeEvents(
      () => {
        setOnline(true);
        void refresh();
        notify();
      },
      notify,
      () => setOnline(false),
    );
    return () => {
      close();
      clearTimeout(timer);
    };
  }, [data?.active, refresh]);
  return (
    <div className="shell">
      <a
        className="skip-navigation"
        href="#workspace-content"
        onClick={(event) => {
          event.preventDefault();
          focusContent();
        }}
      >
        跳到当前页面内容
      </a>
      <aside>
        <a className="brand" href="#connections">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          Concordia
        </a>
        <nav aria-label="工作区导航">
          {(Object.keys(pages) as Page[]).map((key) => (
            <a key={key} href={'#' + key} aria-current={page === key ? 'page' : undefined}>
              <span aria-hidden="true">{pages[key][0]}</span>
              {pages[key][1]}
            </a>
          ))}
        </nav>
        <div className="rail-foot" aria-live="polite">
          <i className={'dot ' + (online ? 'connected' : '')} />
          {online ? '实时更新已连接' : '正在连接实时更新'}
        </div>
      </aside>
      <main>
        <div className="topbar">
          <div className="crumb">
            工作区 <span>/</span> {pages[page][1]}
          </div>
          <WorkspaceMenu data={data} refresh={refresh} />
        </div>
        <section ref={content} id="workspace-content" aria-label={pages[page][1]}>
          {page === 'connections' ? (
            <CatalogPage />
          ) : page === 'board' ? (
            <BoardPage
              events={events}
              openPlans={() => {
                location.hash = 'plans';
              }}
            />
          ) : page === 'plans' ? (
            data ? (
              <PlansPage
                workspace={data.active}
                openBoard={() => {
                  location.hash = 'board';
                }}
              />
            ) : (
              <p role="status">正在打开工作区…</p>
            )
          ) : page === 'worktrees' ? (
            <WorktreesPage />
          ) : page === 'budgets' ? (
            <BudgetsPage workspace={data?.workspaces.find((w) => w.id === data.active)} events={events} />
          ) : (
            <HistoryPage events={events} />
          )}
        </section>
      </main>
    </div>
  );
}
type WorkspaceList = { active: string; generation: string; workspaces: { id: string; name: string }[] };
function WorkspaceMenu({ data, refresh }: { data?: WorkspaceList; refresh: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const action = useAction();
  return (
    <div>
      <div className="toolbar workspace-menu">
        <label className="sr-only" htmlFor="workspace">
          当前工作区
        </label>
        <select
          id="workspace"
          disabled={action.busy || !data}
          value={data?.active ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            void action.run(async () => {
              const now = await api<WorkspaceList>('workspaces');
              if (now.active !== data?.active) {
                await refresh();
                throw new Error('其他窗口已切换工作区，请重新选择。');
              }
              await api('workspaces/' + encodeURIComponent(id) + '/select', 'POST', {});
              await refresh();
            });
          }}
        >
          {data?.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button onClick={() => setAdding(true)}>新工作区</button>
      </div>
      <Notice error={!adding ? action.error : ''} />
      {adding && (
        <Modal title="创建工作区" onClose={() => setAdding(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await api('workspaces', 'POST', { name: name.trim() });
                await refresh();
                setAdding(false);
              });
            }}
          >
            <Field name="workspaceName" label="工作区名称">
              <input
                id="workspaceName"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Notice error={action.error} />
            <div className="modal-actions">
              <button type="button" onClick={() => setAdding(false)}>
                取消
              </button>
              <button className="primary" disabled={action.busy || !name.trim()}>
                创建并切换
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function App() {
  const { data, error, reload } = useResource<WorkspaceList>('workspaces');
  useEffect(() => {
    setActiveWorkspace(data?.active, data?.generation);
  }, [data?.active, data?.generation]);
  if (!data && error)
    return (
      <main>
        <h1>工作区暂时无法打开</h1>
        <Notice error={error} />
        <button onClick={() => void reload()}>重试打开工作区</button>
      </main>
    );
  return <Workspace key={data?.generation ?? 'loading'} data={data} refresh={reload} />;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
