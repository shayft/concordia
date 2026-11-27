import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, level, mode] = process.argv.slice(2);
const depth = Number(level);
const signal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM';
const leafReady = join(directory, 'leaf-ready');
process.on(signal, () => {
  appendFileSync(join(directory, 'stopping'), level + '\n');
  if (depth !== 2) process.exit(0);
});
writeFileSync(join(directory, 'pid-' + level), String(process.pid));
if (depth < 2) {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), directory, String(depth + 1), mode,
  ], { stdio: 'ignore', shell: false });
  child.unref();
} else {
  writeFileSync(leafReady, '');
}
setInterval(() => {
  if (mode === 'early' && depth === 0 && existsSync(leafReady)) process.exit(23);
}, 15);
