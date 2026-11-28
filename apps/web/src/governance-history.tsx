import { useState } from 'react';
import { useResource } from './api.ts';
import { Empty, Notice } from './ui.tsx';

interface Decision {
  seq: number; id: string; created: number; session: string; action: string;
  details: object; calls: { status: string; outcome?: string; count: number }[];
  executions: { execution: string; status: string }[]; plans: { id: string; status: string }[];
}
export function GovernanceHistory() {
  const [before, setBefore] = useState<number>();
  const page = useResource<{ items: Decision[]; next: number | null }>('governance' + (before ? '?before=' + before : ''));
  return <section className="surface">
    <div className="section-head"><h2>批准与策略变更</h2>
      <button onClick={() => before ? setBefore(undefined) : void page.reload()}>查看最新记录</button></div>
    <p>包含当前工作区的模型调用批准和全局配置变更。会话编号用于关联同一次服务运行。下载的脱敏摘要另行生成。</p>
    <Notice error={page.error} />
    {page.data?.items.map(row => <details className="event" key={row.id}>
      <summary>#{row.seq} {row.action} · {new Date(row.created).toLocaleString()}</summary>
      <dl className="meta"><dt>服务会话</dt><dd>{row.session}</dd><dt>决定编号</dt><dd>{row.id}</dd>
        <dt>关联调用</dt><dd>{row.calls.map(c => [c.status,c.outcome].filter(Boolean).join(' / ') + ' × ' + c.count).join('，') || '无'}</dd>
        <dt>执行和规划</dt><dd>{[...row.executions.map(e => [e.execution,e.status]), ...row.plans.map(p => [p.id,p.status])]
          .map(([id,status]) => id + ' · ' + status).join('，') || '无'}</dd></dl>
      <pre>{JSON.stringify(row.details, null, 2)}</pre>
    </details>)}
    {page.data?.items.length === 0 && <Empty>此页暂无批准或策略变更。</Empty>}
    {page.data?.next && <button onClick={() => setBefore(page.data?.next ?? undefined)}>更早的策略记录</button>}
  </section>;
}
