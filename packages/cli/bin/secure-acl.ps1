param(
  [Parameter(Mandatory=$true)][string]$TargetPath,
  [ValidateSet('harden','verify','diagnose')][string]$Action='verify'
)
$ErrorActionPreference='Stop'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($identity.Value,'S-1-5-18','S-1-5-32-544')
$acl=Get-Acl -LiteralPath $TargetPath
if ($Action -eq 'diagnose') {
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules=@($acl.Access | ForEach-Object {
    $sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    "$sid/$($_.AccessControlType)/$($_.IsInherited)"
  }) -join ','
  Write-Output "caller=$($identity.Value) owner=$owner protected=$($acl.AreAccessRulesProtected) rules=$rules"
  exit 0
}
if ($Action -eq 'harden') {
  # Set-Acl writes the owner as well as the DACL. A Windows runner may create
  # a file owned by Administrators while the CLI runs as its member, in which
  # case that owner write fails despite the caller being allowed to edit DACLs.
  $icacls=Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) { exit 10 }
  $item=Get-Item -LiteralPath $TargetPath
  $suffix=if ($item.PSIsContainer) { ':(OI)(CI)F' } else { ':F' }
  # Grant our own SID before removing inherited rules. The system accounts
  # retain access for backup and machine administration.
  foreach ($sid in $allowed) {
    & $icacls $TargetPath '/grant:r' "*$sid$suffix" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 11 }
  }
  & $icacls $TargetPath '/inheritance:r' | Out-Null
  if ($LASTEXITCODE -ne 0) { exit 12 }
  $acl=Get-Acl -LiteralPath $TargetPath
  foreach ($rule in @($acl.Access)) {
    $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($allowed -contains $sid) { continue }
    & $icacls $TargetPath '/remove' "*$sid" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 13 }
  }
  $acl=Get-Acl -LiteralPath $TargetPath
}
if (-not $acl.AreAccessRulesProtected) { exit 1 }
$owner=$null
try { $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value }
catch { exit 2 }
if ($allowed -notcontains $owner) { exit 2 }
$hasUser=$false
foreach ($rule in $acl.Access) {
  $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow') { exit 1 }
  if ($sid -eq $identity.Value) { $hasUser=$true }
}
if (-not $hasUser) { exit 1 }
