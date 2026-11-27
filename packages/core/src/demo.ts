import { demoSpec, Scheduler } from './workflow.ts';

/** Deterministic delivery rehearsal. The simulator never obtains runtime or credential dependencies. */
export function runDemo(scheduler: Scheduler) {
  const spec = demoSpec();
  const board = scheduler.board();
  if (!board.spec) scheduler.apply(spec);
  else if (JSON.stringify(board.spec) !== JSON.stringify(spec) || board.executions.length)
    throw new Error('演示需要尚未执行的标准模拟计划');
  const publish = (execution: string, slotId: string, content: string) =>
    scheduler.act(execution, { type: 'publish_artifact', slotId, content });
  const complete = (execution: string, taskId: string) => {
    scheduler.act(execution, { type: 'submit_result', summary: '模拟交付完成' });
    scheduler.control(taskId, 'accept');
  };
  const api = scheduler.claim('api');
  publish(api.id, 'contract', 'GET /tasks?assignee=…；未分配使用 unassigned，清除筛选时省略参数。');
  const ui = scheduler.claim('ui'),
    qa = scheduler.claim('tests');
  scheduler.act(ui.id, { type: 'progress', message: '开始实现筛选控件' });
  const q = scheduler.act(ui.id, {
    type: 'ask_question',
    to: 'backend',
    question: '清空参数时返回全部吗？',
    blocking: true,
  }) as { id: string };
  scheduler.act(api.id, {
    type: 'answer_question',
    questionId: q.id,
    answer: '是，省略 assignee 返回全部。',
  });
  publish(qa.id, 'cases', '覆盖指定成员、未分配、清除筛选。');
  complete(qa.id, 'tests');
  publish(ui.id, 'frontend-code', '模拟控件实现（文本夹具）');
  complete(ui.id, 'ui');
  publish(api.id, 'backend-code', '模拟接口实现（文本夹具）');
  complete(api.id, 'api');
  const integrated = scheduler.claim('integrate');
  publish(integrated.id, 'integration', '模拟版本快照联调，三个验收条件符合脚本预期。');
  complete(integrated.id, 'integrate');
  const review = scheduler.claim('accept');
  complete(review.id, 'accept');
  scheduler.accept();
  return scheduler.board();
}
