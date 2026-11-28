import { browserSession } from './browser-session.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startLocalServer } from '../src/local-server.ts';

describe('本地服务的启动和访问边界', () => {
  let directory: string;
  let server: Awaited<ReturnType<typeof startLocalServer>>;
  let launch: URL;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'concordia-web-'));
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<title>Concordia</title>');
    await writeFile(join(directory, 'assets', 'index-example.js'), 'export {};');
    server = await startLocalServer(directory);
    launch = new URL(server.launchUrl);
  });
  afterEach(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function exchange(origin: string | undefined = launch.origin, token = launch.hash.slice(1)) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    return fetch(launch.origin + '/session', {
      method: 'POST', headers, body: JSON.stringify({ token }),
    });
  }
  // Use node:http to set Host on the wire, including the permitted localhost alias.
  function statusForHost(host: string | string[]) {
    return new Promise<number | undefined>((resolve, reject) => {
      const req = request(launch.origin + '/launch', { headers: Array.isArray(host) ? host.flatMap(value => ['Host', value]) : { host } }, res => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('只监听 IPv4 回环地址，每个 Host 必须带匹配端口', async () => {
    expect(launch.hostname).toEqual('127.0.0.1');
    expect(Number(launch.port)).toBeGreaterThan(0);
    expect(await statusForHost('localhost:' + launch.port)).toBe(200);
    expect(await statusForHost('127.0.0.1')).toBe(403);
    expect(await statusForHost('localhost:0')).toBe(403);
    expect(await statusForHost([launch.host, 'other.invalid'])).toBe(403);
    expect(await statusForHost('untrusted.invalid:' + launch.port)).toBe(403);
  });

  it('凭据只在链接片段中，公开引导页不会返回启动令牌或会话', async () => {
    expect(launch.pathname).toBe('/launch');
    expect(launch.search).toBe('');
    const bootstrap = await fetch(launch);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.has('set-cookie')).toBe(false);
    expect((await bootstrap.text()).includes(launch.hash.slice(1))).toBe(false);
    for (const route of ['/', '/assets/index-example.js', '/api/health']) {
      expect((await fetch(launch.origin + route)).status).toBe(401);
    }
  });

  it('拒绝跨站或缺失 Origin 的写请求，无 CORS 回应', async () => {
    for (const origin of ['http://untrusted.invalid', 'null', '']) {
      const response = await exchange(origin);
      expect(response.status).toBe(403);
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    const options = await fetch(launch.origin + '/session', {
      method: 'OPTIONS', headers: { origin: 'http://untrusted.invalid' },
    });
    expect(options.status).toBe(403);
    expect(options.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('启动令牌只能兑换一次，随后使用 HttpOnly Strict 会话访问首页、资源和状态', async () => {
    expect((await exchange(launch.origin, '')).status).toBe(401);
    const responses = await Promise.all([exchange(), exchange()]);
    expect(responses.map(res => res.status).sort()).toEqual([204, 401]);
    const accepted = responses.find(res => res.status === 204)!;
    const header = accepted.headers.get('set-cookie') ?? '';
    const proof = accepted.headers.get('x-concordia-session')!;
    const [cookie, ...attrs] = header.split('; ');
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/']));
    for (const route of ['/', '/assets/index-example.js', '/api/health']) {
      const response = await fetch(launch.origin + route, { headers: { cookie, 'x-concordia-session': proof } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(launch.origin + '/', { headers: { cookie: cookie + '; ' + cookie } })).status).toBe(401);
    expect((await fetch(launch.origin + '/assets/missing.js', { headers: { cookie } })).status).toBe(404);

    const oldToken = launch.hash.slice(1);
    await server.close();
    server = await startLocalServer(directory);
    launch = new URL(server.launchUrl);
    expect((await exchange(launch.origin, oldToken)).status).toBe(401);
    expect((await fetch(launch.origin + '/', { headers: { cookie } })).status).toBe(401);
  });
  it('两个合法实例在同一浏览器共用 Cookie 容器时，各自的 API 会话仍独立', async () => {
    const other = await startLocalServer(directory);
    try {
      const a = await browserSession(launch);
      const b = await browserSession(new URL(other.launchUrl));
      const cookie = a.cookie + '; ' + b.cookie;
      for (const [current, second] of [[a, b], [b, a]]) {
        expect((await fetch(current.origin + '/api/health', { headers: { ...current.headers, cookie } })).status).toBe(200);
        for (const headers of [{ cookie }, { ...second.headers, origin: current.origin, cookie }])
          expect((await fetch(current.origin + '/api/health', { headers })).status).toBe(401);
      }
    } finally {
      await other.close();
    }
  });

});
