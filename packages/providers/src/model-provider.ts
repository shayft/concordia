import { StreamFailure } from './upstream-error.ts';
import { readCredential, isCredentialReference } from './credentials.ts';
import { readUntilStopped } from './gateway.ts';
import { responsesBody, responsesEvents } from './responses.ts';
import { geminiBody, geminiEvents } from './gemini.ts';
import { anthropicBody, anthropicEvents } from './anthropic.ts';
import { chatBody, chatEvents } from './chat-completions.ts';
import type {
  CredentialReader,
  ErrorKind,
  ModelEvent,
  ModelFailure,
  ModelMessage,
  ModelProvider,
  ModelUsage,
  ModelTool,
  ProviderConfig,
  StreamOptions,
} from './model-types.ts';

const owned = new Set([
  'model',
  'messages',
  'input',
  'contents',
  'system',
  'systemInstruction',
  'tools',
  'functions',
  'function_call',
  'tool_choice',
  'toolConfig',
  'stream',
  'stream_options',
  'n',
  'candidateCount',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'generationConfig',
  'previous_response_id',
  'conversation',
  'background',
  'store',
  'prompt',
  'container',
  'service_tier',
  'tool_resources',
  'web_search_options',
  'mcp_servers',
]);
function requestUrl(config: ProviderConfig, path: string) {
  const root = new URL(config.baseUrl);
  if (
    root.username ||
    root.password ||
    root.hash ||
    root.search ||
    !(
      root.protocol === 'https:' ||
      (root.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname))
    )
  ) {
    throw new Error('invalid base url');
  }
  const endpoint = config.endpoint ?? path;
  // Treat an endpoint as a path only. Never move credentials to a new authority.
  if (
    !endpoint ||
    /[\\?#]/.test(endpoint) ||
    endpoint.startsWith('//') ||
    /^\w+:/.test(endpoint) ||
    endpoint.split('/').some((p) => ['.', '..'].includes(decodeURIComponent(p)))
  )
    throw new Error('invalid endpoint');
  root.pathname = root.pathname.replace(/\/+$/, '') + '/' + endpoint.replace(/^\/+/, '');
  return root;
}
function failure(kind: ErrorKind, message: string, httpStatus?: number): ModelFailure {
  return { type: 'error', kind, message, ...(httpStatus === undefined ? {} : { httpStatus }) };
}
function statusError(status: number) {
  if (status === 401 || status === 403) return failure('auth', '上游拒绝认证或授权。', status);
  if (status === 402) return failure('budget', '上游报告付款或余额问题。', status);
  if (status === 429) return failure('rate_limit', '上游限流或额度不足。', status);
  if (status >= 500) return failure('server', '上游服务错误。', status);
  return failure(
    'invalid',
    status >= 300 && status < 400 ? '网关返回重定向，请核对端点。' : '上游拒绝该请求。',
    status,
  );
}

function headersFor(config: ProviderConfig) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    // Persist only non-secret metadata in the connection. Auth always uses a vault reference.
    if (
      !/^x-[a-z\d-]+$/i.test(name) ||
      /key|token|auth|credential|secret|cookie|forwarded|url|host/i.test(name)
    )
      throw new Error('reserved header');
    headers.set(name, value);
  }
  return headers;
}

class OutputFilter {
  private tail = '';
  constructor(private secrets: string[]) {}
  // Retain only suffixes that could join the next delta to reveal the credential.
  text(delta: string, final = false): string {
    let value = this.tail + delta;
    for (const secret of this.secrets) value = value.replaceAll(secret, '[已脱敏]');
    this.tail = '';
    if (!final) {
      let retained = 0;
      for (const secret of this.secrets) {
        for (let n = Math.min(secret.length - 1, value.length); n > retained; n--) {
          if (value.endsWith(secret.slice(0, n))) {
            retained = n;
            break;
          }
        }
      }
      if (retained) {
        this.tail = value.slice(-retained);
        value = value.slice(0, -retained);
      }
    }
    return value;
  }
}

export function createModelProvider(
  config: ProviderConfig,
  read: CredentialReader = readCredential,
): ModelProvider {
  const chatContinuations = new WeakMap<ModelMessage, string>();
  async function* stream(
    messages: ModelMessage[],
    tools: ModelTool[] = [],
    options: StreamOptions = {},
    reportStatus?: (status: number) => void,
  ): AsyncGenerator<ModelEvent> {
    let problem = failure('invalid', '连接参数、消息、工具或上下文大小无效。');
    let timeout: AbortSignal | undefined;
    const cleanup = new AbortController();
    try {
      const timeoutMs = config.timeoutMs ?? 60_000;
      const outputTokens = config.maxOutputTokens ?? 1024;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 1 ||
        outputTokens > 65_536 ||
        !config.model.trim() ||
        !messages.length ||
        Object.keys(config.params ?? {}).some((k) => owned.has(k))
      )
        throw new Error('config');
      const useStream = options.stream ?? config.stream ?? true;
      const adapters = {
        'chat-completions': { path: 'chat/completions', body: chatBody, events: chatEvents },
        responses: { path: 'responses', body: responsesBody, events: responsesEvents },
        gemini: {
          path:
            'models/' +
            encodeURIComponent(config.model.replace(/^models\//, '')) +
            ':' +
            (useStream ? 'streamGenerateContent' : 'generateContent'),
          body: geminiBody,
          events: geminiEvents,
        },
        anthropic: { path: 'messages', body: anthropicBody, events: anthropicEvents },
      };
      const adapter = adapters[config.protocol];
      if (!adapter) throw new Error('protocol');
      const url = requestUrl(config, adapter.path);
      if (config.protocol === 'gemini' && useStream) url.searchParams.set('alt', 'sse');
      const body = JSON.stringify(adapter.body(config, messages, tools, useStream, chatContinuations));
      if (Buffer.byteLength(body) > 128 * 1024) throw new Error('input size');
      const headers = headersFor(config);
      timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any(
        options.signal ? [options.signal, timeout, cleanup.signal] : [timeout, cleanup.signal],
      );
      signal.throwIfAborted();
      const secrets: string[] = [];
      async function secret(ref: string) {
        if (!isCredentialReference(ref)) throw new Error('ref');
        problem = failure('auth', '无法读取或使用系统凭据。');
        const result = await readUntilStopped(read, ref, signal);
        if (!/^[!-~]{1,4096}$/u.test(result)) throw new Error('credential');
        secrets.push(result);
        return result;
      }
      const refs = Object.entries(config.headerRefs ?? {});
      if (refs.length > 16) throw new Error('too many headers');
      for (const [name, ref] of refs) {
        if (
          !/^x-[a-z\d-]+$/i.test(name) ||
          /forwarded|host|url/i.test(name) ||
          ['x-api-key', 'x-goog-api-key'].includes(name.toLowerCase()) ||
          headers.has(name)
        )
          throw new Error('header');
        headers.set(name, await secret(ref));
      }
      if (config.protocol === 'anthropic') headers.set('anthropic-version', '2023-06-01');
      if (config.credentialRef !== undefined) {
        const value = await secret(config.credentialRef);
        if (config.protocol === 'gemini') headers.set('x-goog-api-key', value);
        else if (config.protocol === 'anthropic') headers.set('x-api-key', value);
        else headers.set('Authorization', 'Bearer ' + value);
      }
      signal.throwIfAborted();
      problem = failure('transport', '网关网络请求失败。');
      const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal });
      reportStatus?.(response.status);
      if (!response.ok) {
        yield statusError(response.status);
        return;
      }
      problem = failure('invalid', '上游响应无效、不完整或超过 2 MiB。', response.status);
      const filter = new OutputFilter(secrets);
      const pending: ModelEvent[] = [];
      const seen = new Set<string>();
      let hasOutput = false;
      const rememberReasoning = (content: string) => {
        if (tools.length && options.assistantReply) chatContinuations.set(options.assistantReply, content);
      };
      for await (const event of adapter.events(response, useStream, rememberReasoning)) {
        if (event.type === 'text_delta') {
          hasOutput ||= event.text.length > 0;
          const text = filter.text(event.text);
          if (text) yield { type: 'text_delta', text };
        } else if (event.type === 'action') {
          if (
            seen.has(event.id) ||
            !tools.some((t) => t.name === event.name) ||
            secrets.some((key) => JSON.stringify(event).includes(JSON.stringify(key).slice(1, -1)))
          )
            throw new Error('tool call');
          seen.add(event.id);
          hasOutput = true;
          // Commit tool actions only after the entire upstream turn is valid.
          pending.push(event);
        } else yield event;
      }
      signal.throwIfAborted();
      if (!hasOutput) throw new Error('empty response');
      const tail = filter.text('', true);
      if (tail) yield { type: 'text_delta', text: tail };
      yield* pending;
      yield { type: 'completed' };
    } catch (error) {
      if (options.signal?.aborted) yield failure('cancelled', '请求已取消。');
      else if (timeout?.aborted) yield failure('timeout', '请求已超时。');
      else if (error instanceof StreamFailure) yield failure(error.kind, error.message, problem.httpStatus);
      else yield problem;
    } finally {
      cleanup.abort();
    }
  }
  return {
    stream,
    getCapabilities: () => ({ nativeTools: true, streaming: true }),
    async validateConnection(signal) {
      let reply = '';
      let httpStatus: number | undefined;
      let usage: ModelUsage | undefined;
      for await (const event of stream(
        [{ role: 'user', content: 'Reply with exactly CONCORDIA_OK.' }],
        [],
        { stream: false, signal },
        status => { httpStatus = status; },
      )) {
        if (event.type === 'text_delta') reply += event.text;
        if (event.type === 'usage') {
          usage ??= {};
          if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
          if (event.totalTokens !== undefined) usage.totalTokens = event.totalTokens;
        }
        if (event.type === 'error') return { ok: false, error: event, httpStatus, ...(usage && { usage }) };
      }
      return reply.trim() === 'CONCORDIA_OK'
        ? { ok: true, text: 'CONCORDIA_OK', httpStatus, ...(usage && { usage }) }
        : {
            ok: false,
            httpStatus,
            error: failure('invalid', '网关返回的文本与公开校验短句不匹配。', httpStatus),
            ...(usage && { usage }),
          };
    },
  };
}
