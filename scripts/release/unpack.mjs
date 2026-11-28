// Use the verifier from an independently trusted commit before executing a downloaded candidate.
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashFile, verifyCandidate } from './verify.mjs';

const [commit, bundle, expectedDigest, destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length || !/^[0-9a-f]{64}$/u.test(expectedDigest ?? ''))
  throw new Error('用法：node scripts/release/unpack.mjs <提交> <候选目录> <可信清单 SHA-256> <新目录>');
const metadata = await verifyCandidate(bundle, commit, expectedDigest);
const target = resolve(destination);
await mkdir(target, { mode: 0o700 }); // Never unpack on top of a user's installation.
try {
  // Git Bash can put a GNU tar on PATH that interprets D: as a remote host.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  execFileSync(tar, ['-xf', 'concordia-source.tar', '-C', target], { cwd: resolve(bundle), shell: false });
  const root = join(target, 'concordia');
  if (metadata.license !== 'MIT' || await hashFile(join(root, 'LICENSE')) !== metadata.licenseSha256 ||
      await hashFile(join(root, 'pnpm-lock.yaml')) !== metadata.lockSha256)
    throw new Error('源码目录的许可证或依赖锁与版本记录不一致。');
} catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
console.log('通过清单、源码归档、许可证与锁文件校验。');
