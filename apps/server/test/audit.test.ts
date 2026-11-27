import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { emptyState, type State } from '@concordia/core/state';
import { auditEvent, serveAuditExport } from '../src/audit.ts';

it('事件记录仅显示事件序号、已知动作及允许的数值字段，旧自由文本与新增字段均不外发', () => {
  const privateNote = 'SYNTHETIC_PRIVATE_NOTE';
  const event = auditEvent({
    seq: 15,
    type: 'task.progress',
    data: {
      time: 6,
      revision: 2,
      message: privateNote,
      NEW_FIELD: privateNote,
      id: privateNote,
      taskId: privateNote,
      contextRef: privateNote,
      operation: privateNote,
      status: privateNote,
      input: privateNote,
      blocking: true,
    },
  });
  expect(event).toEqual({
    seq: 15,
    type: 'task.progress',
    data: { time: 6, revision: 2, blocking: true, operation: 'unknown', status: 'unknown' },
  });
  expect(auditEvent({ seq: 1, type: privateNote, data: {} }).type).toBe('event.other');
});

it('HTTP 审计下载在当前工作区使用序号，私有标记进入字段名、内容及未知类型均不出现在下载中', async () => {
  const privateNote = 'SYNTHETIC_PRIVATE_NOTE';
  const state = emptyState();
  state.tasks = [
    { id: privateNote, title: privateNote, owner: privateNote, status: 'review', retries: 0, rework: 1 },
  ] as State['tasks'];
  state.executions = [
    {
      id: privateNote,
      taskId: privateNote,
      owner: privateNote,
      connection: privateNote,
      pool: privateNote,
      inputs: { [privateNote]: privateNote },
      outputs: {},
      contextRef: privateNote,
      resultRef: privateNote,
      status: 'success',
      started: 20,
      ended: 35,
      calls: 1,
      usage: { input: 0 },
    },
  ];
  const app = Fastify({ logger: false });
  try {
    serveAuditExport(app, () => state);
    const response = await app.inject('/api/export/audit');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment; filename="concordia-audit.json"');
    expect(response.body).not.toContain(privateNote);
    expect(response.json().executions).toEqual([
      {
        execution: 1,
        task: 1,
        status: 'success',
        durationMs: 15,
        calls: 1,
        inputTokens: 0,
        outputTokens: null,
      },
    ]);
  } finally {
    await app.close();
  }
});
