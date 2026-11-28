import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateGateway } from '../src/gateway.js';

const cleanups: (() => Promise<void>)[] = [];
const config = { model: 'custom/model α', credentialRef: 'gateway-test' };
const acknowledgement = { choices: [{ message: { content: 'CONCORDIA_OK' } }] };
const mockCredential = async () => randomUUID();

async function listen(handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(stop => stop()));
});

describe('Chat Completions 单次验证', () => {
  it('保留自定义 API 路径和模型；两份配置并发时凭据、请求和统计各自独立', async () => {
    const evidence = [];
    for (const [name, root] of [['a', '/tenant/a/v1/'], ['b', '/b-api']] as const) {
      const credential = randomUUID();
      const requests: { path?: string | undefined; method?: string | undefined; authorized: boolean; body: unknown }[] = [];
      const base = await listen((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          requests.push({
            path: req.url, method: req.method, authorized: req.headers.authorization === `Bearer ${credential}`,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
          res.end(JSON.stringify({
            ...acknowledgement,
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, private: 'untrusted' },
          }));
        });
      });
      const model = config.model + name;
      const check = validateGateway({ ...config, model, baseUrl: base + root }, async () => credential);
      evidence.push({ root, model, requests, check });
    }
    for (const { root, model, requests, check } of evidence) {
      const result = await check;
      expect(result).toEqual({
        ok: true, text: 'CONCORDIA_OK', elapsedMs: expect.any(Number), httpStatus: 200,
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      });
      expect(requests).toEqual([{
        path: root.replace(/\/$/, '') + '/chat/completions', method: 'POST', authorized: true,
        body: { model, stream: false, max_completion_tokens: 1024, messages: [{ role: 'user', content: expect.stringContaining('CONCORDIA_OK') }] },
      }]);
    }
  });

  it('省略未知用量；成功正文仅允许公开回显', async () => {
    let attempt = 0;
    const baseUrl = await listen((req, res) => {
      res.end(JSON.stringify(++attempt === 1 ? acknowledgement : {
        choices: [{ message: { content: req.headers.authorization } }],
      }));
    });
    const credential = randomUUID();
    const check = () => validateGateway({ ...config, baseUrl }, async () => credential);
    const success = await check();
    expect(success.ok).toBe(true);
    expect(success).not.toHaveProperty('usage');
    const echo = await check();
    expect(echo.ok).toBe(false);
    expect(JSON.stringify(echo).includes(credential)).toBe(false);
  });

  it.each([401, 403, 429, 503])('HTTP %d 只记录安全代码并且只请求一次', async status => {
    const credential = randomUUID();
    let requests = 0;
    const baseUrl = await listen((_req, res) => {
      ++requests;
      res.writeHead(status);
      res.end(JSON.stringify({ error: { message: credential, code: credential, type: 'invalid_request_error' } }));
    });
    const result = await validateGateway({ ...config, baseUrl }, async () => credential);
    expect(result).toMatchObject({ ok: false, httpStatus: status, error: expect.stringContaining('invalid_request_error') });
    expect(JSON.stringify(result).includes(credential)).toBe(false);
    expect(requests).toBe(1);
  });

  it('重定向仅记录原始 HTTP 状态，目标没有收到凭据或请求', async () => {
    const received = vi.fn<RequestListener>((_req, res) => res.end());
    const target = await listen(received);
    const baseUrl = await listen((_req, res) => {
      res.writeHead(307, { Location: target });
      res.end();
    });
    expect(await validateGateway({ ...config, baseUrl }, mockCredential))
      .toMatchObject({ ok: false, httpStatus: 307, error: expect.stringContaining('重定向') });
    expect(received).not.toHaveBeenCalled();
  });

  it.each(['http://remote.invalid/v1', 'https://user@example.invalid/v1', 'https://test.invalid/?private=1', 'bad-url'])(
    'URL 校验在读取凭据之前执行 (%s)', async baseUrl => {
      const read = vi.fn(mockCredential);
      expect(await validateGateway({ ...config, baseUrl }, read)).toMatchObject({ ok: false, httpStatus: null });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(['<html>gateway down</html>', JSON.stringify(acknowledgement) + ' '.repeat(65_536)])(
    '拒绝非 JSON 或超限的正文', async body => {
      const baseUrl = await listen((_req, res) => res.end(body));
      expect(await validateGateway({ ...config, baseUrl }, mockCredential))
        .toMatchObject({ ok: false, httpStatus: 200, error: expect.stringContaining('64 KiB') });
    },
  );

  it('凭据缺失时保留脱敏的本地诊断', async () => {
    const result = await validateGateway({ ...config, baseUrl: 'https://offline.invalid/v1' }, async () => {
      throw new Error(randomUUID());
    });
    expect(result).toMatchObject({ ok: false, httpStatus: null, error: '系统凭据读取失败，请检查引用和系统凭据存储' });
  });

  it('凭据库的弹窗无响应时可以超时；迟到的读取不会发出请求', async () => {
    let complete!: (value: string) => void;
    const pending = new Promise<string>(resolve => { complete = resolve; });
    const received = vi.fn<RequestListener>((_req, res) => res.end());
    const baseUrl = await listen(received);
    expect(await validateGateway({ ...config, baseUrl, timeoutMs: 75 }, () => pending))
      .toMatchObject({ ok: false, httpStatus: null, error: '验证超时' });
    complete(randomUUID());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(received).not.toHaveBeenCalled();
  });

  it('等待响应体期间超时也保留 HTTP 状态', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200);
      res.write('{');
    });
    expect(await validateGateway({ ...config, baseUrl, timeoutMs: 300 }, mockCredential))
      .toMatchObject({ ok: false, httpStatus: 200, error: '验证超时' });
  });

  it('取消进行中的网关请求', async () => {
    const stop = new AbortController();
    const baseUrl = await listen(() => stop.abort());
    expect(await validateGateway({ ...config, baseUrl }, mockCredential, stop.signal))
      .toMatchObject({ ok: false, httpStatus: null, error: '验证已取消' });
  });
});
