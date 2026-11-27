import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ProcessGroup {
  pid: number;
  startedAtMs: number;
}

const groups = new Set<ProcessGroup>();
const supervisorFile = fileURLToPath(new URL('./process-supervisor.ts', import.meta.url));

/** Live, in-memory observations of group owners. Never signal a recorded PID. */
export function activeProcessGroups(): ReadonlyArray<ProcessGroup> {
  return Array.from(groups, group => ({ ...group }));
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`进程选项 ${name} 超出允许范围`);
  }
  return value;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const timeout = positiveInteger(options.timeoutMs ?? 30_000, 'timeoutMs');
  const graceMs = positiveInteger(options.graceMs ?? 300, 'graceMs');
  const limit = positiveInteger(options.maxOutputBytes ?? 1024 * 1024, 'maxOutputBytes');
  if (options.signal?.aborted) throw new Error('进程运行已取消');
  // The trusted supervisor holds the group ID / job handle through cleanup.
  // Caller-controlled Node options belong only to the target CLI environment.
  const bootstrapEnv: NodeJS.ProcessEnv = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  const child = spawn(process.execPath, [supervisorFile], {
    detached: true,
    shell: false,
    windowsHide: true,
    cwd: options.cwd,
    env: bootstrapEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let group: ProcessGroup | undefined;
    let stopping = false;
    let retiring = false;
    let targetExit: number | null | undefined;

    function stop(reason?: string) {
      if (reason) failure ??= new Error(reason);
      if (stopping) return;
      stopping = true;
      if (!group) {
        // Before the ready/start handshake, the supervisor has spawned no CLI.
        child.kill('SIGKILL');
      } else if (child.connected) {
        child.send({ type: 'stop', graceMs }, err => {
          // Closing the channel triggers the same cleanup inside the owner.
          if (err && child.connected) child.disconnect();
        });
      }
    }
    const abort = () => stop('进程运行已取消');
    const deadline = setTimeout(() => stop('进程运行超时'), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    function capture(chunk: Buffer, output: Buffer[]) {
      bytes += chunk.length;
      if (bytes > limit) stop('进程输出超过限制');
      else output.push(chunk);
    }
    child.stdout!.on('data', (chunk: Buffer) => capture(chunk, stdout));
    child.stderr!.on('data', (chunk: Buffer) => capture(chunk, stderr));
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      switch (message.type) {
        case 'ready':
          if (stopping || group || !child.pid) return;
          if (!('pid' in message) || message.pid !== child.pid || !('startedAtMs' in message)
            || typeof message.startedAtMs !== 'number' || !Number.isFinite(message.startedAtMs)) {
            stop('无法确认受控进程身份');
            return;
          }
          group = { pid: child.pid, startedAtMs: message.startedAtMs };
          groups.add(group);
          child.send({ type: 'start', executable, args, env: options.env ?? bootstrapEnv }, err => {
            if (err) stop('无法启动受控进程');
          });
          break;
        case 'finished':
          if ('code' in message && (message.code === null || typeof message.code === 'number')) {
            targetExit = message.code;
            clearTimeout(deadline);
            // Also retire any helpers still alive after a normal CLI return.
            stop();
          }
          break;
        case 'retiring':
          retiring = true;
          break;
        case 'failed':
          stop('无法启动受控进程，请检查可执行文件及进程隔离支持');
          break;
      }
    });
    child.on('error', () => stop('无法启动受控进程，请检查工作目录和执行权限'));
    child.on('exit', () => {
      if (group) groups.delete(group);
      if (group && !retiring) {
        // A lost owner cannot prove this numeric PGID still belongs to us.
        // Close our pipes even if an orphan still holds its write ends.
        failure = new Error('进程组管理器提前退出，无法确认清理结果');
        child.stdout!.destroy();
        child.stderr!.destroy();
      }
    });
    child.on('close', () => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      if (failure || targetExit === undefined) {
        reject(failure ?? new Error('受控进程意外退出'));
      } else {
        resolve({
          exitCode: targetExit,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      }
    });
  });
}
