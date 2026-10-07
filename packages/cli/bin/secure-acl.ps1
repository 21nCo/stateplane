param(
  [Parameter(Mandatory=$true)][string]$TargetPath,
  [ValidateSet('harden','verify')][string]$Action='verify'
)
$ErrorActionPreference='Stop'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($identity.Value,'S-1-5-18','S-1-5-32-544')
$acl=Get-Acl -LiteralPath $TargetPath
if ($Action -eq 'harden') {
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
  $item=Get-Item -LiteralPath $TargetPath
  $inheritance=if ($item.PSIsContainer) {
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else { [System.Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in $allowed) {
    $principal=[System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($principal,
      [System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $TargetPath -AclObject $acl
  $acl=Get-Acl -LiteralPath $TargetPath
}
if (-not $acl.AreAccessRulesProtected) { exit 1 }
$hasUser=$false
foreach ($rule in $acl.Access) {
  $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow') { exit 1 }
  if ($sid -eq $identity.Value) { $hasUser=$true }
}
if (-not $hasUser) { exit 1 }
