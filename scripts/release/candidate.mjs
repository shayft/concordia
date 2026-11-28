import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { parse } from 'yaml';
import { verifyCandidate, hashFile } from './verify.mjs';
import { existingDirectory, newDestination } from './paths.mjs';

const [operation, commit, destination, ...rest] = process.argv.slice(2);
if (operation !== 'build' || !/^[a-f0-9]{40}$/u.test(commit ?? '') || !destination || rest.length)
  throw new Error('用法：node scripts/release/candidate.mjs build <完整 Git 提交 SHA> <新目录>');

existingDirectory(process.cwd());
const defaults = fileURLToPath(new URL('../../apps/server/src/worktrees/git.defaults', import.meta.url)).replaceAll('\\', '/');
const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: defaults, GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', TZ: 'UTC',
};
for (const name of ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR'])
  if (process.env[name]) gitEnvironment[name] = process.env[name];
function git(args) {
  return execFileSync('git', ['-c', 'tar.umask=0022', '-c', 'core.autocrlf=false',
    '-c', 'core.attributesFile=' + defaults, ...args], {
    shell: false, env: gitEnvironment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}
if (git(['cat-file', '-t', commit]).trim() !== 'commit') throw new Error('必须提供 commit 对象。');
const file = path => git(['show', commit + ':' + path]);
const json = value => JSON.stringify(value, null, 2) + '\n';
const sorted = object => Object.keys(object).sort();
const digest = (algorithm, data) => createHash(algorithm).update(data).digest('hex');
const lockText = file('pnpm-lock.yaml');
const lock = parse(lockText);
if (lock.lockfileVersion !== '9.0') throw new Error('不支持此 pnpm 锁格式。');
const packageInfo = importer => JSON.parse(file(posix.join(importer, 'package.json')));
const root = packageInfo('.');
const license = file('LICENSE');
if (root.license !== 'MIT' || !license.includes('Permission is hereby granted, free of charge') ||
    !license.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
  throw new Error('候选提交必须包含项目声明的 MIT 授权文本。');
const registry = new Map();
const workspaces = new Map();
const graph = new Map();

function component(type, name, version, ref) {
  graph.set(ref, new Set());
  return { type, name, version, 'bom-ref': ref };
}
for (const id of sorted(lock.packages)) {
  const record = lock.packages[id], at = id.lastIndexOf('@');
  const name = id.slice(0, at), version = id.slice(at + 1);
  const sri = record.resolution?.integrity;
  if (at < 1 || !version || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(sri ?? ''))
    throw new Error('锁定包缺少可验证的名称、版本或 SHA-512。');
  const purl = 'pkg:npm/' + name.split('/').map(encodeURIComponent).join('/') + '@' + encodeURIComponent(version);
  const item = component('library', name, version, purl);
  item.purl = purl;
  item.hashes = [{ alg: 'SHA-512', content: Buffer.from(sri.slice(7), 'base64').toString('hex') }];
  registry.set(id, item);
}
for (const importer of sorted(lock.importers)) {
  const pkg = packageInfo(importer);
  const item = component(importer === '.' ? 'application' : 'library', pkg.name, pkg.version, 'workspace:' + importer);
  if (pkg.license === 'MIT') item.licenses = [{ license: { id: 'MIT' } }];
  workspaces.set(importer, item);
}
function addEdge(from, record, name, version, importer) {
  const target = version.startsWith('link:') && importer !== undefined
    ? workspaces.get(posix.normalize(posix.join(importer, version.slice(5))))
    : registry.get(name + '@' + version.split('(')[0]);
  if (!target) throw new Error('SBOM 无法解析锁定依赖 ' + record + '/' + name);
  graph.get(from['bom-ref']).add(target['bom-ref']);
}
for (const [importer, item] of workspaces) {
  const entry = lock.importers[importer];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
    for (const [name, value] of Object.entries(entry[section] ?? {}))
      addEdge(item, importer, name, value.version, importer);
}
for (const key of sorted(lock.snapshots)) {
  const item = registry.get(key.split('(')[0]);
  if (!item) throw new Error('SBOM 无法识别依赖快照。');
  for (const section of ['dependencies', 'optionalDependencies'])
    for (const [name, version] of Object.entries(lock.snapshots[key][section] ?? {}))
      addEdge(item, key, name, version);
}

const final = newDestination(destination, true);
if (existsSync(final)) throw new Error('候选目录已存在。');
const stage = mkdtempSync(join(dirname(final), '.concordia-candidate-'));
try {
  // Local info/attributes can mark tracked files export-ignore. Archive through
  // an empty repository that shares immutable Git objects, without local rules.
  const objects = git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trimEnd();
  if (/[\r\n]/u.test(objects)) throw new Error('Git 对象目录不支持换行符。');
  const bare = join(stage, 'archive.git');
  git(['init', '--bare', '--quiet', '--template=', bare]);
  writeFileSync(join(bare, 'objects', 'info', 'alternates'), objects + '\n');
  git(['--git-dir=' + bare, 'archive', '--format=tar', '--prefix=concordia/',
    '--output=' + join(stage, 'concordia-source.tar'), commit]);
  rmSync(bare, { recursive: true });
  writeFileSync(join(stage, 'sbom.cdx.json'), json({
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { component: workspaces.get('.'), properties: [{ name: 'concordia:git:commit', value: commit }] },
    components: [...[...workspaces].filter(([key]) => key !== '.').map(([, item]) => item), ...registry.values()],
    dependencies: [...graph].map(([ref, edges]) => ({ ref, dependsOn: [...edges].sort() })),
  }));
  writeFileSync(join(stage, 'source.json'), json({
    format: 'concordia-source-v1', commit, tree: git(['rev-parse', commit + '^{tree}']).trim(),
    name: root.name, version: root.version, packageManager: root.packageManager,
    license: root.license, licenseSha256: digest('sha256', license),
    lockSha256: digest('sha256', lockText), registryPackages: registry.size, workspaces: workspaces.size,
  }));
  const names = ['concordia-source.tar', 'sbom.cdx.json', 'source.json'];
  const sums = await Promise.all(names.map(async name => (await hashFile(join(stage, name))) + '  ' + name));
  writeFileSync(join(stage, 'SHA256SUMS'), sums.join('\n') + '\n');
  await verifyCandidate(stage, commit);
  renameSync(stage, final);
} finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
console.log('已生成源码候选，提交 ' + commit + '，锁定注册表包 ' + registry.size + '。');
