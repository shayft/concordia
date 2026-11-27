import { z } from 'zod';

export interface GatewayConfig {
  baseUrl: string;
  model: string;
  credentialRef: string;
  timeoutMs?: number;
}

type CredentialReader = (reference: string, signal?: AbortSignal) => Promise<string>;
const tokenCount = z.number().int().nonnegative().optional();
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  total_tokens: tokenCount,
});

const replySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.unknown().optional(),
});

export type GatewayResult = {
  httpStatus: number | null;
  elapsedMs: number;
} & (
  | { ok: true; text: string; usage?: z.infer<typeof usageSchema> }
  | { ok: false; error: string }
);

const acknowledgement = 'CONCORDIA_OK';
const safeErrorCodes = new Set([
  'invalid_api_key', 'insufficient_quota', 'rate_limit_exceeded',
  'model_not_found', 'permission_denied', 'invalid_request_error',
  'context_length_exceeded', 'server_error',
]);

function completionUrl(baseUrl: string): URL | undefined {
  if (!URL.canParse(baseUrl)) return;
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) return;
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return;
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  return url;
}

// Bound the *decoded* body, including chunked/compressed replies without Content-Length.
async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        return;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return;
  }
}

const upstreamError = z.object({
  error: z.object({ code: z.string().optional(), type: z.string().optional() }),
});

function gatewayError(status: number, body: unknown): string {
  let description = '网关请求失败';
  if (status === 401 || status === 403) description = '网关拒绝认证或授权';
  if (status === 429) description = '网关限流或额度不足';
  if (status >= 500) description = '网关服务错误';

  const parsed = upstreamError.safeParse(body);
  const code = parsed.success
    ? [parsed.data.error.code, parsed.data.error.type].find(item => item && safeErrorCodes.has(item))
    : undefined;
  return code ? `${description}（${code}）` : description;
}

// A native credential prompt may stay open even after the caller cancels.
export async function readUntilStopped(read: CredentialReader, reference: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(new Error('凭据读取已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return read(reference, signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** One authorized health check. Never probes /models, follows a redirect or retries. */
export async function validateGateway(
  config: GatewayConfig,
  readCredential: CredentialReader,
  signal?: AbortSignal,
): Promise<GatewayResult> {
  const started = performance.now();
  let httpStatus: number | null = null;
  const timing = () => ({ httpStatus, elapsedMs: Math.round(performance.now() - started) });
  const failure = (error: string): GatewayResult => ({ ok: false, error, ...timing() });

  const url = completionUrl(config.baseUrl);
  if (!url) return failure('Base URL 应为无账号、查询和片段的 HTTPS API 根路径，本机回环也可使用 HTTP');
  if (!config.model.trim() || !config.credentialRef.trim()) return failure('请配置模型 ID 和系统凭据引用');
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    return failure('超时须为正整数毫秒且不超过系统定时器上限');

  const timeout = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let readingCredential = true;
  try {
    stop.throwIfAborted();
    const credential = await readUntilStopped(readCredential, config.credentialRef, stop);
    stop.throwIfAborted();
    if (!credential || /[^\x21-\x7e]/u.test(credential)) return failure('系统凭据为空或无法用作 HTTP 凭据');
    readingCredential = false;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: `Reply with exactly ${acknowledgement} and nothing else.` }],
      }),
      redirect: 'manual',
      signal: stop,
    });

    httpStatus = response.status;
    if (httpStatus >= 300 && httpStatus < 400) {
      await response.body?.cancel();
      return failure('网关返回重定向，请核对 API 根路径');
    }
    const body = await readBody(response);
    if (!response.ok) return failure(gatewayError(httpStatus, body));
    const reply = replySchema.safeParse(body);
    if (!reply.success) return failure('网关响应缺少文本、JSON 无效或超出 64 KiB');
    const text = reply.data.choices[0]?.message.content.trim();
    if (text !== acknowledgement) return failure('网关响应未包含约定的公开回显，已隐藏正文');
    const usage = usageSchema.safeParse(reply.data.usage);
    if (usage.success && Object.values(usage.data).some(value => value !== undefined))
      return { ok: true, text, usage: usage.data, ...timing() };
    return { ok: true, text, ...timing() };
  } catch {
    if (signal?.aborted) return failure('验证已取消');
    if (timeout.aborted) return failure('验证超时');
    return failure(readingCredential ? '系统凭据读取失败，请检查引用和系统凭据存储' : '网关网络请求失败');
  }
}
