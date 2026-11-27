import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileWindowsFixture } from './compile-windows.ts';

export async function installFakeClis() {
  const windows = process.platform === 'win32';
  const directory = await mkdtemp(join(tmpdir(), 'concordia-fake-cli-'));
  const cwd = join(directory, 'working dir');
  const executable = (name: string) => join(directory, windows ? name + '.exe' : name);
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await mkdir(cwd);
    let env: NodeJS.ProcessEnv;
    if (windows) {
      await compileWindowsFixture(new URL('./FakeCli.cs', import.meta.url), executable('claude'));
      await copyFile(executable('claude'), executable('codex'));
      const systemRoot = process.env.SystemRoot!;
      env = { SystemRoot: systemRoot, PATH: join(systemRoot, 'System32'), TEMP: directory, TMP: directory };
    } else {
      const node = await realpath(process.execPath);
      const fixture = await readFile(new URL('./fake-cli.cjs', import.meta.url), 'utf8');
      for (const kind of ['claude', 'codex']) {
        await writeFile(executable(kind), '#!' + node + '\n' + fixture, { mode: 0o700 });
      }
      env = { TMPDIR: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    }
    env.UNLISTED_DEMO = 'omit';
    return { directory, cwd, executable, env, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
