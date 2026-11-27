import { useEffect } from 'react';
import { api, useAction, useResource } from './api.ts';
import { Notice } from './ui.tsx';

const phases = {
  idle: '尚未开始',
  building: '生成成员提交',
  'approve-test': '等待测试审批',
  testing: '测试运行中',
  'review-merge': '等待差异审查',
  merging: '合并中',
  merged: '已合并',
  'branch-only': '已交付分支',
  interrupted: '上次运行中断',
  failed: '执行失败',
};
interface DeliveryState {
  id?: string;
  phase: keyof typeof phases;
  repository?: string;
  branch?: string;
  reason?: string;
  snapshot?: unknown;
  result?: unknown;
  command?: { id: string; sha: string; executable: string; args: string[] };
  review?: { id: string; sha: string; targetSha: string; diff: string };
}
export function Delivery() {
  const { data, error, reload } = useResource<DeliveryState>('delivery');
  const action = useAction();
  useEffect(() => {
    if (!data || !['building', 'testing', 'merging'].includes(data.phase)) return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [data, reload]);
  const submit = (path: string, id?: string) =>
    void action.run(async () => {
      try {
        await api('delivery/' + path, 'POST', {
          approved: true,
          ...(id && (path === 'start' ? { retryOf: id } : { approvalId: id })),
        });
      } finally {
        await reload();
      }
    });
  return (
    <section className="panel">
      <div className="section-head flush">
        <h2>代码交付演练</h2>
        <span>{data && phases[data.phase]}</span>
      </div>
      <p className="help">
        模拟成员在平台专用演示仓库中写入真实 Git 提交。测试命令与目标分支合并分别审批。
      </p>
      <Notice error={error || action.error} />
      {data && ['idle', 'interrupted', 'failed', 'merged', 'branch-only'].includes(data.phase) && (
        <button className="primary" disabled={action.busy} onClick={() => submit('start', data.id)}>
          {data.phase === 'idle' ? '批准创建演示仓库并开始' : '批准创建新仓库重新演练'}
        </button>
      )}
      {data?.reason && <p>{data.reason}</p>}
      {data?.repository && (
        <p className="muted">
          {data.repository} {data.branch && ' · ' + data.branch}
        </p>
      )}
      {data?.snapshot != null && (
        <details>
          <summary>联调提交快照</summary>
          <pre>{JSON.stringify(data.snapshot, null, 2)}</pre>
        </details>
      )}
      {data?.phase === 'approve-test' && data.command && (
        <>
          <h3>联调测试命令</h3>
          <p>{data.command.sha}</p>
          <pre>{JSON.stringify([data.command.executable, ...data.command.args], null, 2)}</pre>
          <button disabled={action.busy} onClick={() => submit('test', data.command!.id)}>
            批准运行此测试命令
          </button>
        </>
      )}
      {data?.result != null && (
        <details>
          <summary>联调结果</summary>
          <pre>{JSON.stringify(data.result, null, 2)}</pre>
        </details>
      )}
      {data?.phase === 'review-merge' && data.review && (
        <>
          <h3>合并差异</h3>
          <p className="muted">
            {data.review.targetSha} → {data.review.sha}
          </p>
          <pre>{data.review.diff}</pre>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() => submit('merge', data.review!.id)}
          >
            批准合并此版本
          </button>
        </>
      )}
      {data?.phase !== 'idle' && (
        <button className="text-button" onClick={() => void reload()}>
          刷新状态
        </button>
      )}
    </section>
  );
}
