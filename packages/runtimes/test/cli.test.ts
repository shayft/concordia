import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectCli, runCliProbe } from '../src/cli.ts';
import { prepareEnvironment, resolveExecutable } from '../src/environment.ts';
import { parseAuth, parseProbeOutput } from '../src/output.ts';
import { installFakeClis } from './fixtures/fake-clis.ts';

it('计费变量按名称和来源列出，只有批准过的名称进入子进程', () => {
  const env = { HOME: '/home', OPENAI_API_KEY: 'unused-marker', UNKNOWN_DEBUG: 'omit', NODE_OPTIONS: 'omit' };
  const normal = prepareEnvironment(env);
  expect(normal.childEnv).toEqual({ HOME: '/home' });
  expect(normal.billingEnvironment).toEqual([{ name: 'OPENAI_API_KEY', passed: false, source: '当前进程环境' }]);
  expect(prepareEnvironment(env, ['OPENAI_API_KEY']).childEnv.OPENAI_API_KEY).toBe('unused-marker');
  expect(() => prepareEnvironment(env, ['NODE_OPTIONS'])).toThrow();
  expect(() => prepareEnvironment(env, ['ANTHROPIC_API_KEY'])).toThrow();
});

it('列出第三方路由及自定义凭据名，只有受支持的覆盖项可以传递', () => {
  const env = { ANTHROPIC_CUSTOM_HEADERS: 'omitted', ANTHROPIC_FOUNDRY_BASE_URL: 'omitted',
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: 'omitted', CUSTOM_PROVIDER_API_KEY: 'omitted' };
  const report = prepareEnvironment(env);
  expect(report.billingEnvironment.map(entry => entry.name)).toEqual(Object.keys(env).sort());
  expect(report.childEnv).toEqual({});
  expect(() => prepareEnvironment(env, ['CUSTOM_PROVIDER_API_KEY'])).toThrow();
  expect(() => prepareEnvironment(env, ['CLAUDE_CODE_SKIP_BEDROCK_AUTH'])).toThrow();
});

it('无法探测、非绝对路径和缺少批准都有安全诊断', async () => {
  await expect(resolveExecutable('claude', { PATH: '' })).rejects.toThrow(/PATH.*绝对路径/);
  await expect(resolveExecutable('codex', {}, 'codex')).rejects.toThrow(/绝对路径/);
  await expect(runCliProbe('codex', { approved: false as true, inspectionId: "" })).rejects.toThrow(/批准/);
});

it('认证命令的失败和未知模式不会被认作订阅', () => {
  expect(parseAuth('codex', '', 'Not logged in', 1).login).toBe('未登录');
  expect(parseAuth('codex', '', 'Unexpected', 1).login).toBe('未知');
  expect(parseAuth('codex', '', 'Logged in using ChatGPT', 0).billing).toBe('未知');
  expect(parseAuth('claude', '{"loggedIn":true,"authMethod":"api_key_helper"}', '', 0).billing).toBe('API');
  expect(parseAuth('claude', 'missing marker', '', 0).login).toBe('未知');
});

it('失败、异常工具、残缺的 JSONL 和意外文本都不能形成成功录制', () => {
  const codex = (events: unknown[]) => parseProbeOutput('codex', events.map(x => JSON.stringify(x)).join('\n'));
  expect(() => codex([{ type: 'turn.started' }, { type: 'turn.failed', error: 'unused-marker' }])).toThrow();
  expect(() => codex([{ type: 'turn.started' }, { type: 'item.started', item: { type: 'command_execution' } }])).toThrow();
  expect(() => codex([{ type: 'turn.started' }])).toThrow();
  expect(() => parseProbeOutput('codex', '{bad-json')).toThrow();
  expect(() => parseProbeOutput('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'other' }))).toThrow();
  expect(() => parseProbeOutput('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'CONCORDIA_OK' }))).toThrow();
});

describe('以独立进程执行两种假 CLI', () => {
  let fixture: Awaited<ReturnType<typeof installFakeClis>>;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    fixture = await installFakeClis();
    env = { ...fixture.env, OPENAI_API_KEY: 'unused-marker' };
  }, 30_000);
  afterAll(async () => { await fixture?.dispose(); });
  for (const kind of ['claude', 'codex'] as const) {
    it(kind + ' 在最小 PATH 下接受带空格的工作目录和绝对路径，输出可脱敏回放', async () => {
      const options = { cwd: fixture.cwd, env, executable: fixture.executable(kind), confirmUnmanaged: true, model: 'custom/model' };
      const { inspectionId } = await inspectCli(kind, options);
      const result = await runCliProbe(kind, { ...options, approved: true, inspectionId });
      expect(result.text).toBe('CONCORDIA_OK');
      expect(result.login).toBe('已登录');
      expect(result.billing).toBe('未知');
      expect(result.executable).toBe(options.executable);
      expect(result.version).toBe('1.2.3');
      expect(result.arguments[result.arguments.indexOf('--model') + 1]).toBe(options.model);
      expect(JSON.stringify(result)).not.toMatch(/OMITTED_MARKER|unused-marker/);
      expect(parseProbeOutput(kind, result.recording)).toMatchObject({ text: result.text, recording: result.recording });
    }, 60_000);
  }
  it('预检中的计费变量有变化即停止', async () => {
    const options = { cwd: fixture.cwd, env, executable: fixture.executable('claude'), confirmUnmanaged: true };
    const { inspectionId } = await inspectCli('claude', options);
    await expect(runCliProbe('claude', { ...options, env: fixture.env, approved: true, inspectionId })).rejects.toThrow(/重新预检/);
  }, 45_000);
  it('管理策略未知仅可做 Claude 预检', async () => {
    const options = { cwd: fixture.cwd, env, executable: fixture.executable('claude') };
    const { inspectionId } = await inspectCli('claude', options);
    await expect(runCliProbe('claude', { ...options, approved: true, inspectionId })).rejects.toThrow(/Managed settings/);
  }, 45_000);
  it('指定了失效路径即明确失败，不另选 PATH 候选', async () => {
    await expect(inspectCli('claude', { env: { ...fixture.env, PATH: fixture.directory }, executable: join(fixture.cwd, 'missing.exe') })).rejects.toThrow(/指定的 CLI 路径/);
  });
});
