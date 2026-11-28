import type { ErrorKind } from './model-types.ts';

const codes: Readonly<Record<string, ErrorKind>> = {
  rate_limit_error:'rate_limit', rate_limit_exceeded:'rate_limit', rate_limit:'rate_limit', resource_exhausted:'rate_limit',
  insufficient_quota:'budget', insufficient_balance:'budget', billing_error:'budget', payment_required:'budget',
  authentication_error:'auth', invalid_api_key:'auth', unauthenticated:'auth', permission_denied:'auth', permission_error:'auth',
  server_error:'server', internal_error:'server', internal_server_error:'server', api_error:'server', overloaded_error:'server',
  server_is_overloaded:'server', unavailable:'server', internal:'server', deadline_exceeded:'timeout',
};
const descriptions: Partial<Record<ErrorKind,string>> = {
  rate_limit:'上游报告限流。', budget:'上游报告余额或配额不足。', auth:'上游拒绝认证或授权。',
  server:'上游服务错误。', timeout:'上游服务超时。',
};
export class StreamFailure extends Error {
  constructor(readonly kind: ErrorKind) { super(descriptions[kind] ?? '上游返回了未识别的错误。'); }
}

/** Read only enumerated protocol fields. Vendor messages may contain private data. */
export function throwUpstreamError(raw: unknown): never {
  const error = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const names = [error.code,error.type,error.status].filter((name): name is string => typeof name === 'string');
  for (const name of names) {
    const key = name.toLowerCase();
    if (Object.hasOwn(codes,key)) throw new StreamFailure(codes[key]);
  }
  const status = [error.code, error.status, error.status_code].find(value => typeof value === 'number');
  if (status === 401 || status === 403) throw new StreamFailure('auth');
  if (status === 402) throw new StreamFailure('budget');
  if (status === 429) throw new StreamFailure('rate_limit');
  if (typeof status === 'number' && status >= 500 && status <= 599) throw new StreamFailure('server');
  throw new StreamFailure('invalid');
}
