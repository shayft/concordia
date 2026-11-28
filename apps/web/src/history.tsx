import type { ExecutionCost } from '@concordia/protocol/pricing';
import { useEffect } from 'react';
import { api, browserFetch, useAction, useResource } from './api.ts';
import { Empty, Notice } from './ui.tsx';

import { useHistoryFeed } from './history-feed.ts';

export function HistoryPage({ events }: { events: number }) {
  const download = useAction();
  const { data, error, loading, historic, hasOlder, load } = useHistoryFeed(events);
  const check = useAction();
  const recovery = useResource<{ recovered: unknown; unresolved: unknown[] }>('recovery');
  const {
    data: costs,
    error: costError,
    reload: reloadCosts,
  } = useResource<ExecutionCost[]>('execution-costs');
  useEffect(() => {
    if (events) void reloadCosts();
  }, [events, reloadCosts]);
  return (
    <>
      <header className="page-title">
        <div>
          <h1>活动记录</h1>
          <p>按事件序号查看执行、交付与状态变化。</p>
        </div>
        <div className="actions">
          <button onClick={() => void Promise.all([load('latest'), reloadCosts(), recovery.reload()])}>
            刷新
          </button>
          <button className="download" disabled={download.busy} onClick={() => void download.run(async () => {
            const response = await browserFetch('/api/export/audit');
            if (!response.ok) throw new Error('无法下载审计摘要。');
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = 'concordia-audit.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })}>下载脱敏审计摘要</button>
        </div>
      </header>
      <Notice error={error || costError || recovery.error || download.error} />
      {Boolean(recovery.data?.unresolved.length) && (
        <div className="notice error">
          有 {recovery.data?.unresolved.length} 个历史进程待人工核对，真实执行暂时受限。
          <button disabled={check.busy} onClick={()=>void check.run(async()=>{
            await api('recovery/recheck','POST',{});
            await recovery.reload();
          },'已重新核对进程记录。')}>重新核对进程</button>
        </div>
      )}
      <Notice error={check.error} message={check.message} />
      <section className="surface">
        <div className="section-head">
          <h2>执行成本</h2>
          <span>按执行时单价估算</span>
        </div>
        {costs
          ?.slice()
          .reverse()
          .map((row) => (
            <details key={row.id} className="event">
              <summary>
                任务 {row.taskId} · {row.modelId ?? '未知模型'}{' '}
                <strong>
                  {row.amount === null || !row.pricing
                    ? '未知'
                    : row.amount.toLocaleString('zh-CN', { maximumSignificantDigits: 12 }) +
                      ' ' +
                      row.pricing.currency}
                </strong>
              </summary>
              <dl className="meta">
                <dt>执行</dt>
                <dd>{row.id}</dd>
                <dt>连接</dt>
                <dd>{row.connection}</dd>
                <dt>开始时间</dt>
                <dd>{new Date(row.started).toLocaleString()}</dd>
                <dt>输入 / 输出 token</dt>
                <dd>
                  {row.inputTokens ?? '未知'} / {row.outputTokens ?? '未知'}
                </dd>
                <dt>每百万输入 / 输出 token 单价</dt>
                <dd>
                  {row.pricing?.inputPerMillion ?? '未知'} / {row.pricing?.outputPerMillion ?? '未知'}{' '}
                  {row.pricing?.currency}
                </dd>
              </dl>
            </details>
          ))}
        {costs && !costs.length && <Empty>此工作区尚无执行。</Empty>}
      </section>
      <section className="surface">
        <div className="section-head">
          <h2>工作区事件</h2>
          <span>{historic ? '历史页' : '最新记录'} · {data?.length ?? '—'} 项</span>
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
        <div className="toolbar">
          {hasOlder && <button disabled={loading} onClick={()=>void load('older')}>更早的记录</button>}
          {historic && <button disabled={loading} onClick={()=>void load('latest')}>返回最新记录</button>}
        </div>
      </section>
    </>
  );
}
