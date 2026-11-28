import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installFakeClis } from '../../../packages/runtimes/test/fixtures/fake-clis.ts';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
let fixture: Awaited<ReturnType<typeof installFakeClis>>;

beforeAll(async () => { fixture = await installFakeClis(); }, 30_000);
afterAll(async () => { await fixture?.dispose(); });

function verify(args: string[], environment = fixture.env) {
  return execute(process.execPath, ['--import', 'tsx', 'apps/server/src/verify.ts', ...args], {
    cwd: root, env: environment, shell: false, windowsHide: true, timeout: 45_000, encoding: 'utf8',
  });
}

it.each(['claude', 'codex'] as const)('%s 的验证命令在桌面 PATH 缺失时给出绝对路径诊断', async kind => {
  // Use a known empty directory so discovery cannot ever invoke an installed CLI.
  const flags = kind === 'claude' ? ['--confirm-unmanaged'] : [];
  await expect(verify(['inspect', kind, ...flags], { ...fixture.env, PATH: fixture.cwd }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/PATH.*绝对路径/u) });
});

it.each(['claude', 'codex'] as const)('%s 的绝对路径通过独立验证命令完成预检、批准和文本回显', async kind => {
  const { executable, cwd } = fixture;
  const flags = ['--executable', executable(kind), '--cwd', cwd];
  if (kind === 'claude') flags.push('--confirm-unmanaged');
  const inspected = await verify(['inspect', kind, ...flags]);
  const report = JSON.parse(inspected.stdout);
  expect(report).toMatchObject({ kind, executable: executable(kind), version: '1.2.3', login: '已登录', billing: '未知' });
  expect(report.inspectionId).toEqual(expect.any(String));
  const ran = await verify(['run', kind, '--approve-call', '--inspection', report.inspectionId, ...flags]);
  expect(JSON.parse(ran.stdout)).toMatchObject({ kind, executable: executable(kind), text: 'CONCORDIA_OK' });
}, 90_000);

it('网关验证命令在读取系统凭据前拒绝非法字段或上限，并能识别两种公开字段', async () => {
  const args = ['run','gateway','--approve-call','--base-url','invalid','--credential','keychain:unused','--model','custom'];
  // This invalid URL fails locally, before any credential access or network request.
  for (const field of ['max_completion_tokens','max_tokens']) {
    await expect(verify([...args,'--output-token-field',field,'--max-output-tokens','64']))
      .rejects.toMatchObject({code:1, stdout:expect.stringContaining('Base URL')});
  }
  for (const flags of [['--output-token-field','tools'],['--max-output-tokens','-1'],['--max-output-tokens','65537']]) {
    await expect(verify([...args,...flags])).rejects.toMatchObject({code:1,stderr:expect.stringMatching(/输出字段|无法识别参数/)});
  }
});
