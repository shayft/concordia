import { beforeEach, expect, it, vi } from 'vitest';
import { inspectCli, runCliProbe } from '../src/cli.ts';
import { nativeErrorCategory } from '../src/errors.ts';
import { parseProbeOutput } from '../src/output.ts';
import { runProcess } from '../src/process.ts';

vi.mock('../src/process.ts', () => ({ runProcess: vi.fn() }));

const flags = '--no-daemon --disable --ask-for-approval --sandbox --ephemeral --skip-git-repo-check --json';
const options = { executable: process.execPath, cwd: process.cwd(), env: {} };
let help: string;
let mcp: string;
let activeShell: boolean;
let login: string;
let exitCode: number;
let modelCalls: number;

beforeEach(() => {
  help = flags;
  mcp = '[]';
  activeShell = false;
  login = 'Logged in using ChatGPT';
  exitCode = 1;
  modelCalls = 0;
  vi.mocked(runProcess).mockImplementation(async (_file, args) => {
    if (args.includes('--version')) return { stdout: 'codex-cli 1.2.3', stderr: '', exitCode: 0 };
    if (args.includes('--help')) return { stdout: help, stderr: '', exitCode: 0 };
    if (args.includes('features')) {
      const rows = args.flatMap((arg, i) => {
        if (arg !== '--disable') return [];
        const feature = args[i + 1];
        return [feature + '  stable  ' + (feature === 'shell_tool' && activeShell)];
      });
      return { stdout: rows.join('\n'), stderr: '', exitCode: 0 };
    }
    if (args.includes('mcp')) return { stdout: mcp, stderr: '', exitCode: 0 };
    if (args.includes('status')) return { stdout: '', stderr: login, exitCode: login === 'Not logged in' ? 1 : 0 };
    modelCalls++;
    return { stdout: 'discard-me', stderr: 'discard-me', exitCode };
  });
});

it('缺少只读选项时停止并仅显示已知参数名', async () => {
  help = '--json\ndiscard-me';
  const probe = inspectCli('codex', options);
  await expect(probe).rejects.toThrow(/--sandbox/);
  await expect(probe).rejects.not.toThrow(/discard-me/);
  expect(modelCalls).toBe(0);
});

it('能识别选项但工具仍然开启时停止', async () => {
  activeShell = true;
  await expect(inspectCli('codex', options)).rejects.toThrow(/限制/);
  expect(modelCalls).toBe(0);
});

it('受管 MCP 配置仍生效时停止，不回显其内容', async () => {
  mcp = '[{"name":"discard-me"}]';
  const probe = inspectCli('codex', options);
  await expect(probe).rejects.toThrow(/MCP/);
  await expect(probe).rejects.not.toThrow(/discard-me/);
  expect(modelCalls).toBe(0);
});

it('未登录时仅探测，不开始模型调用', async () => {
  login = 'Not logged in';
  const { inspectionId } = await inspectCli('codex', options);
  await expect(runCliProbe('codex', { ...options, approved: true, inspectionId })).rejects.toThrow(/未登录/);
  expect(modelCalls).toBe(0);
});

it('调用失败仅保留退出码，只调用一次', async () => {
  exitCode = 3;
  const { inspectionId } = await inspectCli('codex', options);
  const result = runCliProbe('codex', { ...options, approved: true, inspectionId });
  await expect(result).rejects.toThrow(/退出码 3/);
  await expect(result).rejects.not.toThrow(/discard-me/);
  expect(modelCalls).toBe(1);
});

it.each([
  ['unexpected argument discard-me', '启动参数不兼容'],
  ['HTTP 401 invalid token discard-me', '认证失败'],
  ['429 rate limit exceeded discard-me', '限流或额度不足'],
  ['Failed to resolve api.invalid', '网络、代理或 DNS 异常'],
  ['sandbox setup failed for discard-me', '本机沙箱或权限限制'],
  ['model_not_found discard-me', '模型或功能不受支持'],
  ['unspecified vendor error discard-me', '原因未知'],
])('仅输出固定错误分类（%s）', (message, category) => {
  const warning = 'WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)';
  expect(nativeErrorCategory(warning + '\n' + message)).toBe(category);
  const failed = JSON.stringify({ type: 'turn.failed', error: { message } });
  expect(() => parseProbeOutput('codex', failed)).toThrow(category);
  expect(() => parseProbeOutput('codex', failed)).not.toThrow('discard-me');
});
