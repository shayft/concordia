import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyCandidate(directory, commit, trustedManifestDigest) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) throw new Error('需要完整 Git 提交 SHA。');
  const manifest = join(directory, 'SHA256SUMS');
  if (trustedManifestDigest !== undefined && await hashFile(manifest) !== trustedManifestDigest)
    throw new Error('校验清单与可信来源的摘要不符。');
  const names = new Set(['concordia-source.tar', 'sbom.cdx.json', 'source.json']);
  for (const line of (await readFile(manifest, 'utf8')).trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([a-z0-9.-]+)$/u.exec(line);
    if (!match || !names.delete(match[2]) || await hashFile(join(directory, match[2])) !== match[1])
      throw new Error('候选文件或摘要不匹配。');
  }
  if (names.size) throw new Error('候选清单不完整。');
  const source = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'));
  if (source.format !== 'concordia-source-v1' || source.commit !== commit)
    throw new Error('候选提交不匹配。');
  return source;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [commit, directory, digest, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error('用法：node scripts/release/verify.mjs <提交 SHA> <目录> [可信清单 SHA-256]');
  await verifyCandidate(directory, commit, digest);
  console.log('源码、SBOM、版本元数据与清单一致。');
}
