param(
  [Parameter(Mandatory=$true)][string]$TargetPath,
  [ValidateSet('harden','verify','diagnose')][string]$Action='verify'
)
$ErrorActionPreference='Stop'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($identity.Value,'S-1-5-18','S-1-5-32-544')
function ReadAcl($path) {
  # FileInfo/DirectoryInfo use the framework ACL API directly. The packaged
  # CLI must not depend on PowerShell module autoload in a fresh user profile.
  if ([System.IO.Directory]::Exists($path)) {
    return ([System.IO.DirectoryInfo]::new($path)).GetAccessControl()
  }
  if ([System.IO.File]::Exists($path)) {
    return ([System.IO.FileInfo]::new($path)).GetAccessControl()
  }
  exit 14
}
$acl=ReadAcl $TargetPath
function RulesBySid($security) {
  # Get-Acl.Access can hold NTAccount names that no longer translate on a
  # runner. Asking the ACL for SIDs also makes the allowlist comparison exact.
  return @($security.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))
}
if ($Action -eq 'diagnose') {
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules=@(RulesBySid $acl | ForEach-Object {
    $sid=$_.IdentityReference.Value
    "$sid/$($_.AccessControlType)/$($_.IsInherited)"
  }) -join ','
  Write-Output "pid=$PID caller=$($identity.Value) owner=$owner protected=$($acl.AreAccessRulesProtected) rules=$rules"
  exit 0
}
if ($Action -eq 'harden') {
  # Set-Acl writes the owner as well as the DACL. A Windows runner may create
  # a file owned by Administrators while the CLI runs as its member, in which
  # case that owner write fails despite the caller being allowed to edit DACLs.
  $icacls=Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not [System.IO.File]::Exists($icacls)) { exit 10 }
  $suffix=if ([System.IO.Directory]::Exists($TargetPath)) { ':(OI)(CI)F' } else { ':F' }
  # Grant our own SID before removing inherited rules. The system accounts
  # retain access for backup and machine administration.
  foreach ($sid in $allowed) {
    & $icacls $TargetPath '/grant:r' "*$sid$suffix" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 11 }
  }
  & $icacls $TargetPath '/inheritance:r' | Out-Null
  if ($LASTEXITCODE -ne 0) { exit 12 }
  $acl=ReadAcl $TargetPath
  foreach ($rule in @(RulesBySid $acl)) {
    $sid=$rule.IdentityReference.Value
    if ($allowed -contains $sid) { continue }
    & $icacls $TargetPath '/remove' "*$sid" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 13 }
  }
  $acl=ReadAcl $TargetPath
}
if (-not $acl.AreAccessRulesProtected) { exit 1 }
$owner=$null
try { $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
catch { exit 2 }
if ($allowed -notcontains $owner) { exit 2 }
$hasUser=$false
foreach ($rule in @(RulesBySid $acl)) {
  $sid=$rule.IdentityReference.Value
  if ($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow') { exit 1 }
  if ($sid -eq $identity.Value) { $hasUser=$true }
}
if (-not $hasUser) { exit 1 }
