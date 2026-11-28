import { PrivateDirectoryError } from '@concordia/store/private-directory';
import { LedgerRecoveryError } from './ledger-presence.ts';
import { WorkspaceRecoveryError } from './workspace-storage.ts';
import { defaultDataDirectory } from './data-directory.ts';
import { startLocalServer } from './local-server.ts';

if (!process.stdout.isTTY) {
  process.stderr.write('请在交互式终端运行 pnpm serve，以接收一次性启动链接。\n');
  process.exitCode = 1;
} else {
  try {
    const { launchUrl, close } = await startLocalServer(undefined, defaultDataDirectory());
    process.stdout.write('请在本机浏览器打开本次启动链接：\n' + launchUrl + '\n');
    const shutdown = () => { void close(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    const diagnostic = error instanceof WorkspaceRecoveryError || error instanceof LedgerRecoveryError || error instanceof PrivateDirectoryError
      ? error.message : '请检查构建产物、数据目录是否可写且未被占用，以及回环地址监听权限。';
    process.stderr.write('本地服务未启动。' + diagnostic + '\n');
    process.exitCode = 1;
  }
}
