import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Build only test .exe files using the .NET Framework compiler in the Windows image. */
export async function compileWindowsFixture(source: URL, executable: string) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Windows 测试需要系统的 SystemRoot。');
  const compiler = ['Framework64', 'Framework']
    .map(folder => join(systemRoot, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'))
    .find(path => existsSync(path));
  if (!compiler) throw new Error('Windows 测试夹具需要系统 .NET Framework 4.x 的 csc.exe。');

  const cwd = dirname(executable);
  await execute(compiler, ['/nologo', '/target:exe', '/out:' + executable, fileURLToPath(source)], {
    cwd, windowsHide: true, shell: false,
    env: { SystemRoot: systemRoot, PATH: join(systemRoot, 'System32'), TEMP: cwd, TMP: cwd },
  });
}
