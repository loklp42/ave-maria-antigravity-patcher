$ErrorActionPreference = "Stop"
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$agDir = if ($env:ANTIGRAVITY_DIR) { $env:ANTIGRAVITY_DIR } else { Join-Path $localAppData "Programs\antigravity" }
$resDir = Join-Path $agDir "resources"
$exePath = Join-Path $agDir "Antigravity.exe"
$asar = Join-Path $resDir "app.asar"
$asarNew = Join-Path $resDir "app.asar.new"
$asarOrig = Join-Path $resDir "app.asar.orig"
$asarBak = Join-Path $resDir "app.asar.bak"

function Test-RegularNonReparseFile([string]$p) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $p -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to operate on symlink/reparse point: $p"
    }
    return $true
}

if (-not (Test-RegularNonReparseFile $asarNew)) {
    Write-Host "app.asar.new not found (maybe already applied?)." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $exePath) { Start-Process $exePath }
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
    if (-not (Test-Path -LiteralPath $asar)) {
        $unlocked = $true
        break
    }
    try {
        [void](Test-RegularNonReparseFile $asar)
        $fs = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
        $fs.Close()
        $unlocked = $true
        break
    } catch {
        if ($_.Exception.Message -like "*reparse point*") { throw }
        Start-Sleep -Milliseconds 500
    }
}

if (-not $unlocked) {
    Write-Host "ERROR: app.asar is still locked by another process. Please close all Antigravity windows and re-run." -ForegroundColor Red
    exit 1
}

if ((Test-Path -LiteralPath $asar) -and -not (Test-RegularNonReparseFile $asarOrig) -and -not (Test-Path -LiteralPath $asarBak)) {
    Copy-Item -LiteralPath $asar -Destination $asarOrig -Force
}
Move-Item -LiteralPath $asarNew -Destination $asar -Force
Write-Host "Applied custom Antigravity theme!" -ForegroundColor Green

if (Test-Path -LiteralPath $exePath) { Start-Process $exePath }
