$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root "installer"
$dist = Join-Path $root "dist"
$payload = Join-Path $dist "ClassBell"
$build = Join-Path $installer "build"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found" }
$seven = Join-Path $root "tools\7za.exe"
if (-not (Test-Path $seven)) { throw "7za.exe not found: $seven" }

& (Join-Path $PSScriptRoot "build-desktop.ps1")
if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }
$env:CAMPUSPULSE_NODE = (Get-Command node).Source
Push-Location $root
try {
  node scripts\package-native.js
  if ($LASTEXITCODE -ne 0) { throw "app packaging failed" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force $build | Out-Null
Push-Location $installer
try {
  & $csc /nologo /platform:x64 /target:winexe /out:"$build\Uninstall.exe" /win32icon:"$root\build\icon.ico" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll Uninstaller.cs InstallerInfo.cs
  if ($LASTEXITCODE -ne 0) { throw "uninstaller build failed" }
} finally { Pop-Location }
Copy-Item (Join-Path $build "Uninstall.exe") (Join-Path $payload "Uninstall.exe") -Force

$zip = Join-Path $dist "payload.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Push-Location $payload
try {
  & $seven a -tzip -mx=9 "$zip" ".\*" -r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "payload zip failed" }
} finally { Pop-Location }

Push-Location $installer
try {
  & $csc /nologo /platform:x64 /target:winexe /out:"$dist\ClassBell-Setup-1.0.1.exe" /win32icon:"$root\build\icon.ico" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    /resource:"$zip",ClassBell.payload.zip /resource:"$root\LICENSE",ClassBell.LICENSE.txt `
    Setup.cs InstallerInfo.cs
  if ($LASTEXITCODE -ne 0) { throw "setup build failed" }
} finally { Pop-Location }

Write-Host "Installer: $dist\ClassBell-Setup-1.0.1.exe"
