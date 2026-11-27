import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogPage } from '../src/catalog.tsx';
import { PlansPage } from '../src/plans.tsx';
import { Delivery } from '../src/delivery.tsx';

let dom: Window;
let root: Root;
let container: HTMLDivElement;
let requests: { path: string; method: string; body: unknown }[];
let serve: (path: string, body: unknown) => unknown;
beforeEach(async () => {
  dom = new Window({ url: 'http://127.0.0.1:4411/' });
  vi.stubGlobal('window', dom);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('FormData', dom.FormData);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = (await import('react-dom/client')).createRoot(container);
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ path, method: options.method ?? 'GET', body });
      return Response.json(serve(path, body));
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  vi.unstubAllGlobals();
});
async function render(content: ReactNode) {
  await act(async () => root.render(content));
}
function button(label: string) {
  const b = [...container.querySelectorAll('button')].find((el) => el.textContent.trim() === label);
  if (!b) throw new Error('未找到按钮 ' + label);
  return b;
}
async function click(el: HTMLElement) {
  await act(async () => el.click());
}

it('CLI 连接先预检，再按批准请求调用一次，切换模型后清空预检', async () => {
  const catalog = {
    connections: [{ id: 'code', name: '本地 Codex', kind: 'codex', enabled: true }],
    models: [
      { id: 'specific', name: '选择的模型', connectionId: 'code', modelId: 'custom', enabled: true },
    ],
    members: [],
    pools: [],
  };
  serve = (path) =>
    path === '/api/catalog'
      ? catalog
      : path.endsWith('inspect')
        ? { inspectionId: 'inspection-1', login: '已登录', billing: '未知', version: '1.0' }
        : { ok: true, text: 'CONCORDIA_OK' };
  await render(<CatalogPage />);
  await click(button('验证'));
  expect(button('批准一次真实调用').disabled).toBe(true);
  await click(button('预检路径、版本和登录状态'));
  expect(requests.some((r) => r.path.endsWith('/test'))).toBe(false);
  await click(button('批准一次真实调用'));
  expect(requests.filter((r) => r.path.endsWith('/test'))).toEqual([
    {
      path: '/api/connections/code/test',
      method: 'POST',
      body: { approved: true, inspectionId: 'inspection-1', confirmUnmanaged: false },
    },
  ]);
  const model = container.querySelector<HTMLSelectElement>('#testModel')!;
  await act(async () => {
    model.value = 'specific';
    model.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  expect(button('批准一次真实调用').disabled).toBe(true);
});

it('修改计划只产生带预览修订号的显式批准', async () => {
  const spec = {
    id: 'demo',
    title: '演示',
    goal: '交付',
    maxCalls: 5,
    tasks: [{ id: 'a', title: '交付 API' }],
    agents: [{ id: 'me' }],
    acceptance: ['完成联调'],
  };
  const openBoard = vi.fn();
  serve = (path) =>
    path === '/api/catalog'
      ? { connections: [], models: [], members: [], pools: [] }
      : path.endsWith('/demo')
        ? spec
        : path.endsWith('/preview')
          ? { spec, revision: 3, added: ['a'], removed: [], changed: [] }
          : {};
  await render(<PlansPage openBoard={openBoard} />);
  await click(button('载入模板'));
  await click(button('校验并预览差异'));
  expect(requests.some((r) => r.path.endsWith('/apply'))).toBe(false);
  expect(container.textContent).toContain('基于修订 3');
  await click(button('批准并应用此版本'));
  expect(requests.at(-1)?.body).toEqual({ spec, expectedRevision: 3, approved: true });
  expect(openBoard).toHaveBeenCalledOnce();
});

it('交付演练呈现命令和 diff 并分别绑定审批票据', async () => {
  let state: Record<string, unknown> = {
    phase: 'approve-test',
    command: { id: 'command-1', sha: 'a', executable: '/test/node', args: ['--test'] },
  };
  serve = (path) => {
    if (path.endsWith('/test'))
      state = {
        phase: 'review-merge',
        review: { id: 'merge-1', targetSha: 'a', sha: 'b', diff: '+ one checked change' },
      };
    if (path.endsWith('/merge')) state = { phase: 'merged' };
    return state;
  };
  await render(<Delivery />);
  expect(container.textContent).toContain('--test');
  await click(button('批准运行此测试命令'));
  expect(container.textContent).toContain('+ one checked change');
  expect(requests.filter((r) => r.path.endsWith('/merge'))).toHaveLength(0);
  await click(button('批准合并此版本'));
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
    { approved: true, approvalId: 'command-1' },
    { approved: true, approvalId: 'merge-1' },
  ]);
});
