import { useCallback, useEffect, useRef, useState } from 'react';

export function browserFetch(path: string, options: RequestInit = {}) {
  if (!path.startsWith('/api/')) throw new Error('无效的本地 API 路径。');
  const headers = new Headers(options.headers);
  const proof = window.localStorage.getItem('concordia.session');
  if (proof) headers.set('x-concordia-session', proof);
  return fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
}

let activeWorkspace: string | undefined;
export function setActiveWorkspace(id: string | undefined) {
  activeWorkspace = id;
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await browserFetch('/api/' + path, {
    method,
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(method !== 'GET' && activeWorkspace && { 'x-concordia-workspace': activeWorkspace }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const message =
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : response.status === 401
          ? '请使用终端本次启动时的链接重新打开。'
          : '请求失败，请检查本地服务。';
    throw new Error(message + '（HTTP ' + response.status + '）');
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
  return response.json() as Promise<T>;
}

export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const next = await api<T>(path);
      if (id === sequence.current) {
        setData(next);
        setError('');
      }
    } catch (error) {
      if (id === sequence.current) setError(error instanceof Error ? error.message : '无法读取数据。');
    }
  }, [path]);
  useEffect(() => {
    void reload();
    return () => {
      ++sequence.current;
    };
  }, [reload]);
  return { data, error, reload };
}

export function useAction() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (work: () => Promise<void>, success = '') => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      setMessage(success);
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'AbortError'
          ? '验证已取消。'
          : err instanceof Error
            ? err.message
            : '操作失败，请重试。',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, message, error, run };
}
