import { startLocalServer } from './local-server.ts';

if (!process.stdout.isTTY) {
  process.stderr.write('请在交互式终端运行 pnpm serve，以接收一次性启动链接。\n');
  process.exitCode = 1;
} else {
  try {
    const { launchUrl, close } = await startLocalServer();
    process.stdout.write('请在本机浏览器打开本次启动链接：\n' + launchUrl + '\n');
    const shutdown = () => { void close(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    process.stderr.write('本地服务未启动。请先执行 pnpm build，并确认本机允许监听回环地址。\n');
    process.exitCode = 1;
  }
}
