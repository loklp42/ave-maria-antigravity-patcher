$ErrorActionPreference = "Stop"
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$agDir = if ($env:ANTIGRAVITY_DIR) { $env:ANTIGRAVITY_DIR } else { Join-Path $localAppData "Programs\antigravity" }
$resDir = Join-Path $agDir "resources"
$exePath = Join-Path $agDir "Antigravity.exe"
$asar = Join-Path $resDir "app.asar"
$asarOrig = Join-Path $resDir "app.asar.orig"
$asarBak = Join-Path $resDir "app.asar.bak"
$manifest = Join-Path $resDir "agy_patch_manifest.json"

$backup = if (Test-Path -LiteralPath $asarOrig -PathType Leaf) { $asarOrig } elseif (Test-Path -LiteralPath $asarBak -PathType Leaf) { $asarBak } else { $null }
if (-not $backup) {
    Write-Host "Backup app.asar.orig / app.asar.bak not found." -ForegroundColor Yellow
    exit 1
}
$bakItem = Get-Item -LiteralPath $backup -Force
if ($bakItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to restore from symlink/reparse point: $backup"
}

Get-Process -Name "Antigravity", "language_server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1000
Copy-Item -LiteralPath $backup -Destination $asar -Force
if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue }
Write-Host "Restored original Antigravity app.asar!" -ForegroundColor Green
if (Test-Path -LiteralPath $exePath) { Start-Process $exePath }
