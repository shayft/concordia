import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore } from '@concordia/store';
import { privateDataDirectory } from '@concordia/store/paths';
import { startLocalServer } from '../src/local-server.ts';
import { browserSession } from './browser-session.ts';

let scratch: string, data: string, web: string;
let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;
async function start() {
  service = await startLocalServer(web, data);
  return browserSession(new URL(service.launchUrl));
}
async function stop() { await service?.close(); service = undefined; }
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'concordia-board-preservation-'));
  data = join(scratch, 'data');
  web = join(scratch, 'web');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>Concordia</title>');
});
afterEach(async () => { await stop(); await rm(scratch, { recursive: true, force: true }); });

it('已登记的非活动工作区库遗失后切换失败，保持现有看板和缺失现场', async () => {
  let ui = await start();
  const created = await ui.post('/api/workspaces', { name: '副工作区' });
  expect(created.status).toBe(200);
  const { active } = await created.json() as { active: string };
  expect((await ui.post('/api/workspaces/default/select', {})).status).toBe(200);
  await stop();
  const board = join(data, 'boards', active, 'workspace.sqlite');
  await rename(board, join(scratch, 'retained.sqlite'));
  ui = await start();
  const response = await ui.post('/api/workspaces/' + active + '/select', {});
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain('核对原目录或从备份恢复');
  expect((await (await ui.get('/api/workspaces')).json()).active).toBe('default');
  await expect(access(board)).rejects.toThrow();
});

it('活动工作区或其目录遗失时服务拒绝启动，不建立空库，复原后可重新打开', async () => {
  await start();
  await stop();
  const dir = join(data, 'boards', 'default');
  const retained = join(scratch, 'retained');
  await rename(dir, retained);
  await expect(start()).rejects.toThrow('已登记工作区的数据库缺失');
  await expect(access(dir)).rejects.toThrow();
  await rename(retained, dir);
  const ui = await start();
  expect((await (await ui.get('/api/workspaces')).json()).active).toBe('default');
});

it('以前未启用工作区的真实旧库可以首次建立默认看板并保留目录数据', async () => {
  privateDataDirectory(data);
  const catalog = new DatabaseSync(join(data, 'catalog.sqlite'));
  try {
    const first = await readFile(new URL('../../../packages/store/migrations/001-bootstrap.sql', import.meta.url), 'utf8');
    catalog.exec(first);
    catalog.exec("INSERT INTO schema_migrations VALUES(1,'001-bootstrap.sql'); PRAGMA user_version=1");
    catalog.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('旧版数据')");
  } finally { catalog.close(); }
  const ui = await start();
  expect((await (await ui.get('/api/workspaces')).json()).active).toBe('default');
  await stop();
  const upgraded = openStore(join(data, 'catalog.sqlite'));
  try { expect(upgraded.prepare('SELECT value FROM preserved').get()?.value).toBe('旧版数据'); }
  finally { upgraded.close(); }
});
