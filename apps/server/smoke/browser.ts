import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { startLocalServer } from '../src/local-server.ts';

async function browserExecutable() {
  const explicit = process.env.BROWSER_EXECUTABLE;
  if (explicit && !isAbsolute(explicit)) throw new Error('使用绝对路径');
  const candidates = explicit
    ? [explicit]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
            .filter((dir): dir is string => Boolean(dir))
            .map((dir) => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'))
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // A runner can have both Chrome and Chromium installed at different paths.
    }
  }
  throw new Error('找不到 Chrome 或 Chromium');
}

let phase = '查找浏览器（可用 BROWSER_EXECUTABLE 指定绝对路径）';
async function smoke() {
  const executablePath = await browserExecutable();
  const root = await mkdtemp(join(tmpdir(), 'concordia-browser-'));
  let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  let context: BrowserContext | undefined;
  try {
    phase = '从正式构建产物启动服务（需先运行 pnpm build）';
    service = await startLocalServer(undefined, join(root, 'data'));
    // Driver debug output may include navigation URLs. This test reports fixed milestones only.
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    const { chromium } = await import('playwright-core');
    phase = '启动启用原生沙箱的 Chrome';
    context = await chromium.launchPersistentContext(join(root, 'profile'), {
      chromiumSandbox: true,
      executablePath,
      headless: true,
      timeout: 20_000,
    });
    context.setDefaultTimeout(15_000);
    const page = context.pages()[0] ?? (await context.newPage());
    const mutations: string[] = [];
    let scriptErrors = 0,
      httpFailures = 0,
      consoleErrors = 0;
    const origin = new URL(service.launchUrl).origin;
    page.on('pageerror', () => scriptErrors++);
    page.on('response', (response) => {
      const url = new URL(response.url());
      // Chrome can request an optional site icon even when the document has no icon link.
      if (url.origin === origin && url.pathname !== '/favicon.ico' && response.status() >= 400)
        httpFailures++;
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && message.location().url !== origin + '/favicon.ico') consoleErrors++;
    });
    page.on('request', (request) => {
      if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname);
    });
    phase = '用一次性链接建立会话并连接事件流';
    await page.goto(service.launchUrl, { waitUntil: 'commit' });
    await page.getByRole('heading', { name: '连接与成员', exact: true }).waitFor();
    await page.getByText('实时更新已连接', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '');
    phase = '通过页面载入模板并预览差异';
    await page.getByRole('link', { name: '计划与审批', exact: true }).click();
    await page.getByRole('button', { name: '载入模板', exact: true }).click();
    await page.getByRole('button', { name: '校验并预览差异', exact: true }).click();
    await page.getByText('新增 6', { exact: true }).waitFor();
    phase = '跨页面与刷新恢复草稿，重新预览才可批准';
    const originalDraft = await page.getByLabel('工作流 JSON 草案').inputValue();
    assert.ok(originalDraft.length > 0);
    await page.getByText('草稿已与当前工作区同步，批准前须预览。', { exact: true }).waitFor();
    await page.getByRole('link', { name: '连接与成员', exact: true }).click();
    await page.getByRole('link', { name: '计划与审批', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('草稿已与当前工作区同步，批准前须预览。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('工作流 JSON 草案').inputValue(), originalDraft);
    assert.equal(await page.getByRole('button', { name: '批准并应用此版本' }).count(), 0);
    await page.getByRole('button', { name: '校验并预览差异', exact: true }).click();
    phase = '批准计划并查看六张任务卡';
    await page.getByRole('button', { name: '批准并应用此版本', exact: true }).click();
    await page.getByRole('heading', { name: '协作任务板', exact: true }).waitFor();
    await page.locator('.card').nth(5).waitFor();
    assert.equal(await page.locator('.card').count(), 6);
    phase = '通过独立确认框运行固定模拟';
    const launcher = page.getByRole('button', { name: '运行固定模拟', exact: true });
    const confirmation = page.getByRole('dialog', { name: '运行固定模拟', exact: true });
    await launcher.click();
    await confirmation.waitFor();
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'hidden' });
    assert.ok(await launcher.evaluate((el) => el === document.activeElement));
    assert.ok(!mutations.includes('/api/demo/run'));
    await launcher.press('Enter');
    await confirmation.getByRole('button', { name: '运行模拟', exact: true }).click();
    await page.locator('.lane.done .card').nth(4).waitFor();
    phase = '核对五张已交付任务卡与主卡的验收版本';
    const versions = page
      .locator('details')
      .filter({ has: page.locator('summary').filter({ hasText: '验收条件与交付版本' }) });
    await versions.locator('summary').click();
    const snapshot = JSON.parse(await versions.locator('pre').innerText()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'backend-code',
      'contract',
      'frontend-code',
      'integration',
    ]);
    assert.ok(Object.values(snapshot).every((value) => typeof value === 'string' && value.length > 0));
    phase = '切换活动页并刷新，核对持久化验收事件';
    await page.getByRole('link', { name: '活动记录', exact: true }).click();
    const accepted = page.locator('summary').filter({ hasText: 'plan.accepted' });
    await accepted.waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await accepted.waitFor();
    await page.getByText('实时更新已连接', { exact: true }).waitFor();
    phase = '检查页面异常、HTTP 状态及实际提交的操作';
    assert.equal(scriptErrors, 0);
    assert.equal(consoleErrors, 0);
    assert.equal(httpFailures, 0);
    assert.deepEqual(mutations, [
      '/session',
      '/api/spec/preview',
      '/api/spec/preview',
      '/api/spec/apply',
      '/api/demo/run',
    ]);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await service?.close();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
}

try {
  await smoke();
  process.stdout.write(
    '浏览器冒烟通过：一次性会话、模板预览与批准、六张任务卡、模拟交付、验收快照及刷新后的活动记录。\n',
  );
} catch (error) {
  // Launch and navigation errors can embed arguments, URLs or DOM text.
  const sandbox =
    phase === '启动启用原生沙箱的 Chrome' &&
    error instanceof Error &&
    /sandbox|namespace|operation not permitted/i.test(error.message);
  process.stderr.write(
    '浏览器冒烟失败：' + phase + (sandbox ? '。当前主机无法按原生沙箱启动浏览器。' : '。') + '\n',
  );
  process.exitCode = 1;
}
