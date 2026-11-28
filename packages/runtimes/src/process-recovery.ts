import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/;
interface RecordData {
  id: string;
  pid: number;
  startedAtMs: number;
  executionId: string;
}

function directory(path: string) {
  const privateCliPath = /(?:^|[\\/])\.(?:claude|codex)(?:[\\/]|$)/i;
  if (!isAbsolute(path) || privateCliPath.test(path) || (existsSync(path) && !lstatSync(path).isDirectory()))
    throw new Error('无效的进程登记目录。');
  let ancestor = path;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const canonical = join(realpathSync(ancestor), ...missing);
  if (privateCliPath.test(canonical)) throw new Error('进程登记目录指向 CLI 私有目录。');
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  if (!lstatSync(canonical).isDirectory()) throw new Error('无法确认进程登记目录。');
  return canonical;
}
export function registerSupervisor(path: string, startedAtMs: number, executionId?: string) {
  const dir = directory(path);
  const id = randomUUID();
  const record: RecordData = { id, pid: process.pid, startedAtMs, executionId: executionId ?? id };
  if (typeof record.executionId !== 'string' || record.executionId.length > 200)
    throw new Error('执行编号无效。');
  const filename = join(dir, id + '.json');
  // The CLI cannot start before this complete record becomes visible.
  writeFileSync(filename + '.tmp', JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  renameSync(filename + '.tmp', filename);
  return {
    id,
    stopRequested: () => existsSync(join(dir, id + '.stop')),
  };
}

export function forgetSupervisor(dir: string, id: string) {
  if (!uuid.test(id)) return;
  for (const suffix of ['.json', '.stop']) rmSync(join(dir, id + suffix), { force: true });
}

function gone(record: RecordData) {
  if (process.platform === 'win32') {
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  try {
    process.kill(-record.pid, 0);
  } catch (err) {
    // Observation only, never send a signal to a saved PID.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
  // Container init may leave exited children as zombies. Check only PGID/state.
  const ps = spawnSync('/bin/ps', ['-A', '-o', 'pgid=', '-o', 'stat='], {
    shell: false,
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 1024 * 1024,
    env: { LC_ALL: 'C' },
  });
  if (ps.status !== 0) return false;
  return !ps.stdout.split('\n').some((line) => {
    const [pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === record.pid && !state?.startsWith('Z');
  });
}

/** Call after taking the application's exclusive data-directory lock. A live
 * owner uses its own identity to do the signalling. A dead owner never
 * authorizes killing a numeric PID that may now belong to another process. */
export async function startProcessRecovery(path: string) {
  const dir = directory(path);
  // Capture the exact launches present while the app owns the startup lock.
  // Later manual rechecks must never stop a healthy, newly launched task.
  const pending = new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((id) => uuid.test(id))
      .map((id) => [id, id]),
  );
  const recovered: string[] = [];
  const report = () => ({ recovered: [...recovered], unresolved: [...pending.values()] });
  let checking: Promise<ReturnType<typeof report>> | undefined;
  async function check() {
    await Promise.all(
      [...pending.keys()].map(async (id) => {
        let executionId = id;
        try {
          const filename = join(dir, id + '.json');
          const stat = lstatSync(filename);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error();
          const record = JSON.parse(readFileSync(filename, 'utf8')) as RecordData;
          if (
            record.id !== id ||
            !Number.isSafeInteger(record.pid) ||
            record.pid <= 1 ||
            !Number.isFinite(record.startedAtMs) ||
            record.startedAtMs <= 0 ||
            typeof record.executionId !== 'string'
          )
            throw new Error();
          executionId = record.executionId;
          // The random per-launch name is the control channel; PID reuse cannot
          // redirect this request. The supervisor also watches IPC disconnection.
          if (!existsSync(join(dir, id + '.stop')))
            writeFileSync(join(dir, id + '.stop'), '', { flag: 'wx', mode: 0o600 });
          const deadline = Date.now() + 4000;
          do {
            if (gone(record)) {
              // POSIX absence covers the entire group; Windows kernel releases the
              // kill-on-close job when the registered supervisor dies.
              forgetSupervisor(dir, id);
              pending.delete(id);
              recovered.push(executionId);
              return;
            }
            await delay(75);
          } while (Date.now() < deadline);
        } catch {
          /* Preserve ambiguous records for manual handling. */
        }
        pending.set(id, executionId);
      }),
    );
    return report();
  }
  function recheck() {
    checking ??= check().finally(() => {
      checking = undefined;
    });
    return checking;
  }
  await recheck();
  return { report, recheck };
}

export async function recoverProcessGroups(path: string) {
  return (await startProcessRecovery(path)).report();
}
