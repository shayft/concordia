import { spawnSync } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileWindowsFixture } from '../../../../packages/runtimes/test/fixtures/compile-windows.ts';

export async function installHoldingCodex(dir: string, mode: 'agent' | 'planner') {
  if (process.platform === 'win32') {
    const exe = join(dir, mode === 'planner' ? 'planning-codex.exe' : 'codex.exe');
    await compileWindowsFixture(new URL('./crash-cli.cs', import.meta.url), exe);
    return exe;
  }
  const exe = join(dir, 'codex.mjs');
  const standard = new URL('../../../../packages/runtimes/test/fixtures/agent-cli.mjs', import.meta.url).href;
  const source = [
    '#!' + (await realpath(process.execPath)),
    "import {spawn} from 'node:child_process';",
    "import {writeFileSync} from 'node:fs';",
    "import {setTimeout as delay} from 'node:timers/promises';",
    'const args=process.argv.slice(2);',
    "const helper=args[0]==='--hold';",
    "const executing = args.includes('exec') && !args.includes('--help');",
    "const planning = " + JSON.stringify(mode === 'planner') + " && executing;",
    "if(planning){if(!args.includes('read-only') || process.env.CONCORDIA_MCP_TOKEN) process.exit(4); await import('node:stream/consumers').then(m=>m.text(process.stdin));}",
    "if(!helper && !planning){process.argv.splice(2,0,'codex');await import(" + JSON.stringify(standard) + ');}',
    "if(helper || executing) {",
    '  const level=helper ? Number(args[1]) : 0;',
    "  process.on('SIGTERM',()=>{});",
    "  writeFileSync(new URL('pid-'+level,import.meta.url),String(process.pid));",
    "  if(level<2) spawn(process.execPath,[process.argv[1],'--hold',String(level+1)],{shell:false,stdio:'ignore'});",
    '  await delay(120000);',
    '}',
  ].join('\n');
  await writeFile(exe, source, { flag: 'wx', mode: 0o700 });
  return exe;
}

export function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'win32') return true;
  // Some Linux containers retain dead children in PID 1's process table until shutdown.
  const seen = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { shell: false, encoding: 'utf8' });
  if (seen.status === 1 && !seen.stdout.trim()) return false;
  if (seen.status !== 0) throw new Error('无法确认测试进程状态');
  return !seen.stdout.trim().startsWith('Z');
}
