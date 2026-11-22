$ErrorActionPreference = "Stop"
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$agDir = Join-Path $localAppData "Programs\antigravity"
$resDir = Join-Path $agDir "resources"
$exePath = Join-Path $agDir "Antigravity.exe"
$asar = Join-Path $resDir "app.asar"
$asarBak = Join-Path $resDir "app.asar.bak"

if (-not (Test-Path $asarBak)) {
    Write-Host "Backup app.asar.bak not found." -ForegroundColor Yellow
    exit 1
}

Get-Process -Name "Antigravity", "language_server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1000
Copy-Item $asarBak $asar -Force
Write-Host "Restored original Antigravity app.asar!" -ForegroundColor Green
Start-Process $exePath
