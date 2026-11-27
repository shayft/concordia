import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { openStore } from '@concordia/store';
import { acquireDataDirectory } from '../src/data-directory.ts';
import { copyApplicationState } from '../src/backup.ts';
import { registerConnectionRoutes } from '../src/connections.ts';

const fakeStore = vi.hoisted(() => ({ read: vi.fn<() => Promise<string>>() }));
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    getPassword = fakeStore.read;
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});
it('网关回显请求头时，浏览器结果、额度记录和离线备份只包含系统引用', async () => {
  const synthetic = randomUUID();
  fakeStore.read.mockResolvedValue(synthetic);
  let sawRequest = false;
  const mock = createServer((req, res) => {
    sawRequest = req.headers.authorization === 'Bearer ' + synthetic && req.headers['x-tenant'] === synthetic;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: req.headers.authorization, code: req.headers['x-tenant'] } }));
  });
  const root = await mkdtemp(join(tmpdir(), 'concordia-mock-privacy-'));
  const source = join(root, 'source'),
    snapshot = join(root, 'snapshot');
  const lock = acquireDataDirectory(source);
  const db = openStore(join(source, 'catalog.sqlite'));
  const app = Fastify();
  registerConnectionRoutes(app, db, { isRunning: () => false });
  try {
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + (mock.address() as AddressInfo).port;
    const connection = {
      id: 'one',
      name: '模拟',
      kind: 'chat-completions',
      baseUrl,
      credentialRef: 'keychain:demo',
      headerRefs: { 'X-Tenant': 'keychain:tenant' },
    };
    const create = (url: string, payload: object) =>
      app.inject({ method: 'POST', url: '/api/' + url, payload });
    expect((await create('connections', connection)).statusCode).toBe(201);
    expect(
      (await create('models', { id: 'choice', modelId: 'arbitrary', name: '模拟', connectionId: 'one' }))
        .statusCode,
    ).toBe(201);
    const result = await create('connections/one/test', { modelId: 'choice', approved: true });
    expect(result.json()).toMatchObject({ ok: false, httpStatus: 401 });
    expect(sawRequest).toBe(true);
    expect(fakeStore.read).toHaveBeenCalledTimes(2);
    for (const body of [
      result.body,
      (await app.inject('/api/catalog')).body,
      (await app.inject('/api/budgets')).body,
    ]) {
      expect(body.includes(synthetic)).toBe(false);
    }
  } finally {
    await app.close();
    db.close();
    lock.release();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
  try {
    await copyApplicationState('create', source, snapshot);
    for (const path of [join(source, 'catalog.sqlite'), join(snapshot, 'catalog.sqlite')]) {
      const contents = await readFile(path);
      expect(contents.includes(synthetic)).toBe(false);
      expect(contents.includes('keychain:demo')).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
