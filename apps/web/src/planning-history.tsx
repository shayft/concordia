import { useEffect } from 'react';
import type { PlanningRequest } from '@concordia/protocol/planning';
import type { PlanPreview, WorkflowSpec } from '@concordia/protocol/workflow';
import { api, useAction, useResource } from './api.ts';
import { Notice } from './ui.tsx';

export type PlanningResult = { spec: WorkflowSpec; preview: PlanPreview | null };
const statusLabels = { running: '生成中', proposed: '草案待查看', cancelled: '已取消', failed: '生成失败', interrupted: '服务中断' };
const phaseLabels = { preparing: '准备调用', sent: '等待模型返回', receiving: '接收回复', finished: '已结束' };

export function PlanningHistory({ workspace, refreshKey, onLoad }: {
  workspace: string; refreshKey: number; onLoad(result: PlanningResult): void;
}) {
  const path = 'workspaces/' + encodeURIComponent(workspace) + '/plan-requests';
  const { data, error, reload } = useResource<PlanningRequest[]>(path);
  const action = useAction();
  useEffect(() => {
    if (refreshKey) void reload();
  }, [refreshKey, reload]);
  useEffect(() => {
    const onFocus = () => void reload();
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, 2500);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [reload]);
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length && !error) return null;
  return <section className="panel" aria-label="规划请求">
    <h2>规划请求</h2>
    <Notice error={error || action.error}/>
    {rows.map((row) => <article key={row.id}>
      <p><strong>{row.member} · {statusLabels[row.status]}</strong> · {new Date(row.started).toLocaleString()}</p>
      <p>{row.status === 'running' && phaseLabels[row.phase] + ' · '}已记录回复 {row.progressBytes} 字节
        {row.memberIds.length > 0 && ' · 参与岗位 ' + row.memberIds.join('、')}</p>
      {row.status === 'running' && <button disabled={action.busy} onClick={() => void action.run(async () => {
        await api(path + '/' + encodeURIComponent(row.id) + '/cancel', 'POST', {});
        await reload();
      })}>取消本次规划</button>}
      {row.hasResult && <button disabled={action.busy} onClick={() => void action.run(async () => {
        const result = await api<PlanningResult>(path + '/' + encodeURIComponent(row.id) + '/result');
        onLoad(result);
      })}>载入生成草案</button>}
    </article>)}
  </section>;
}
