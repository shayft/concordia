import password from '@inquirer/password';
import { CredentialError, isCredentialReference, storeCredential } from './credentials.js';

async function main(): Promise<void> {
  const [reference, ...extra] = process.argv.slice(2);
  if (!reference || !isCredentialReference(reference) || extra.length > 0) {
    throw new CredentialError('用法：pnpm credential:set keychain:连接标识');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CredentialError('请在本机交互式终端中输入密钥。');
  }
  const value = await password({
    message: '输入网关密钥（输入内容隐藏）',
    mask: false,
    toggleMask: false,
  });
  await storeCredential(reference, value);
  process.stdout.write('网关密钥已写入系统凭据存储。\n');
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof CredentialError ? error.message + '\n' : '凭据录入未完成。\n');
  process.exitCode = 1;
});
