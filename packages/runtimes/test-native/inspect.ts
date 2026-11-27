import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const registry = 'https://registry.npmjs.org';
const versions = { claude: '2.1.332', codex: '0.172.0' } as const;
type Kind = keyof typeof versions;
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const windows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const manifest = z.object({
  name: z.string(), version: z.string(),
  os: z.array(z.string()).optional(), cpu: z.array(z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  dist: z.object({tarball: z.url(), integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/u)}),
});

class CheckError extends Error {}
function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CheckError(code);
}

async function registryFetch(url: string | URL, timeout: number) {
  try { return await fetch(url, { redirect:'error', signal:AbortSignal.timeout(timeout) }); }
  catch { throw new CheckError('registry_connection_failed'); }
}

async function readManifest(name: string, version: string) {
  const url = registry + '/' + name.replace('/', '%2f') + '/' + version;
  const response = await registryFetch(url,30_000);
  requireCheck(response.ok, 'published_manifest_unavailable');
  const data = manifest.parse(await response.json());
  requireCheck(data.name === name && data.version === version, 'published_identity_mismatch');
  return data;
}

async function getBinary(kind: Kind, directory: string, env: NodeJS.ProcessEnv) {
  const {platform, arch} = process;
  const vendorArch = {x64:'x86_64',arm64:'aarch64'}[arch as string];
  const vendorOS = {linux:'unknown-linux-musl',darwin:'apple-darwin',win32:'pc-windows-msvc'}[platform as string];
  requireCheck(vendorArch && vendorOS, 'unsupported_platform');
  const rootName = kind === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  const platformName = rootName + '-' + platform + '-' + arch;
  const version = versions[kind];
  const root = await readManifest(rootName,version);
  const platformVersion = kind === 'claude' ? version : version + '-' + platform + '-' + arch;
  const declared = kind === 'claude' ? version : 'npm:' + rootName + '@' + platformVersion;
  requireCheck(root.optionalDependencies?.[platformName] === declared, 'unmatched_official_dependency');
  const release = await readManifest(kind === 'claude' ? platformName : rootName, platformVersion);
  requireCheck(release.os?.includes(platform) && release.cpu?.includes(arch), 'platform_manifest_mismatch');

  const url = new URL(release.dist.tarball);
  requireCheck(url.origin === registry && !url.username && !url.password &&
    url.pathname.startsWith('/' + release.name + '/-/'), 'invalid_registry_release');
  const response = await registryFetch(url,180_000);
  requireCheck(response.ok && response.body, 'release_download_failed');
  const archive = join(directory,'release.tgz');
  const hash = createHash('sha512');
  await pipeline(response.body, async function* (stream) {
    for await (const chunk of stream) { hash.update(chunk); yield chunk; }
  }, createWriteStream(archive,{flags:'wx',mode:0o600}));
  requireCheck('sha512-' + hash.digest('base64') === release.dist.integrity, 'package_integrity_mismatch');

  // Preserve companion files from the verified release (e.g. Windows DLLs), without running
  // an installer or any npm lifecycle script.
  const tar = windows ? join(systemRoot,'System32','tar.exe') : '/usr/bin/tar';
  const extraction = spawnSync(tar,['-xf',archive,'-C',directory],{
    cwd:directory, env, shell:false, stdio:'ignore', timeout:120_000, windowsHide:true,
  });
  requireCheck(extraction.status === 0, 'package_extraction_failed');
  await rm(archive);
  const executable = kind + (windows ? '.exe' : '');
  const path = kind === 'claude' ? join(directory,'package',executable)
    : join(directory,'package','vendor',vendorArch + '-' + vendorOS,'bin',executable);
  if (!windows) await chmod(path,0o700);
  return path;
}

async function isolatedEnvironment(directory: string, kind: Kind) {
  const folders = ['home','profile','temp','roaming','local','config','cache','data','state','work'];
  for (const name of folders) await mkdir(join(directory,name),{mode:0o700});
  const home = join(directory,'home');
  const profile = kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const env: NodeJS.ProcessEnv = {
    HOME:home,USERPROFILE:home,[profile]:join(directory,'profile'),
    TEMP:join(directory,'temp'),TMP:join(directory,'temp'),TMPDIR:join(directory,'temp'),
    APPDATA:join(directory,'roaming'), LOCALAPPDATA:join(directory,'local'),
    XDG_CONFIG_HOME:join(directory,'config'),XDG_CACHE_HOME:join(directory,'cache'),
    XDG_DATA_HOME:join(directory,'data'),XDG_STATE_HOME:join(directory,'state'),
    LANG:'C.UTF-8',PATH:windows ? join(systemRoot,'System32') : '/usr/bin:/bin:/usr/sbin:/sbin',
  };
  if (windows) {
    env.SystemRoot = env.WINDIR = systemRoot;
    env.HOMEDRIVE = win32.parse(home).root.slice(0,2);
    env.HOMEPATH = home.slice(2);
  }
  return {env, profile};
}

function reason(stderr: string) {
  if (stderr.includes('缺少校验所需参数')) return 'required_option_unconfirmed';
  if (stderr.includes('功能') || stderr.includes('扩展限制')) return 'feature_state_unconfirmed';
  if (stderr.includes('MCP 服务列表')) return 'unexpected_mcp_configuration';
  if (stderr.includes('识别官方 CLI 版本')) return 'cli_version_unrecognized';
  if (stderr.includes('超时')) return 'cli_timed_out';
  if (stderr.includes('权限') || stderr.includes('路径')) return 'cli_launch_rejected';
  return 'inspection_failed';
}

async function inspect(kind: Kind) {
  const directory = await mkdtemp(join(tmpdir(),'concordia-official-'));
  try {
    const {env,profile} = await isolatedEnvironment(directory,kind);
    const binary = await getBinary(kind,directory,env);
    const args = ['--import','tsx','apps/server/src/verify.ts','inspect',kind,
      '--executable',binary,'--cwd',join(directory,'work'),'--pass-env',profile];
    const result = spawnSync(process.execPath,args,{cwd:repository,env,encoding:'utf8',shell:false,
      stdio:['ignore','pipe','pipe'],maxBuffer:1024 * 1024,timeout:120_000,windowsHide:true});
    requireCheck(result.status === 0,reason(result.stderr ?? ''));
    const parsed = z.object({ kind:z.literal(kind),version:z.literal(versions[kind]),
      login:z.literal('未登录'),billing:z.literal('未知'),authMethod:z.literal('未知'),
    }).safeParse(JSON.parse(result.stdout));
    requireCheck(parsed.success,'unexpected_version_or_auth_state');
    console.log(kind + ' ' + versions[kind] + ' ' + process.platform + '/' + process.arch +
      ' PASS (package SHA-512, version, capability checks, signed out; model requests: 0)');
  } finally { await rm(directory,{recursive:true,force:true,maxRetries:4,retryDelay:300}); }
}

for (const kind of ['claude','codex'] as const) {
  try { await inspect(kind); }
  catch (error) {
    const code = error instanceof CheckError ? error.message : 'setup_or_inspection_failed';
    console.error(kind + ' ' + versions[kind] + ' ' + process.platform + '/' + process.arch + ' FAIL (' + code + ')');
    process.exitCode = 1;
  }
}
