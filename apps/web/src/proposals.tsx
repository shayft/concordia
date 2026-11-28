import { useState } from 'react';
import type { Scheduler } from '../../../packages/core/src/workflow.ts';
import { api, useAction } from './api.ts';
import { Modal, Notice } from './ui.tsx';

type Preview = ReturnType<Scheduler['previewProposal']>;
const status = { pending: '待决定', approved: '已批准', rejected: '已拒绝' };
export function ProposalReview({ proposals, refresh }: {
  proposals: Preview['proposal'][]; refresh: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview>();
  const action = useAction();
  if (!proposals.length) return null;
  async function load(id: string) {
    setPreview(await api<Preview>('proposals/' + encodeURIComponent(id) + '/preview', 'POST', {}));
  }
  async function decide(decision: 'approved' | 'rejected') {
    if (!preview) return;
    await api('proposals/' + encodeURIComponent(preview.proposal.id) + '/decide', 'POST', {
      decision, expected: preview.stamp,
    });
    setPreview(undefined);
    await refresh();
  }
  const task = preview?.diff?.spec.tasks.find(t => t.id === preview.proposal.action.taskId);
  const previous = preview?.diff?.taskChanges.find(c => c.id === task?.id)?.before;
  return <section className="panel">
    <h2>分工提议</h2>
    {proposals.map(p => <div key={p.id}>
      <strong>{p.action.type === 'create_task' ? '新增' : '改派'} · {p.action.taskId}</strong>
      {' → '}{p.action.assignee}{' · '}{status[p.status]}{' '}
      {p.status === 'pending' && <button disabled={action.busy}
        onClick={() => void action.run(() => load(p.id))}>预览提议</button>}
    </div>)}
    <Notice error={action.error} />
    {preview && <Modal title="审阅分工提议" onClose={() => setPreview(undefined)}>
      <p>计划 {preview.stamp.planId} · 当前修订 {preview.stamp.revision} · 提出时修订 {preview.proposal.submittedRevision ?? '未知'}</p>
      <p>提议来源执行 {preview.proposal.executionId}</p>
      <p>{preview.proposal.action.type === 'create_task' ? preview.proposal.action.description : '改派任务'} · {preview.proposal.action.taskId}</p>
      {task && <div><p>{previous ? '负责人由 ' + previous.owner + ' 改为 ' : '负责人 '}{task.owner}</p>
        {previous && <p>{task.title} · 改派后根据当前依赖重新排队。</p>}
        <p>任务调用上限 {task.maxCalls} · 返工上限 {task.maxRework} · 重试上限 {task.maxRetries}</p>
        <p>{(preview.diff?.spec.requiredTasks?.includes(task.id) ||
          (!preview.diff?.spec.requiredTasks?.length && !preview.diff?.spec.requiredSlots?.length))
          ? '主卡验收要求完成此任务。' : '主卡按计划指定的必需交付物和任务验收。'}</p></div>}
      {preview.blocker && <p>{preview.blocker}</p>}
      {preview.queued && <p>当前有任务运行中。可在执行结束后刷新差异并决定。</p>}
      <Notice error={action.error} />
      <div className="modal-actions">
        <button disabled={action.busy} onClick={() => void action.run(() => load(preview.proposal.id))}>刷新差异</button>
        <button disabled={action.busy} onClick={() => void action.run(() => decide('rejected'))}>拒绝提议</button>
        <button className="primary" disabled={action.busy || !preview.diff || preview.queued}
          onClick={() => void action.run(() => decide('approved'))}>批准此项变更</button>
      </div>
    </Modal>}
  </section>;
}
