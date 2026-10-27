param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$targets = @(
  @{ Backup = 'backup-routing-429/pool.ts.bak'; Target = 'src/lib/pool.ts' },
  @{ Backup = 'backup-routing-429/chat.ts.bak'; Target = 'src/lib/chat.ts' },
  @{ Backup = 'backup-routing-429/agenttool-route.ts.bak'; Target = 'src/lib/agenttool-route.ts' },
  @{ Backup = 'backup-routing-429/agenttool-upstream.ts.bak'; Target = 'src/lib/upstream/agenttool.ts' }
)
foreach ($item in $targets) {
  $source = [IO.Path]::GetFullPath((Join-Path $root $item.Backup))
  $dest = [IO.Path]::GetFullPath((Join-Path $root $item.Target))
  if (!$source.StartsWith($root + [IO.Path]::DirectorySeparatorChar) -or
      !$dest.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) {
    throw 'rollback path outside workspace'
  }
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "missing backup: $source" }
  if (!$Execute) { Write-Output "DRY RUN: restore $dest from $source"; continue }
  Copy-Item -LiteralPath $source -Destination $dest -Force
  Write-Output "restored: $dest"
}
$test = [IO.Path]::GetFullPath((Join-Path $root 'scripts/routing-429.test.mts'))
if (!$test.StartsWith($root + [IO.Path]::DirectorySeparatorChar)) {
  throw 'rollback test path outside workspace'
}
if (!$Execute) {
  Write-Output "DRY RUN: remove $test if present"
} elseif (Test-Path -LiteralPath $test -PathType Leaf) {
  Remove-Item -LiteralPath $test -Force
  Write-Output "removed: $test"
}
