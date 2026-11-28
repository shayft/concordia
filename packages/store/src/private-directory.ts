import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

// Fixed .NET operations in the system Windows PowerShell. User-controlled paths
// are passed as environment data; no command source is constructed from them.
const aclCommand = `
$ErrorActionPreference = 'Stop'
try {
  $path = $env:CONCORDIA_ACL_DIRECTORY
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sidType = [System.Security.Principal.SecurityIdentifier]
  $admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($env:CONCORDIA_ACL_OPERATION -ne 'inspect') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($current.User)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($current.User, $system, $admins)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    if ($env:CONCORDIA_ACL_OPERATION -eq 'create') {
      [void][System.IO.Directory]::CreateDirectory($path, $acl)
    } else {
      [System.IO.Directory]::SetAccessControl($path, $acl)
    }
  }
  $acl = [System.IO.Directory]::GetAccessControl($path)
  $owner = $acl.GetOwner($sidType).Value
  $principal = [System.Security.Principal.WindowsPrincipal]::new($current)
  if ($owner -ne $current.User.Value -and !($owner -eq $admins.Value -and $principal.IsInRole($admins))) { exit 1 }
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { exit 1 }
  $allowed = @($current.User.Value, $system.Value, $admins.Value, 'S-1-3-0', 'S-1-3-4')
  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
    if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { exit 1 }
  }
  exit 0
} catch { exit 1 }
`;

/** Only static descriptions of failed local permission checks are exposed. */
export class PrivateDirectoryError extends Error {}

export function checkPrivateDirectory(path: string, operation: 'create' | 'inspect' | 'secure-new-temp') {
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    const result = spawnSync(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', aclCommand], {
        shell: false, windowsHide: true, stdio: 'ignore', timeout: 10_000,
        env: { SystemRoot: system, WINDIR: system, CONCORDIA_ACL_DIRECTORY: path, CONCORDIA_ACL_OPERATION: operation },
      });
    if (result.status !== 0) throw new PrivateDirectoryError('无法确认此目录的 Windows 所有者和私有访问控制。');
    return;
  }
  const info = lstatSync(path);
  if (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)
    throw new PrivateDirectoryError('数据目录必须归当前用户所有，并仅允许该用户访问。');
  if (process.platform === 'darwin') {
    const acl = spawnSync('/bin/ls', ['-lde', '.'], { cwd: path, encoding: 'utf8', shell: false,
      env: { LC_ALL: 'C' }, timeout: 3_000, maxBuffer: 256 * 1024 });
    if (acl.status !== 0 || /^\s*\d+:.*\ballow\b/mu.test(acl.stdout))
      throw new PrivateDirectoryError('数据目录的 macOS 扩展权限无法确认为私有。');
  }
}

export function privateTemporaryDirectory(parent: string, prefix: string): string {
  const dir = mkdtempSync(join(parent, prefix));
  try {
    // Only tighten the empty directory atomically allocated by this process.
    checkPrivateDirectory(dir, 'secure-new-temp');
    return dir;
  } catch (error) {
    rmdirSync(dir);
    throw error;
  }
}
