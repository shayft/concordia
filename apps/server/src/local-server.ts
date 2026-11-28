import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthResponseSchema } from '@concordia/protocol';
import Fastify from 'fastify';
import { registerApplication } from './application.ts';

const webDirectory = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const proofHeader = 'x-concordia-session';

const bootstrapScript = `
const token = location.hash.slice(1);
history.replaceState(null, '', '/launch');
async function openConcordia() {
  if (token) {
    const response = await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const proof = response.headers.get('x-concordia-session');
    if (response.ok && proof) {
      localStorage.setItem('concordia.session', proof);
      location.replace('/');
      return;
    }
  }
  document.querySelector('p').textContent = '请使用终端本次启动时显示的完整链接。';
}
openConcordia().catch(() => {
  document.querySelector('p').textContent = '无法连接到 Concordia。请检查终端中的服务状态。';
});
`;
const bootstrapHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Concordia</title>
<p>正在打开 Concordia…</p><script>${bootstrapScript}</script></html>`;
const scriptHash = createHash('sha256').update(bootstrapScript).digest('base64');
const policy = `default-src 'none'; script-src 'self' 'sha256-${scriptHash}'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function matches(received: unknown, expected: string | undefined): boolean {
  if (typeof received !== 'string' || expected === undefined ||
    received.length !== expected.length || !/^[A-Za-z0-9_-]+$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function sessionCookie(header: string | undefined, cookieName: string): string | undefined {
  const prefix = cookieName + '=';
  const entries = header?.split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
  if (entries?.length === 1) return entries[0].slice(prefix.length);
}

async function loadWebFiles(directory: string) {
  const index = join(directory, 'index.html');
  const assets = join(directory, 'assets');
  if (!(await lstat(directory)).isDirectory() || !(await lstat(index)).isFile() ||
      !(await lstat(assets)).isDirectory()) throw new Error('缺少 Web 构建产物。');
  const files = new Map<string, { type: string; content: Buffer }>();
  files.set('/', { type: 'text/html; charset=utf-8', content: await readFile(index) });
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[\w.-]+\.(css|js)$/.test(entry.name)) continue;
    const type = entry.name.endsWith('.css') ? 'text/css' : 'text/javascript';
    files.set('/assets/' + entry.name, { type, content: await readFile(join(assets, entry.name)) });
  }
  return files;
}

export async function startLocalServer(directory = webDirectory, dataDirectory?: string) {
  const files = await loadWebFiles(directory);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  let launchToken: string | undefined = randomBytes(32).toString('base64url');
  const session = randomBytes(32).toString('base64url');
  // Cookies on loopback are shared across ports. Static assets use an instance-specific
  // cookie; application data additionally requires a proof held by this browser origin.
  const cookieName = 'concordia_' + randomBytes(12).toString('hex');
  const proof = randomBytes(32).toString('base64url');
  let sessionHost: string | undefined;

  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': policy,
      'x-content-type-options': 'nosniff',
    });
    const address = app.server.address();
    const host = request.headers.host;
    if (request.raw.headersDistinct.host?.length !== 1 || !address || typeof address === 'string' ||
        (host !== '127.0.0.1:' + address.port && host !== 'localhost:' + address.port)) {
      return reply.code(403).send();
    }

    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const origin = request.headers.origin;
    const mcp = request.method === 'POST' && /^\/mcp\/[A-Za-z0-9_-]{1,96}$/.test(request.url);
    if (mcp) {
      if (origin !== undefined && origin !== 'http://' + host) return reply.code(403).send();
      // The handler verifies the bearer bound to this specific execution.
      return;
    }
    if ((!isRead || origin !== undefined) && origin !== 'http://' + host) {
      return reply.code(403).send();
    }
    if ((isRead && request.url === '/launch') ||
        (request.method === 'POST' && request.url === '/session')) return;
    if (host !== sessionHost || !matches(sessionCookie(request.headers.cookie, cookieName), session))
      return reply.code(401).send();
    if (request.routeOptions.url?.startsWith('/api/') && !matches(request.headers[proofHeader], proof))
      return reply.code(401).send();
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : 500;
    return reply.code(typeof status === 'number' && status >= 400 && status < 600 ? status : 500).send();
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send());

  app.get('/launch', async (_request, reply) => reply.type('text/html; charset=utf-8').send(bootstrapHtml));
  app.post<{ Body: { token?: unknown } | null }>('/session', async (request, reply) => {
    if (!matches(request.body?.token, launchToken)) return reply.code(401).send();
    launchToken = undefined;
    sessionHost = request.headers.host;
    return reply.header(proofHeader, proof).header('set-cookie', cookieName + '=' + session + '; Path=/; HttpOnly; SameSite=Strict')
      .code(204).send();
  });

  app.get('/api/health', async () => healthResponseSchema.parse({ status: 'ok' }));
  for (const [route, file] of files) {
    app.get(route, async (_request, reply) => reply.type(file.type).send(file.content));
  }
  try {
    if (dataDirectory) await registerApplication(app, dataDirectory);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    return { launchUrl: url + '/launch#' + launchToken, close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}
