import { expect, it, vi } from 'vitest';
import { inspectCli } from '../src/cli.ts';
import { runProcess, type ProcessResult } from '../src/process.ts';

vi.mock('../src/process.ts', () => ({runProcess: vi.fn()}));
const visibleFlags = '--print --output-format --safe-mode --permission-mode --tools --disallowedTools --strict-mcp-config --no-session-persistence --settings';
const missingValue = "error: option '--max-turns <turns>' argument missing";
const options = {executable: process.execPath, cwd: process.cwd(), env: {}};

function mockHelp(flags: string, parserReply: ProcessResult, helpExit = 0) {
  const calls: string[][] = [];
  vi.mocked(runProcess).mockImplementation(async (_executable, argv) => {
    calls.push([...argv]);
    switch (argv.join(' ')) {
      case '--version': return {stdout:'2.1.332 (Claude Code)',stderr:'',exitCode:0};
      case '--help': return {stdout:flags,stderr:'',exitCode:helpExit};
      case '--help --max-turns': return parserReply;
      case 'auth status': return {stdout:'{"loggedIn":false,"authMethod":"none"}',stderr:'',exitCode:1};
      default: throw new Error('未预期的进程命令');
    }
  });
  return calls;
}

it.each(['\n','\r\n'])('识别公开帮助隐藏的回合上限，仅运行无提示文本的帮助解析探针 %j', async ending => {
  const calls = mockHelp(visibleFlags,{stdout:'',stderr:missingValue + ending,exitCode:1});
  const diagnostic = await inspectCli('claude',options);
  expect(calls).toEqual([['--version'],['--help'],['--help','--max-turns'],['auth','status']]);
  expect(diagnostic.login).toBe('未登录');
  expect(diagnostic.arguments[diagnostic.arguments.indexOf('--max-turns') + 1]).toBe('1');
});

it.each([
  {stdout:visibleFlags,stderr:'',exitCode:0},
  {stdout:'',stderr:"error: unknown option '--max-turns'",exitCode:1},
  {stdout:'',stderr:missingValue,exitCode:2},
  {stdout:'',stderr:missingValue + '\nextra',exitCode:1},
  {stdout:'extra',stderr:missingValue,exitCode:1},
])('不认识的参数、错误或不完整的解析结果都停止预检', async reply => {
  const calls = mockHelp(visibleFlags,reply);
  await expect(inspectCli('claude',options)).rejects.toThrow(/--max-turns/);
  expect(calls).toEqual([['--version'],['--help'],['--help','--max-turns']]);
});

it.each([
  {flags:visibleFlags.replace('--safe-mode',''),helpExit:0},
  {flags:visibleFlags,helpExit:1},
])('缺少其它必要标志或根帮助失败时，额外探针不能替代权限检查', async ({flags,helpExit}) => {
  const calls = mockHelp(flags,{stdout:'',stderr:missingValue,exitCode:1},helpExit);
  await expect(inspectCli('claude',options)).rejects.toThrow(/校验所需参数/);
  expect(calls).toEqual([['--version'],['--help']]);
});
