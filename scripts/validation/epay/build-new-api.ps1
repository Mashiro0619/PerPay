param([string]$Repository = 'D:/Project/Web/new-api')
$ErrorActionPreference = 'Stop'
$commit = '6c1575c32ba93ad92f7837993ce8fa282bae17ee'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$destination = Join-Path $workspace '.scratch/epay-clients'
$source = Join-Path $destination ('new-api-source-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $source | Out-Null
$archive = $source + '.tar'
git -C $Repository archive --format=tar $commit -o $archive
if ($LASTEXITCODE -ne 0) { throw 'Could not export the fixed New API commit.' }
tar -xf $archive -C $source
if ($LASTEXITCODE -ne 0) { throw 'Could not extract New API source.' }
New-Item -ItemType Directory -Force -Path (Join-Path $source 'web/dist') | Out-Null
Set-Content -LiteralPath (Join-Path $source 'web/dist/index.html') -Value '<!doctype html><title>Isolated New API payment validation</title>' -Encoding utf8
$binary = Join-Path $destination 'new-api-validation.exe'
Push-Location $source
try {
  go build -o $binary .
  if ($LASTEXITCODE -ne 0) { throw 'New API build failed.' }
} finally { Pop-Location }
@{ sourceCommit=$commit; binarySha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() } |
  ConvertTo-Json | Set-Content -LiteralPath ($binary + '.json') -Encoding utf8
Write-Output "Built fixed New API backend at $binary"
