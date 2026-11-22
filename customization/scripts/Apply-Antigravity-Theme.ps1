$ErrorActionPreference = "Stop"
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$agDir = Join-Path $localAppData "Programs\antigravity"
$resDir = Join-Path $agDir "resources"
$exePath = Join-Path $agDir "Antigravity.exe"
$asar = Join-Path $resDir "app.asar"
$asarNew = Join-Path $resDir "app.asar.new"
$asarBak = Join-Path $resDir "app.asar.bak"

if (-not (Test-Path $asarNew)) {
    Write-Host "app.asar.new not found (maybe already applied?)." -ForegroundColor Yellow
    if (Test-Path $exePath) { Start-Process $exePath }
    exit 0
}

Write-Host "Closing Antigravity processes..." -ForegroundColor Cyan
Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
}
Start-Sleep -Milliseconds 1200
Get-Process -Name "Antigravity", "language_server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Wait up to 10s for file lock release
$unlocked = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $fs = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
        $fs.Close()
        $unlocked = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $unlocked) {
    Write-Host "ERROR: app.asar is still locked by another process. Please close all Antigravity windows and re-run." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-Path $asarBak)) {
    Copy-Item $asar $asarBak -Force
}
Move-Item $asarNew $asar -Force
Write-Host "Applied custom Antigravity glass/neon/video theme!" -ForegroundColor Green

Start-Process $exePath
