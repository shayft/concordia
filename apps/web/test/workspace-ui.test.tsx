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
      const reply = await serve(path, body);
      return reply instanceof Response ? reply : Response.json(reply);
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
        ? {
            inspectionId: 'inspection-1',
            login: '已登录',
            billing: '未知',
            version: '1.0',
            disabledMcpServers: ['computer-use', 'node_repl'],
          }
        : { ok: true, text: 'CONCORDIA_OK' };
  await render(<CatalogPage />);
  await click(button('验证'));
  expect(button('批准一次真实调用').disabled).toBe(true);
  expect(container.textContent).not.toContain('停用本机 Codex 配置的 MCP 服务器');
  await click(button('预检路径、版本和登录状态'));
  expect(container.textContent).toContain('本次调用停用本机 Codex 配置的 MCP 服务器：computer-use、node_repl');
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
          ? { spec, revision: 3, added: ['a'], removed: [], changed: [], taskChanges: [], settings: [{ field: 'maxTokens', before: 100, after: null }] }
          : {};
  await render(<PlansPage openBoard={openBoard} />);
  await click(button('载入模板'));
  await click(button('校验并预览差异'));
  expect(requests.some((r) => r.path.endsWith('/apply'))).toBe(false);
  expect(container.textContent).toContain('基于修订 3');
  const budgetChange = [...container.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === '总 token 上限');
  expect(budgetChange?.textContent).toContain('当前100');
  expect(budgetChange?.textContent).toContain('草案未设置');
  await click(button('批准并应用此版本'));
  expect(requests.at(-1)?.body).toEqual({ spec, expectedRevision: 3, approved: true });
  expect(openBoard).toHaveBeenCalledOnce();
});

it('从界面载入旧计划和原预算，批准携带所选实例标识', async () => {
  const archived = {id:'meeting',title:'旧会议',goal:'核对',acceptance:['签字'],tasks:[],agents:[],maxCalls:3};
  serve = path => {
    if (path === '/api/catalog') return {connections:[],models:[],members:[],pools:[]};
    if (path === '/api/plans') return [{id:'meeting',title:'旧会议',active:false}];
    if (path === '/api/plans/meeting/spec') return archived;
    if (path === '/api/spec/preview') return {spec:archived,baselineId:'meeting',revision:8,added:[],removed:[],changed:[],taskChanges:[],settings:[]};
    return {};
  };
  await render(<PlansPage openBoard={() => {}} />);
  async function select(selector: string, value: string) {
    const el=container.querySelector<HTMLSelectElement>(selector)!;
    await act(async () => { el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true})); });
  }
  await select('[aria-label="草案来源"]','revise');
  await select('#revisionPlan','meeting');
  await click(button('载入修订版本'));
  expect(JSON.parse(container.querySelector<HTMLTextAreaElement>('#draft')!.value)).toEqual(archived);
  await click(button('校验并预览差异'));
  await click(button('批准并应用此版本'));
  expect(requests.at(-1)?.body).toMatchObject({revisionOf:'meeting',expectedRevision:8,spec:archived});
});

it('切换草案来源后，较早返回的预览不能恢复批准按钮', async () => {
  let finishPreview!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { finishPreview = resolve; });
  const spec = { title: '旧计划', goal: '旧目标', maxCalls: 3, tasks: [], agents: [], acceptance: [] };
  serve = (path) => {
    if (path.endsWith('/catalog')) return { connections: [], models: [], members: [], pools: [] };
    if (path.endsWith('/preview')) return pending;
    return spec;
  };
  await render(<PlansPage openBoard={() => {}} />);
  await click(button('载入模板'));
  await click(button('校验并预览差异'));
  const source = container.querySelector<HTMLSelectElement>('[aria-label="草案来源"]')!;
  await act(async () => {
    source.value = 'manual';
    source.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await act(async () => {
    finishPreview({ spec, revision: 1, added: [], changed: [], removed: [], taskChanges: [], settings: [] });
  });
  expect(container.textContent).not.toContain('批准并应用此版本');
  expect(requests.some((request) => request.path.endsWith('/apply'))).toBe(false);
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

it('看板按负责人、未分配和全部筛选，保留后端计算的阻塞优先级', async () => {
  const { BoardPage } = await import('../src/board.tsx');
  const agents = [
    { id: 'lead', name: '负责人' },
    { id: 'qa', name: '质量验证' },
  ];
  const tasks = [
    { id: 'a', title: '提交接口', owner: 'lead' },
    { id: 'b', title: '准备样例', owner: 'qa' },
    { id: 'c', title: '等待认领', owner: '' },
  ].map((t) => ({ ...t, status: 'ready', column: 'waiting', missing: [] }));
  const board = {
    spec: { title: '筛选验收', goal: '每个岗位看到自己的任务', acceptance: [], maxCalls: 5 },
    criticalSlot: 'sample',
    slots: [{ id: 'sample', title: '样例输入', unblocks: 2, waiting: ['a', 'b'] }],
    agents,
    tasks,
    executions: [],
    versions: [],
    messages: [],
    stoppedPools: [],
    revision: 1,
  };
  serve = (path) =>
    path === '/api/board' ? board : { connections: [], members: [], models: [], pools: [] };
  await render(<BoardPage openPlans={() => {}} events={0} />);
  expect(container.querySelectorAll('.card')).toHaveLength(3);
  expect(container.textContent).toContain('可解除 2 项任务的等待');
  const select = container.querySelector<HTMLSelectElement>('.toolbar select')!;
  async function choose(value: string) {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  }
  await choose('qa');
  expect(container.querySelector('.card')?.textContent).toContain('准备样例');
  await choose('(none)');
  expect(container.querySelector('.card')?.textContent).toContain('等待认领');
  await click(button('清除筛选'));
  expect(container.querySelectorAll('.card')).toHaveLength(3);
});

it('任务详情区分依赖等待和排队，旧记录保留未知，普通进度按需加载', async () => {
  const { BoardPage } = await import('../src/board.tsx');
  const task = {
    id: 'draft', title: '编写说明', owner: 'docs', status: 'waiting', column: 'waiting',
    consumes: [], produces: [], missing: ['sample'], progressRef: 'first',
    waitTime: {
      complete: false, dependencyMs: 65000, queueMs: 0, observedAt: 65000,
      intervals: [{ kind: 'waiting', start: null, end: null, blockedBy: [{slotId: 'sample', owner: 'qa'}] }],
    },
  };
  const board = {
    spec: {title: '交付', goal: '试用记录', acceptance: [], maxCalls: 5}, revision: 1, tasks: [task],
    agents: [{id: 'qa', name: '测试成员'}, {id: 'docs', name: '文档成员', connection: 'mock-docs'}],
    slots: [{id: 'sample', title: '可运行样例'}], executions: [], versions: [], messages: [], questions: [], stoppedPools: [],
  };
  const progress = '/api/tasks/draft/progress';
  const openPlans = () => {};
  serve = path => {
    if (path === '/api/board') return board;
    if (path === progress) return new Response(task.progressRef === 'first' ? '正在整理样例' : '样例已整理');
    return {connections: [], members: [], trees: []};
  };
  await render(<BoardPage openPlans={openPlans} events={0} />);
  expect(requests.some(r => r.path === progress)).toBe(false);
  const card = container.querySelector<HTMLElement>('.card')!;
  expect(card.textContent).toContain('等待依赖 至少 1 分 5 秒 · 就绪排队 未知');
  task.waitTime.observedAt = 68000;
  task.waitTime.dependencyMs = 68000;
  await click(card);
  expect(requests.filter(r => r.path === '/api/board')).toHaveLength(2);
  expect(container.textContent).toContain('等待依赖 至少 1 分 8 秒');
  expect(container.textContent).toContain('开始时间未知，截至 ' + new Date(68000).toLocaleString() + ' 仍在等待');
  expect(container.textContent).toContain('可运行样例（测试成员）');
  expect(container.textContent).toContain('正在整理样例');
  task.progressRef = 'second';
  await render(<BoardPage openPlans={openPlans} events={1} />);
  expect(container.textContent).toContain('样例已整理');
  expect(requests.filter(r => r.path === progress).map(r => r.method)).toEqual(['GET', 'GET']);
});

it('工作树刷新后联调仍使用勾选时的提交版本', async () => {
  const { WorktreesPage } = await import('../src/worktrees.tsx');
  const project = {
    id: 'app',
    repository: '/repo',
    targetBranch: 'main',
    writeEnabled: true,
    commands: [],
  };
  let sha = 'a'.repeat(40);
  const tree = () => ({
    id: 'tree',
    projectId: 'app',
    taskId: 'task1',
    kind: 'member',
    path: '/tmp/example',
    branch: 'concordia/task1',
    base: 'base',
    status: 'ready',
    sha,
    conflicts: [],
    snapshot: [],
  });
  serve = (path) => {
    if (path === '/api/worktrees/state')
      return { projects: [project], trees: [tree()], approvals: [], issues: [], results: [] };
    if (path === '/api/worktrees/publish') sha = 'b'.repeat(40);
    if (path === '/api/board') return { tasks: [] };
    if (path === '/api/delivery') return { phase: 'idle' };
    return {};
  };
  await render(<WorktreesPage />);
  await click(container.querySelector<HTMLInputElement>('.record input[type="checkbox"]')!);
  await click(button('提交交付版本'));
  await click(button('按所选提交联调（1）'));
  expect(requests.find((r) => r.path.endsWith('/integrate'))?.body).toEqual({
    projectId: 'app',
    snapshot: [{ treeId: 'tree', sha: 'a'.repeat(40) }],
  });
});

it('在连接页添加、编辑、禁用并重新启用指定连接', async () => {
  const connections: Record<string, unknown>[] = [];
  serve = (path, body) => {
    if (path === '/api/catalog') return { connections, models: [], members: [], pools: [] };
    const item = body as Record<string, unknown>;
    if (path === '/api/connections') connections.push(item);
    else if (path === '/api/connections/gateway-a') connections[0] = item;
    return item;
  };
  await render(<CatalogPage />);
  await click(button('＋ 添加连接'));
  const set = (field: string, value: string) => {
    container.querySelector<HTMLInputElement>('dialog [name="' + field + '"]')!.value = value;
  };
  set('id', 'gateway-a');
  set('name', '研究网关');
  set('baseUrl', 'https://gateway.invalid/v1');
  const mode=()=>container.querySelector<HTMLSelectElement>('dialog #stream')!;
  expect(mode().value).toBe('on');
  mode().value='off';
  await click(button('保存连接'));
  expect(connections[0]).toMatchObject({
    id: 'gateway-a',
    name: '研究网关',
    stream:false,
    kind: 'chat-completions',
    enabled: true,
  });
  await click(button('编辑'));
  expect(mode().value).toBe('off');
  mode().value='on';
  set('name', '交付网关');
  await click(button('保存连接'));
  expect(connections[0].stream).toBe(true);
  expect(container.textContent).toContain('交付网关');
  await click(button('禁用'));
  expect(connections[0].enabled).toBe(false);
  expect(button('验证').disabled).toBe(true);
  await click(button('启用'));
  expect(connections[0].enabled).toBe(true);
  expect(requests.filter((r) => r.method !== 'GET').map((r) => r.method)).toEqual([
    'POST',
    'PUT',
    'PUT',
    'PUT',
  ]);
});

it('调用预算按选定范围保存正整数上限，移除后仍显示累计用量', async () => {
  const { BudgetsPage } = await import('../src/budgets.tsx');
  const scope = 'pool',
    id = 'connection:gateway';
  let limit: unknown;
  serve = (path, body) => {
    if (path === '/api/catalog')
      return { connections: [{ id: 'gateway', name: '独立网关' }], models: [], members: [], pools: [] };
    if (path === '/api/budgets')
      return { limits: limit ? [limit] : [], usage: [{ scope, id, calls: 12, tokens: 930, active: 0 }] };
    limit = body ? { ...(body as object), scope, id } : undefined;
    return {};
  };
  await render(<BudgetsPage workspace={{ id: 'test', name: '测试' }} events={0} />);
  await click(button('额度池'));
  await click(button('设置上限'));
  container.querySelector<HTMLInputElement>('#maxTokens')!.value = '12000';
  await click(button('保存上限'));
  expect(requests.find((r) => r.method === 'PUT')).toEqual({
    path: '/api/budgets/pool/connection%3Agateway',
    method: 'PUT',
    body: { maxTokens: 12000 },
  });
  expect(container.textContent).toContain('12000');
  await click(button('设置上限'));
  await click(button('移除全部限额'));
  expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
  await click(button('确认移除，此范围累计用量将保留'));
  expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  expect(container.textContent).toContain('930');
});

it('岗位保存直属上级和显式空动作白名单，重新打开仍为受限模式', async () => {
  const catalog = {
    connections: [{ id: 'c', name: '编程', kind: 'codex', enabled: true }],
    models: [],
    members: [{ id: 'engineer', name: '开发', role: '开发', connectionId: 'c', enabled: true }],
    pools: [],
  };
  serve = (path, body) => {
    if (path === '/api/catalog') return catalog;
    if (path === '/api/members') catalog.members.push(body as (typeof catalog.members)[number]);
    return body;
  };
  await render(<CatalogPage />);
  await click(button('岗位 1'));
  await click(button('＋ 添加岗位'));
  for (const [field, value] of [
    ['id', 'reviewer'],
    ['name', '复审'],
    ['role', '审查'],
    ['reportsTo', 'engineer'],
  ]) {
    container.querySelector<HTMLInputElement | HTMLSelectElement>('dialog [name="' + field + '"]')!.value =
      value;
  }
  await click(container.querySelector<HTMLInputElement>('[name="customActions"]')!);
  await click(button('保存岗位'));
  expect(requests.filter((r) => r.path === '/api/members')[0]?.body).toMatchObject({
    id: 'reviewer',
    reportsTo: 'engineer',
    allowedActions: [],
  });
  const row = [...container.querySelectorAll('.record')].find((r) => r.textContent.includes('复审'))!;
  await click([...row.querySelectorAll('button')].find((b) => b.textContent === '编辑')!);
  expect(container.querySelector<HTMLInputElement>('[name="customActions"]')!.checked).toBe(true);
  expect(container.querySelectorAll('[name="allowedActions"]:checked')).toHaveLength(0);
});

it('活动页的下载使用当前会话的固定 JSON 摘要端点', async () => {
  const { HistoryPage } = await import('../src/history.tsx');
  serve = (path) => (path === '/api/recovery' ? { recovered: [], unresolved: [] } : []);
  await render(<HistoryPage events={0} />);
  expect(requests.some((r) => r.path === '/api/export/audit')).toBe(false);
  const clickLink = vi.spyOn(dom.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await click(button('下载脱敏审计摘要'));
  expect(requests.filter((r) => r.path === '/api/export/audit')).toHaveLength(1);
  expect(clickLink).toHaveBeenCalledOnce();
  clickLink.mockRestore();
});

it('模型可跳过定价、设置零输入单价并保留独立的输入和输出报价', async () => {
  const models: Record<string, unknown>[] = [];
  serve = (path, body) => {
    if (path === '/api/catalog')
      return {
        connections: [{ id: 'api', kind: 'responses', name: '网关', enabled: true }],
        models,
        members: [],
        pools: [],
      };
    const record = body as Record<string, unknown>;
    if (path === '/api/models') models.push(record);
    if (path === '/api/models/m') models[0] = record;
    return record;
  };
  await render(<CatalogPage />);
  await click(button('模型 0'));
  await click(button('＋ 添加模型'));
  function set(field: string, value: string) {
    container.querySelector<HTMLInputElement>('dialog [name="' + field + '"]')!.value = value;
  }
  set('id', 'm');
  set('name', '模型');
  set('modelId', 'api/model');
  await click(button('保存模型'));
  expect(models[0]).not.toHaveProperty('pricing');
  await click(button('编辑'));
  set('currency', 'cny');
  set('inputPerMillion', '0');
  set('outputPerMillion', '14');
  await click(button('保存模型'));
  expect(models[0].pricing).toEqual({ currency: 'CNY', inputPerMillion: 0, outputPerMillion: 14 });
  await click(button('编辑'));
  expect(container.querySelector<HTMLInputElement>('#inputPerMillion')?.value).toBe('0');
});

it('活动页显示任务执行时价格、已知成本和未知用量，并随事件刷新', async () => {
  const { HistoryPage } = await import('../src/history.tsx');
  const first = {
    id: 'e1',
    taskId: 'a',
    connection: 'local',
    modelId: 'custom',
    started: 1,
    inputTokens: 10,
    outputTokens: 0,
    pricing: { currency: 'USD', inputPerMillion: 2, outputPerMillion: 0 },
    amount: 0.00002,
  };
  serve = (path) =>
    path === '/api/execution-costs'
      ? [first, { ...first, id: 'e2', modelId: null, pricing: null, amount: null, inputTokens: null }]
      : path === '/api/recovery'
        ? { recovered: 0, unresolved: [] }
        : [];
  await render(<HistoryPage events={0} />);
  expect(container.textContent).toContain('0.00002 USD');
  expect(container.textContent).toContain('未知模型');
  expect(container.textContent).toContain('未知 / 0');
  await render(<HistoryPage events={1} />);
  expect(requests.filter((r) => r.path === '/api/execution-costs')).toHaveLength(2);
});

it('仓库暂时不可读的审批显示诊断并禁用，仍可审查同页其他票据', async () => {
  const { WorktreesPage } = await import('../src/worktrees.tsx');
  serve = (path) => {
    if (path === '/api/worktrees/state')
      return {
        projects: [
          { id: 'app', repository: 'fixture', targetBranch: 'main', writeEnabled: true, commands: [] },
        ],
        trees: [
          {
            id: 'tree',
            projectId: 'app',
            kind: 'member',
            status: 'ready',
            sha: null,
            conflicts: [],
            snapshot: [],
          },
        ],
        approvals: [
          {
            id: 'blocked',
            treeId: 'tree',
            kind: 'merge',
            sha: 'a',
            available: false,
            diagnostic: '登记仓库当前不可访问。',
          },
          {
            id: 'valid',
            treeId: 'tree',
            kind: 'command',
            sha: 'b',
            available: true,
            name: '测试',
            executable: 'node',
            args: ['--test'],
          },
        ],
        issues: [],
        results: [],
      };
    if (path === '/api/board') return { tasks: [] };
    return { phase: 'idle' };
  };
  await render(<WorktreesPage />);
  const buttons = [...container.querySelectorAll('button')].filter((b) => b.textContent === '查看并审批');
  expect(container.textContent).toContain('登记仓库当前不可访问。');
  expect(buttons.map((b) => b.disabled)).toEqual([true, false]);
  await click(buttons[1]);
  expect(container.querySelector('dialog')?.textContent).toContain('--test');
});

it('API 连接验证展示实际 HTTP 状态、毫秒数和已知用量，缺失项显示未知', async () => {
  const catalog = {
    connections: [
      {
        id: 'api',
        name: '测试网关',
        kind: 'chat-completions',
        baseUrl: 'https://example.invalid',
        enabled: true,
      },
    ],
    models: [{ id: 'm', name: '模型', connectionId: 'api', modelId: 'custom', enabled: true }],
    members: [],
    pools: [],
  };
  serve = (path) =>
    path === '/api/catalog'
      ? catalog
      : {
          ok: true,
          text: 'CONCORDIA_OK',
          httpStatus: 201,
          elapsedMs: 0,
          usage: { inputTokens: 0, outputTokens: 2 },
        };
  await render(<CatalogPage />);
  await click(button('验证'));
  await click(button('批准一次真实调用'));
  expect(container.textContent).toContain('HTTP 201');
  expect(container.textContent).toContain('耗时 0 ms');
  expect(container.textContent).toContain('输入 0 · 输出 2 · 合计 未知');
  serve = () => ({ ok: false, error: '认证失败', httpStatus: 401, elapsedMs: 22 });
  await click(button('批准一次真实调用'));
  expect(container.textContent).toContain('HTTP 401');
  expect(container.textContent).toContain('Token 用量 · 未知');
});
