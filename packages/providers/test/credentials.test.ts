import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isCredentialReference, readCredential, storeCredential } from '../src/credentials.js';

const store = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn<(signal?: AbortSignal) => Promise<string | null>>(),
  write: vi.fn<(value: string) => Promise<void>>(),
}));

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) { store.open(...args); }
    getPassword = store.read;
    setPassword = store.write;
  },
}));

const reference = 'keychain:my_openai_gateway';

describe('系统凭据引用', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('以同一服务、条目和固定的系统存储读取和写入', async () => {
    const marker = randomUUID();
    store.read.mockResolvedValue(marker);
    await storeCredential(reference, marker);
    expect(store.write).toHaveBeenCalledWith(marker);
    expect(await readCredential(reference)).toBe(marker);
    expect(store.open.mock.calls).toEqual(Array(2).fill([
      'Concordia', 'my_openai_gateway', { linux: { store: 'secret-service' } },
    ]));
  });

  it('在打开系统存储前拒绝无效引用和非法输入', async () => {
    expect(isCredentialReference(reference)).toBe(true);
    for (const invalid of ['keychain:', 'wrong:ref', 'keychain:a/b', 'keychain:a\nb']) {
      await expect(readCredential(invalid)).rejects.toThrow('引用格式无效');
    }
    for (const invalid of ['', 'a b', '\r\n']) {
      await expect(storeCredential(reference, invalid)).rejects.toThrow('非空可见');
    }
    expect(store.open).not.toHaveBeenCalled();
  });

  it('条目缺失或后端不可用时只给出固定诊断', async () => {
    store.read.mockResolvedValueOnce(null);
    await expect(readCredential(reference)).rejects.toThrow('没有这个条目');
    store.read.mockRejectedValueOnce(new Error(randomUUID()));
    await expect(readCredential(reference)).rejects.toThrow(/^无法访问系统凭据存储。请检查当前登录会话和钥匙串解锁状态。$/u);
    store.write.mockRejectedValueOnce(new Error(randomUUID()));
    await expect(storeCredential(reference, randomUUID())).rejects.toThrow(/^无法访问系统凭据存储。请检查当前登录会话和钥匙串解锁状态。$/u);
  });

  it('取消后忽略系统解锁返回的结果', async () => {
    const controller = new AbortController();
    store.read.mockImplementationOnce(async (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return randomUUID();
    });
    await expect(readCredential(reference, controller.signal)).rejects.toThrow('已取消');
    await expect(readCredential(reference, controller.signal)).rejects.toThrow('已取消');
    expect(store.open).toHaveBeenCalledTimes(1);
  });
});
