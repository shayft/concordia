import { useEffect } from 'react';
import { useResource } from './api.ts';
import { Empty, Notice } from './ui.tsx';

interface EventRecord {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}
export function HistoryPage({ events }: { events: number }) {
  const { data, error, reload } = useResource<EventRecord[]>('history');
  const recovery = useResource<{ recovered: unknown; unresolved: unknown[] }>('recovery');
  useEffect(() => {
    if (events) void reload();
  }, [events, reload]);
  return (
    <>
      <header className="page-title">
        <div>
          <h1>活动记录</h1>
          <p>按事件序号查看执行、交付与状态变化。</p>
        </div>
        <div className="actions">
          <button onClick={() => void reload()}>刷新</button>
          <a className="download" href="/api/export/audit" download="concordia-audit.json">
            下载脱敏审计摘要
          </a>
        </div>
      </header>
      <Notice error={error || recovery.error} />
      {Boolean(recovery.data?.unresolved.length) && (
        <div className="notice error">
          有 {recovery.data?.unresolved.length} 个历史进程待人工核对，真实执行暂时受限。
        </div>
      )}
      <section className="surface">
        <div className="section-head">
          <h2>工作区事件</h2>
          <span>{data?.length ?? '—'} 项</span>
        </div>
        {data
          ?.slice()
          .reverse()
          .map((e) => (
            <details key={e.seq} className="event">
              <summary>
                <span>#{e.seq}</span> {e.type}{' '}
                <small>{typeof e.data.time === 'number' && new Date(e.data.time).toLocaleString()}</small>
              </summary>
              <pre>{JSON.stringify(e.data, null, 2)}</pre>
            </details>
          ))}
        {data && !data.length && <Empty>此工作区尚无事件。</Empty>}
      </section>
    </>
  );
}
