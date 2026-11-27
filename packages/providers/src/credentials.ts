const service = 'Concordia';
const namespace = 'keychain:';

export function isCredentialReference(value: string): boolean {
  return /^keychain:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

/** Only these messages may leave the backend. Native errors can contain private data. */
export class CredentialError extends Error {}

function account(reference: string): string {
  if (!isCredentialReference(reference)) {
    throw new CredentialError('凭据引用格式无效。请使用 keychain:连接标识。');
  }
  return reference.slice(namespace.length);
}

async function openEntry(id: string) {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  // This option is ignored on Windows and macOS. On Linux it disables keyutils fallback.
  return new AsyncEntry(service, id, { linux: { store: 'secret-service' } });
}

function storeError(): CredentialError {
  return new CredentialError('无法访问系统凭据存储。请检查当前登录会话和钥匙串解锁状态。');
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CredentialError('凭据读取已取消。');
}

export async function readCredential(reference: string, signal?: AbortSignal): Promise<string> {
  const id = account(reference);
  checkCancelled(signal);
  let value: string | null;
  try {
    const entry = await openEntry(id);
    checkCancelled(signal);
    value = await entry.getPassword(signal);
  } catch {
    checkCancelled(signal);
    throw storeError();
  }
  // A native unlock prompt can outlive cancellation. Discard its late result.
  checkCancelled(signal);
  if (!value) throw new CredentialError('系统凭据存储中没有这个条目。请先运行 pnpm credential:set。');
  return value;
}

export async function storeCredential(reference: string, value: string): Promise<void> {
  const id = account(reference);
  if (!/^[!-~]+$/u.test(value)) {
    throw new CredentialError('网关密钥须为非空可见 ASCII 字符，且不含空格或换行。');
  }
  try {
    const entry = await openEntry(id);
    await entry.setPassword(value);
  } catch {
    throw storeError();
  }
}
