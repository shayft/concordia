// Executed by the same Node LTS binary as the verifier (native TS stripping).
// The IPC channel belongs to Concordia. The CLI only inherits stdout and stderr.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { registerSupervisor } from './process-recovery.ts';

async function supervise() {
  const windows = process.platform === 'win32';
  let requestExit: () => void;
  if (windows) {
    const { ownWindowsJob } = await import('./windows-job.ts');
    requestExit = ownWindowsJob();
  } else {
    process.on('SIGTERM', () => {});
    requestExit = () => process.kill(-process.pid, 'SIGTERM');
  }
  let record: ReturnType<typeof registerSupervisor> | undefined;
  let started = false;
  let stopping = false;
  function stop(graceMs: number) {
    if (stopping) return;
    stopping = true;
    requestExit();
    setTimeout(() => {
      const finish = () => {
        if (windows)
          process.exit(0); // Kernel closes the sole job handle.
        else process.kill(-process.pid, 'SIGKILL'); // Still the live group owner.
      };
      if (process.connected) process.send?.({ type: 'retiring' }, finish);
      else finish();
    }, graceMs);
  }
  process.on(
    'message',
    (message: {
      type?: string;
      executable: string;
      args: string[];
      stdin?: string;
      recoveryDir?: string;
      executionId?: string;
      env: NodeJS.ProcessEnv;
      graceMs: number;
    }) => {
      if (message.type === 'stop') {
        stop(message.graceMs);
      } else if (message.type === 'start' && !started && !stopping) {
        started = true;
        try {
          if (message.recoveryDir) {
            record = registerSupervisor(message.recoveryDir, performance.timeOrigin, message.executionId);
            process.send?.({ type: 'registered', id: record.id }, () => {});
            setInterval(() => {
              if (record?.stopRequested()) stop(300);
            }, 75).unref();
          }
          const child = spawn(message.executable, message.args, {
            env: message.env,
            shell: false,
            stdio: [message.stdin === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
          });
          if (child.stdin) {
            child.stdin.on('error', () => {}); // A CLI may exit before consuming its input.
            child.stdin.end(message.stdin);
          }
          child.on('error', () => {
            if (process.connected) process.send?.({ type: 'failed' }, () => {});
          });
          child.on('exit', (code) => {
            if (process.connected) process.send?.({ type: 'finished', code }, () => {});
          });
        } catch {
          if (process.connected) process.send?.({ type: 'failed' }, () => {});
        }
      }
    },
  );
  process.once('disconnect', () => stop(300));
  process.send?.({ type: 'ready', pid: process.pid, startedAtMs: performance.timeOrigin }, () => {});
}

supervise().catch(() => {
  if (process.connected) process.send?.({ type: 'failed' }, () => process.exit(1));
  else process.exit(1);
});
