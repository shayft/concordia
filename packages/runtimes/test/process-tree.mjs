import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, level, mode] = process.argv.slice(2);
const depth = Number(level);
const signal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM';
const stopped = level => join(directory, 'stopped-' + level);
let stopping = false;
process.on(signal, () => {
  writeFileSync(stopped(depth), signal);
  stopping = true;
});
writeFileSync(join(directory, 'pid-' + level), String(process.pid));
if (depth < 2) {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), directory, String(depth + 1), mode,
  ], { stdio: 'ignore', shell: false });
  child.unref();
} else {
  writeFileSync(join(directory, 'leaf-ready'), '');
}
setInterval(() => {
  if (mode === 'early' && depth === 0 && existsSync(join(directory, 'release-root'))) process.exit(23);
  // On Windows each Node parent owns a libuv job for its ordinary children.
  // Let all deeper handlers record the broadcast before a parent's normal exit.
  if (stopping && depth < 2 && existsSync(stopped(depth + 1)) && existsSync(stopped(2))) process.exit(0);
}, 15);
