import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { existingDirectory } from './paths.mjs';

const [oldPath, newPath, ...extra] = process.argv.slice(2);
if (!oldPath || !newPath || extra.length) throw new Error('用法：node scripts/release/lifecycle.mjs <已安装旧源码> <已安装候选源码>');
const previous = existingDirectory(oldPath), candidate = existingDirectory(newPath);
const { privateTemporaryDirectory } = await import(pathToFileURL(join(candidate, 'packages/store/src/paths.ts')).href);
const scratch = privateTemporaryDirectory(tmpdir(), 'concordia-rc-');
const environment = {};
for (const name of ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'ProgramFiles'])
  if (process.env[name]) environment[name] = process.env[name];
Object.assign(environment, { TMP: scratch, TEMP: scratch, TMPDIR: scratch, HOME: scratch, USERPROFILE: scratch });

async function withService(source, data, action) {
  const child = fork(fileURLToPath(new URL('./service.mjs', import.meta.url)), [source, data], {
    cwd: source, env: environment, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    const url = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(40_000) }).then(([value]) => new URL(value)),
      exited.then(() => { throw new Error('验收服务在完成启动前退出。'); }),
    ]);
    const origin = url.origin;
    const exchange = await fetch(origin + '/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: url.hash.slice(1) }) });
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
    assert.ok(exchange.status === 204 && cookie, '本机服务会话兑换失败');
    const headers = { origin, cookie };
    const proof = exchange.headers.get('x-concordia-session');
    if (proof) headers['x-concordia-session'] = proof;
    const request = async (path, body) => {
      const scoped = { ...headers };
      if (body !== undefined && proof) {
        const current = await request('/api/workspaces');
        scoped['x-concordia-workspace'] = current.active;
        scoped['x-concordia-generation'] = current.generation;
      }
      const resp = await fetch(origin + path, body === undefined ? { headers } : {
        method: 'POST', headers: { ...scoped, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error('模拟演练接口返回 ' + resp.status + '：' + path);
      return resp.json();
    };
    const home = await fetch(origin + '/', { headers });
    assert.ok(home.ok && (await home.text()).includes('id="root"'), '已安装的 Vite 首页不可用');
    return await action(request);
  } finally {
    if (child.connected) child.send('stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { const [code] = await exited; assert.equal(code, 0, '验收服务未正常退出'); }
    finally { clearTimeout(timer); }
  }
}

async function snapshot(request) {
  const board = await request('/api/board');
  assert.ok(board.acceptance?.integration && board.executions.length > 0, '模拟主卡尚未验收');
  const artifact = await request('/api/versions/' + board.acceptance.integration);
  assert.ok(artifact.content.length > 0, '交付正文丢失');
  const approvals = [];
  let after = 0;
  while (true) {
    const page = await request('/api/history?after=' + after);
    if (page.length === 0) break;
    for (const event of page) {
      assert.ok(Number.isSafeInteger(event.seq) && event.seq > after, '历史游标未前进');
      after = event.seq;
      if (event.type === 'plan.accepted' || (event.type === 'task.control' && event.data.operation === 'accept'))
        approvals.push([event.seq, event.type]);
    }
  }
  assert.ok(approvals.some(([, type]) => type === 'task.control') &&
    approvals.some(([, type]) => type === 'plan.accepted'), '缺少已记录的任务和主卡验收决定');
  return {
    approvals, acceptance: board.acceptance, versions: board.versions.map(({ id, contentRef }) => [id, contentRef]),
    executions: board.executions.map(({ id, status }) => [id, status]), integration: artifact.content,
  };
}
async function copyState(source, mode, from, to) {
  try {
    // Invoke the installed backup CLI directly. A separate tsx CLI launcher opens
    // an extra Unix IPC socket in TMPDIR, which may exceed macOS's pathname limit.
    await promisify(execFile)(process.execPath, ['--import', 'tsx', join(source, 'apps/server/src/backup.ts'), mode, from, to],
      { cwd: source, env: environment, shell: false, timeout: 90_000, windowsHide: true });
  } catch (error) {
    const code = String(error.stderr ?? '').match(/\b(?:ENAMETOOLONG|ECONNREFUSED|EADDRINUSE|EACCES|ENOENT|EPERM|ERR_MODULE_NOT_FOUND)\b/u)?.[0];
    const reason = code ?? (String(error.stderr).includes('操作未完成') ? '应用完整性或路径检查' : '进程启动或退出');
    throw new Error('离线 ' + mode + ' 失败：' + reason);
  }
}
function versions(data) {
  return ['catalog.sqlite', 'worktrees.sqlite', 'boards/default/workspace.sqlite'].map(file => {
    const db = new DatabaseSync(join(data, file), { readOnly: true });
    try { return Number(db.prepare('PRAGMA user_version').get().user_version); }
    finally { db.close(); }
  });
}

try {
  const data = join(scratch, 'upgrade'), before = join(scratch, 'old-backup');
  const after = join(scratch, 'candidate-backup'), restored = join(scratch, 'candidate-restored'), rollback = join(scratch, 'rollback');
  const legacy = await withService(previous, data, async request => { await request('/api/demo/run', {}); return snapshot(request); });
  const originalVersions = versions(data);
  assert.deepEqual(originalVersions, [7, 3, 7], '旧版基线与预期不匹配');
  await copyState(previous, 'create', data, before);
  const imported = join(scratch, 'old-backup-opened-by-candidate');
  await copyState(candidate, 'restore', before, imported);
  await withService(candidate, imported, async request => {
    assert.deepEqual(await snapshot(request), legacy, '候选直接恢复旧版备份后未保留验收或交付正文');
    assert.equal((await request('/api/workspaces')).workspaces.length, 1);
  });
  let addedWorkspace;
  const current = await withService(candidate, data, async request => {
    assert.deepEqual(await snapshot(request), legacy, '升级未保留旧版验收和正文');
    addedWorkspace = (await request('/api/workspaces', { name: '候选模拟验收' })).active;
    await request('/api/demo/run', {});
    return snapshot(request);
  });
  const migrated = versions(data);
  assert.deepEqual(versions(imported), migrated, '旧备份转换与原位升级得到不同数据库版本');
  assert.ok(migrated.every((v, i) => v > originalVersions[i]), '候选未升级所有已知旧库');
  await copyState(candidate, 'create', data, after);
  await copyState(candidate, 'restore', after, restored);
  await withService(candidate, restored, async request => {
    assert.equal((await request('/api/workspaces')).active, addedWorkspace);
    assert.deepEqual(await snapshot(request), current, '恢复后候选验收不一致');
    await request('/api/workspaces/default/select', {});
    assert.deepEqual(await snapshot(request), legacy, '恢复后旧版验收不一致');
  });
  await copyState(previous, 'restore', before, rollback);
  await withService(previous, rollback, async request => {
    assert.deepEqual(await snapshot(request), legacy, '旧软件回退后验收不一致');
    assert.equal((await request('/api/workspaces')).workspaces.length, 1);
  });
  assert.deepEqual(versions(rollback), originalVersions);
  console.log('模拟交付、旧备份由候选直接恢复、原位升级、候选备份恢复和旧版回退均通过。SQLite 版本 ' +
    originalVersions.join('/') + ' → ' + migrated.join('/') + ' → ' + versions(rollback).join('/') + '。');
} finally { await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); }
