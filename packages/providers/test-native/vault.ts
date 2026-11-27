import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialError, readCredential, storeCredential } from '../src/credentials.ts';

const backend = { linux: 'Secret Service', darwin: 'macOS Keychain', win32: 'Windows Credential Manager' };
let phase = 'runner';

async function verify() {
  phase = '加载原生后端';
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const id = 'ci-native-probe-' + randomUUID();
  const reference = 'keychain:' + id;
  // The application exposes read/write. Only cleanup uses the binding directly.
  const entry = new AsyncEntry('Concordia', id, { linux: { store: 'secret-service' } });
  phase = '确认新条目不存在';
  if (await entry.getPassword() !== null) throw new Error();

  async function cleanFailedWrite() {
    const failedPhase = phase;
    phase = '清理本次生成的条目';
    await entry.deleteCredential();
    if (await entry.getPassword() !== null) throw new Error();
    phase = failedPhase;
  }

  let removed = false;
  try {
    const value = randomBytes(32).toString('base64url');
    phase = '写入';
    await storeCredential(reference, value);
    phase = '读回并比对';
    if (await readCredential(reference) !== value) throw new Error();

    phase = '删除';
    if (!await entry.deleteCredential()) throw new Error();
    removed = true;
    phase = '从原生后端确认删除';
    if (await entry.getPassword() !== null) throw new Error();
    phase = '从应用确认缺失';
    try {
      await readCredential(reference);
    } catch (error) {
      if (error instanceof CredentialError && error.message.startsWith('系统凭据存储中没有这个条目。')) return;
      throw error;
    }
    throw new Error();
  } finally {
    // A write can succeed at the OS level before the caller sees an error.
    if (!removed) await cleanFailedWrite();
  }
}

async function linuxSession() {
  phase = '创建 Linux 临时会话';
  const root = await mkdtemp(join(tmpdir(), 'concordia-native-vault-'));
  try {
    const env = { ...process.env };
    for (const [key, name] of Object.entries({
      XDG_RUNTIME_DIR: 'runtime', XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache',
    })) {
      env[key] = join(root, name);
      await mkdir(env[key], { mode: 0o700 });
    }
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE',
      'GNOME_KEYRING_CONTROL', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[key];
    phase = '运行独立 D-Bus 会话';
    const child = spawnSync('/usr/bin/dbus-run-session', [
      '--', process.execPath, fileURLToPath(import.meta.url), '--linux-private-session',
    ], { shell: false, env, stdio: ['ignore', 'inherit', 'ignore'], timeout: 90_000 });
    if (child.status !== 0) throw new Error();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function unlockLinuxKeyring() {
  phase = '解锁本次会话的 GNOME Keyring';
  const passphrase = Buffer.from(randomBytes(32).toString('hex'), 'ascii');
  try {
    // GNOME reads --unlock from stdin until EOF. Do not let the daemon inherit output pipes.
    const result = spawnSync('/usr/bin/gnome-keyring-daemon', ['--unlock', '--components=secrets', '--daemonize'], {
      input: passphrase, shell: false, stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000,
    });
    if (result.status !== 0) throw new Error();
  } finally {
    passphrase.fill(0);
  }
}

async function main() {
  const arg = process.argv.slice(2);
  if (arg.length === 1 && arg[0] === '--help') {
    console.log('node packages/providers/test-native/vault.ts — 在 GitHub 托管运行器验证原生凭据写入、读回和删除。');
    return;
  }
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    console.log('需要 GitHub 托管运行器的临时用户会话。');
    throw new Error();
  }
  const os = process.platform;
  if (os !== 'linux' && os !== 'win32' && os !== 'darwin') throw new Error();
  if (os === 'linux' && arg.length === 0) {
    await linuxSession();
    return;
  }
  if (os === 'linux' && arg.length === 1 && arg[0] === '--linux-private-session') unlockLinuxKeyring();
  else if (arg.length !== 0) throw new Error();

  const timer = setTimeout(() => {
    console.log('原生凭据验证超时，阶段：' + phase);
    process.exit(1);
  }, 60_000);
  try {
    await verify();
    console.log(backend[os] + '：应用已写入并读回相同值，原生及应用两侧均已确认删除。');
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => {
  // Native errors, returned data and account names must never reach job logs.
  console.log('原生凭据未通过验证，阶段：' + phase);
  process.exitCode = 1;
});
