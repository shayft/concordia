import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Scheduler } from '@concordia/core/workflow';
import { openStore } from '@concordia/store';
import { WorkflowStore } from '@concordia/store/workflow';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from '../test/browser-session.ts';

const cardCount = 100,
  sampleCount = 40,
  priorEvents = 10_000;
function seed(path: string, rounds: number) {
  const db = openStore(path);
  try {
    const storage = new WorkflowStore(db),
      scheduler = new Scheduler({ storage, now: Date.now, nextId: randomUUID });
    const numbers = Array.from({ length: cardCount }, (_, i) => i);
    scheduler.apply({
      id: 'load',
      title: '受控负载',
      goal: '复核交付和交接',
      acceptance: ['收到必需文档'],
      maxCalls: 1000,
      agents: numbers.slice(0, 10).map((i) => ({ id: 'm' + i, name: '成员 ' + i, connection: 'mock-' + i })),
      slots: numbers.map((i) => ({ id: 'v' + i, title: '产出 ' + i })),
      requiredSlots: ['v99'],
      tasks: numbers.map((i) => ({
        id: 't' + i,
        title: '卡片 ' + i,
        owner: 'm' + (i % 10),
        produces: ['v' + i],
        maxRework: 5,
        consumes: i < 10 ? [] : [{ slotId: 'v' + (i - 10) }],
      })),
    });
    // Keep prior event history constant; build executions, dependencies, receipts and CAS through normal operations.
    storage.transaction((_, append) => {
      for (let i = 0; i < priorEvents; i++) append('task.progress', { taskId: 't' + (i % cardCount) });
    });
    for (let round = 0; round < rounds; round++) {
      for (const i of numbers) {
        const execution = scheduler.claim('t' + i);
        for (let version = 0; version < 2; version++)
          scheduler.act(
            execution.id,
            {
              type: 'publish_artifact',
              slotId: 'v' + i,
              content: '模拟正文 ' + [i, round, version].join(' / '),
            },
            'publish-' + version,
          );
        scheduler.act(
          execution.id,
          { type: 'send_message', to: 'm' + ((i + 1) % 10), message: '交接 ' + i + ' / ' + round },
          'message',
        );
        scheduler.act(execution.id, { type: 'submit_result', summary: '本轮完成' }, 'submit');
        scheduler.control('t' + i, 'rework', execution.id);
      }
    }
    const state = storage.read();
    return {
      cards: state.tasks.length,
      executions: state.executions.length,
      versions: state.versions.length,
      messages: state.messages.length,
      receipts: Object.keys(state.receipts).length,
      events: Number(db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get()!.n),
    };
  } finally {
    db.close();
  }
}
async function timed<T>(samples: number[], read: () => Promise<T>) {
  const start = performance.now(),
    result = await read();
  samples.push(performance.now() - start);
  return result;
}
function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: +sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(2),
    p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2),
  };
}
async function json<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  if (!response.ok) throw new Error('本机基准请求失败，HTTP ' + response.status);
  return response.json() as Promise<T>;
}

export async function measureWorkflowLoad(rounds: 1 | 3) {
  const directory = mkdtempSync(join(tmpdir(), 'concordia-http-load-')),
    data = join(directory, 'data');
  const file = join(data, 'boards', 'default', 'workspace.sqlite');
  let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), '<title>Load test</title>');
    app = await startLocalServer(directory, data);
    await app.close();
    app = undefined;
    const initial = seed(file, rounds);
    const expectedRuns = cardCount * rounds;
    if (
      initial.cards !== cardCount ||
      initial.executions !== expectedRuns ||
      initial.versions !== expectedRuns * 2 ||
      initial.messages !== expectedRuns ||
      initial.receipts !== expectedRuns * 4 ||
      initial.events <= priorEvents
    )
      throw new Error('受控历史存量与预期不符');
    app = await startLocalServer(directory, data);
    const browser = await browserSession(new URL(app.launchUrl));
    const scope = await json<{ active: string; generation: string }>(browser.get('/api/workspaces'));
    const post = (path: string, body: unknown) =>
      fetch(browser.origin + path, {
        method: 'POST',
        headers: {
          ...browser.headers,
          'content-type': 'application/json',
          'x-concordia-workspace': scope.active,
          'x-concordia-generation': scope.generation,
        },
        body: JSON.stringify(body),
      });
    const boardRead: number[] = [],
      historyRead: number[] = [],
      run: number[] = [],
      accept: number[] = [];
    const walBytes = () => statSync(file + '-wal', { throwIfNoEntry: false })?.size ?? 0;
    const startingWalBytes = walBytes();
    let maxObservedWalBytes = startingWalBytes;
    await json(browser.get('/api/board'));
    await json(browser.get('/api/history/page'));
    for (let i = 0; i < sampleCount; i++) {
      const taskId = 't' + i,
        url = '/api/tasks/' + taskId;
      const job = await timed(run, () =>
        json<{ executionId: string }>(post(url + '/run', { mode: 'simulation' })),
      );
      const board = await timed(boardRead, () =>
        json<ReturnType<Scheduler['board']>>(browser.get('/api/board')),
      );
      const card = board.tasks.find((t) => t.id === taskId);
      if (card?.reviewExecutionId !== job.executionId) throw new Error('模拟任务没有提交对应执行');
      await timed(accept, () =>
        json(post(url + '/control', { action: 'accept', expectedExecutionId: job.executionId })),
      );
      const history = await timed(historyRead, () =>
        json<{ events: unknown[] }>(browser.get('/api/history/page?limit=100')),
      );
      if (history.events.length !== 100) throw new Error('历史分页长度不符');
      maxObservedWalBytes = Math.max(maxObservedWalBytes, walBytes());
    }
    const final = await json<ReturnType<Scheduler['board']>>(browser.get('/api/board'));
    const acceptedCards = final.tasks.filter((t) => t.status === 'done').length;
    if (
      acceptedCards !== sampleCount ||
      final.executions.length !== initial.executions + sampleCount ||
      final.versions.length !== initial.versions + sampleCount ||
      final.messages.length !== initial.messages
    )
      throw new Error('采样执行与验收结果不符');
    return {
      rounds,
      sampleCount,
      initial,
      final: {
        executions: final.executions.length,
        versions: final.versions.length,
        messages: final.messages.length,
        acceptedCards,
      },
      run: percentiles(run),
      readBoard: percentiles(boardRead),
      accept: percentiles(accept),
      readHistory: percentiles(historyRead),
      dbBytes: statSync(file).size,
      startingWalBytes,
      maxObservedWalBytes,
      endingWalBytes: walBytes(),
    };
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
if (import.meta.main) {
  for (const rounds of [1, 3] as const) console.log(JSON.stringify(await measureWorkflowLoad(rounds)));
}
