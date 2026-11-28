import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startLocalServer } from '../src/local-server.ts';

let directory: string;
let service: Awaited<ReturnType<typeof startLocalServer>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'concordia-launch-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<title>应用</title>');
  service = await startLocalServer(directory);
});
afterEach(async () => {
  await service.close();
  await rm(directory, { recursive: true, force: true });
});

function browser(
  options: { blockRead?: boolean; blockWrite?: boolean; blockCookie?: boolean; failSave?: boolean } = {},
) {
  const values = new Map<string, string>();
  let cookie = '';
  return async (useFragment = true) => {
    const launch = new URL(service.launchUrl);
    const html = await (await fetch(launch.origin + '/launch')).text();
    const source = html.match(/<script>([\s\S]+?)<\/script>/)?.[1];
    if (!source) throw new Error('缺少引导脚本');
    const requests: string[] = [];
    const message = { textContent: '' };
    let destination = '';
    await runInNewContext(source, {
      location: {
        hash: useFragment ? launch.hash : '',
        replace: (path: string) => {
          destination = path;
        },
      },
      history: { replaceState() {} },
      document: { querySelector: () => message },
      localStorage: {
        getItem: (key: string) => {
          if (options.blockRead) throw new Error('storage disabled');
          return values.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (options.blockWrite || (options.failSave && key === 'concordia.session'))
            throw new Error('storage disabled');
          values.set(key, value);
        },
        removeItem: (key: string) => values.delete(key),
      },
      fetch: async (path: string, init: RequestInit) => {
        requests.push(path);
        const headers = new Headers(init.headers);
        headers.set('origin', launch.origin);
        if (cookie) headers.set('cookie', cookie);
        const response = await fetch(launch.origin + path, { ...init, headers });
        const offered = response.headers.get('set-cookie');
        if (offered && !options.blockCookie) cookie = offered.split(';')[0];
        return response;
      },
      JSON,
    });
    return { destination, requests, message: message.textContent };
  };
}

it('有效浏览器重开已兑换链接或裸引导地址时核对会话，另一浏览器仍被拒绝', async () => {
  const same = browser();
  expect((await same()).requests).toEqual(['/session', '/api/health']);
  for (const withFragment of [true, false]) {
    const resumed = await same(withFragment);
    expect(resumed.destination).toBe('/');
    expect(resumed.requests).toEqual(['/api/health']);
  }
  const denied = await browser()();
  expect(denied.destination).toBe('');
  expect(denied.message).toContain('已使用或已失效');
  expect(denied.message).toContain('Ctrl+C');
});

it('存储被拒绝时保留未使用的链接，并区分读取/写入故障', async () => {
  for (const options of [{ blockRead: true }, { blockWrite: true }]) {
    const result = await browser(options)();
    expect(result.requests).toEqual([]);
    expect(result.message).toContain('浏览器阻止');
    expect(result.destination).toBe('');
  }
  expect((await browser()()).destination).toBe('/');
});

it.each([
  [{ failSave: true }, '未能保存会话'],
  [{ blockCookie: true }, '请允许此站点使用 Cookie'],
])('兑换后存储或 Cookie 异常时给出可执行的恢复提示', async (options, diagnosis) => {
  const result = await browser(options)();
  expect(result.message).toContain(diagnosis);
  expect(result.message).toContain('新链接');
  expect(result.destination).toBe('');
});
