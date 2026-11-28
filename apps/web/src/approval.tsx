import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Notice } from './ui.tsx';

type Route = { connection: string; protocol: string; member?: string; destination: string; model: string; credentials: string[]; permissions: string; pool: string; individual?: boolean; outputLimit?: {field: string; tokens: number} };
interface Preview { stamp: string; routes: Route[]; simulated?: string[]; revision: number }
interface Selection { purpose: 'task' | 'dispatch' | 'plan' | 'connection-test' | 'member-test'; id?: string; modelId?: string; projectId?: string; treeId?: string }

export function useApproval(selection?: Selection) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(selection ?? {})) if (value) query.set(key, value);
  const path = selection ? 'approval-route?' + query : '';
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; preview?: Preview; error?: string }>();
  const key = path + ':' + attempt;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api<Preview>(path, 'GET', undefined, controller.signal).then(
      (preview) => { if (!controller.signal.aborted) setLoaded({ key, preview }); },
      (error: unknown) => { if (!controller.signal.aborted) setLoaded({ key, error: error instanceof Error ? error.message : '无法读取调用信息。' }); },
    );
    return () => controller.abort();
  }, [path, key]);
  return { ...(loaded?.key === key ? loaded : {}), reload: () => setAttempt((n) => n + 1) };
}
export function ApprovalDetails({ approval }: { approval: ReturnType<typeof useApproval> }) {
  return <section className="surface compact">
    <strong>本次调用使用的配置</strong>
    {approval.preview?.routes.map((route, i) => <p key={i}>
      {route.member && route.member + ' · '}{route.connection} · {route.protocol} · {route.model}<br/>
      {route.individual && 'CLI 须逐卡批准 · '}{route.destination} · {route.permissions} · 额度池 {route.pool}
      {route.outputLimit && <><br/>输出上限 {route.outputLimit.field} = {route.outputLimit.tokens}</>}
      {route.credentials.length > 0 && <><br/>凭据引用 {route.credentials.join('、')}</>}
    </p>)}
    {!!approval.preview?.simulated?.length && <p>模拟成员 {approval.preview.simulated.join('、')}</p>}
    {approval.preview && <p>计划修订 {approval.preview.revision}</p>}
    <Notice error={approval.error}/>
    <button type="button" onClick={approval.reload}>刷新调用信息</button>
  </section>;
}
