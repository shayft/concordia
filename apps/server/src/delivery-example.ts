// These are the source files a scripted member writes into its own worktree.
export const exampleFiles = {
  backend: {
    'api.mjs': `export const tasks = [
  {id:1, title:'接口', assignee:'backend'},
  {id:2, title:'界面', assignee:'frontend'},
  {id:3, title:'待分配', assignee:null},
];

export function handleTasks(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/tasks') return new Response(null, {status:404});
  const selected = url.searchParams.get('assignee');
  const filtered = selected === null ? tasks : tasks.filter(task =>
    selected === 'unassigned' ? task.assignee === null : task.assignee === selected);
  return Response.json(filtered);
}
`,
  },
  frontend: {
    'filter.mjs': `export async function filterCards(selection, fetchTasks) {
  const query = new URLSearchParams();
  if (selection) query.set('assignee', selection);
  const path = '/tasks' + (query.size ? '?' + query : '');
  const response = await fetchTasks(path);
  if (!response.ok) throw new Error('筛选请求失败');
  return response.json();
}

export function mountFilter(select, list, fetchTasks) {
  let generation = 0;
  async function refresh() {
    const current = ++generation;
    const cards = await filterCards(select.value, fetchTasks);
    if (generation !== current) return;
    const items = cards.map(card => {
      const item = document.createElement('li');
      item.textContent = card.title;
      return item;
    });
    list.replaceChildren(...items);
  }
  select.addEventListener('change', refresh);
  return refresh();
}
`,
    'index.html': `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>按负责人筛选</title>
<label>负责人 <select><option value="">全部</option><option value="backend">后端</option>
<option value="frontend">前端</option><option value="unassigned">未分配</option></select></label>
<ul></ul><script type="module">
import { mountFilter } from './filter.mjs';
import { handleTasks } from './api.mjs';
mountFilter(document.querySelector('select'), document.querySelector('ul'),
  path => Promise.resolve(handleTasks(new Request(new URL(path, location.href)))));
</script></html>
`,
  },
  qa: {
    'filter.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCards } from './filter.mjs';
import { handleTasks } from './api.mjs';

const fetchTasks = path => Promise.resolve(handleTasks(new Request(new URL(path, 'http://127.0.0.1'))));
for (const [name, selection, expected] of [
  ['按负责人筛选', 'backend', [1]],
  ['仅未分配任务', 'unassigned', [3]],
  ['清除筛选恢复全部', '', [1, 2, 3]],
]) {
  test(name, async () => {
    const cards = await filterCards(selection, fetchTasks);
    assert.deepEqual(cards.map(card => card.id), expected);
  });
}
`,
  },
};
