param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$destination = Join-Path $workspace '.scratch/epay-clients'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$packages = @(
  @{ Name='php-v1.zip'; Url='https://www.ezfp.cn/assets/files/SDK.zip?_v=1.3'; Hash='AED03C52396DAFBF3BE3C636D4FCEF51BB3F1BC829B20024EEDF6DD032614F2D'; Directory='v1' },
  @{ Name='php-v2.zip'; Url='https://pay.v8jisu.cn/static/files/SDK_2.0.zip'; Hash='33DE95841095F99FE8CCD1C16148B71671ED1319B3912205C53A794449A442B0'; Directory='v2' }
)
foreach ($package in $packages) {
  $file = Join-Path $destination $package.Name
  Invoke-WebRequest -Uri $package.Url -OutFile $file
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $package.Hash) { throw "SDK archive hash differs: $($package.Name)" }
  Expand-Archive -LiteralPath $file -DestinationPath (Join-Path $destination $package.Directory) -Force
}
Write-Output "Verified SDK archives in $destination"
