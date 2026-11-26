"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const net = require("net");
const { spawn, execFile, execFileSync } = require("child_process");

let electronApp = null;
try { electronApp = require("electron").app; } catch {}

const ACCOUNTS_DATA_ROOT = "C:\\ProgramData\\AntigravityAccounts";
const MAX_WIN_USERNAME_LEN = 20; // Windows NetBIOS SAM account name limit

// Antigravity Unlocker 2 local HTTP proxy (primary user's WinINET settings or default port fallback)
const UNLOCKER_DEFAULT_PROXY_HOST = "127.0.0.1";
const UNLOCKER_DEFAULT_PROXY_PORT = 10809;
const PROXY_NO_PROXY_LIST = "localhost,127.0.0.1";
const PROXY_WININET_OVERRIDE = "localhost;127.0.0.1;<local>";
const PROXY_CACHE_TTL_MS = 15000;
const PROXY_PROBE_TIMEOUT_MS = 600;
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
let _proxyCache = { value: null, ts: 0, resolved: false };
let _proxyRefreshPromise = null;

function makeProxyDescriptor(host, port, source) {
    const h = String(host || "").trim().toLowerCase();
    const p = Number(port);
    if (!/^[a-z0-9.-]{1,253}$/.test(h) || !Number.isInteger(p) || p < 1 || p > 65535) return null;
    const hostPort = `${h}:${p}`;
    return { host: h, port: p, hostPort, url: `http://${hostPort}`, source: String(source || "") };
}

/**
 * Parses WinINET ProxyServer value: "127.0.0.1:10809", "http://127.0.0.1:10809",
 * or per-scheme "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=...".
 * Prefers https= → http= → plain entry. SOCKS-only entries are ignored.
 */
function parseWinInetProxyServer(raw) {
    const entries = String(raw || "").split(";").map((s) => s.trim()).filter(Boolean);
    const byScheme = {};
    let plain = "";
    for (const e of entries) {
        const eq = e.indexOf("=");
        if (eq === -1) {
            if (!plain) plain = e;
            continue;
        }
        const scheme = e.slice(0, eq).trim().toLowerCase();
        const val = e.slice(eq + 1).trim();
        if (scheme && val && !byScheme[scheme]) byScheme[scheme] = val;
    }
    for (const cand of [byScheme.https, byScheme.http, plain]) {
        if (!cand) continue;
        const stripped = cand.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
        const m = stripped.match(/^([a-z0-9.-]+):(\d{1,5})$/i);
        if (m) {
            const d = makeProxyDescriptor(m[1], m[2], "registry");
            if (d) return d;
        }
    }
    return null;
}

function parseInternetSettingsRegOutput(stdout) {
    const out = { enabled: false, server: "" };
    for (const line of String(stdout || "").split(/\r?\n/)) {
        const m = line.match(/^\s*(ProxyEnable|ProxyServer)\s+(REG_\w+)\s+(.*?)\s*$/i);
        if (!m) continue;
        if (/^ProxyEnable$/i.test(m[1])) {
            out.enabled = Number.parseInt(m[3], /^0x/i.test(m[3]) ? 16 : 10) === 1;
        } else {
            out.server = m[3];
        }
    }
    return out;
}

function readPrimaryProxySettingsSync() {
    if (process.platform !== "win32") return null;
    try {
        const stdout = execFileSync("reg.exe", ["query", INTERNET_SETTINGS_KEY], {
            windowsHide: true,
            timeout: 3000,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return parseInternetSettingsRegOutput(stdout);
    } catch {
        return null;
    }
}

function readPrimaryProxySettings() {
    if (process.platform !== "win32") return Promise.resolve(null);
    return new Promise((resolve) => {
        execFile("reg.exe", ["query", INTERNET_SETTINGS_KEY], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
            resolve(error ? null : parseInternetSettingsRegOutput(stdout));
        });
    });
}

function probeTcpPort(host, port, timeoutMs = PROXY_PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let done = false;
        let sock = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock?.destroy(); } catch {}
            resolve(ok);
        };
        try {
            sock = net.connect({ host, port });
            sock.setTimeout(timeoutMs, () => finish(false));
            sock.once("connect", () => finish(true));
            sock.once("error", () => finish(false));
        } catch {
            finish(false);
        }
    });
}

function proxyFromSettings(settings) {
    return settings && settings.enabled && settings.server ? parseWinInetProxyServer(settings.server) : null;
}

/**
 * Resolves the primary user's local proxy (Antigravity Unlocker 2):
 *  1. HKCU Internet Settings: ProxyEnable=1 + ProxyServer → host:port
 *  2. Fallback: TCP probe of 127.0.0.1:10809
 *  3. Otherwise null (unlocker off → never break direct networking)
 * Returns { host, port, hostPort, url, source } | null. Cached for PROXY_CACHE_TTL_MS.
 */
async function resolveUnlockerProxy(opts = {}) {
    if (process.platform !== "win32" && !opts.readSettings) return null;
    if (!opts.force && _proxyCache.resolved && Date.now() - _proxyCache.ts < PROXY_CACHE_TTL_MS) {
        return _proxyCache.value;
    }
    if (!opts.force && _proxyRefreshPromise) return _proxyRefreshPromise;
    const readSettings = opts.readSettings || readPrimaryProxySettings;
    const probe = opts.probe || probeTcpPort;
    const p = (async () => {
        let value = null;
        try { value = proxyFromSettings(await readSettings()); } catch {}
        if (!value) {
            let open = false;
            try { open = Boolean(await probe(UNLOCKER_DEFAULT_PROXY_HOST, UNLOCKER_DEFAULT_PROXY_PORT)); } catch {}
            if (open) value = makeProxyDescriptor(UNLOCKER_DEFAULT_PROXY_HOST, UNLOCKER_DEFAULT_PROXY_PORT, "port-probe");
        }
        _proxyCache = { value, ts: Date.now(), resolved: true };
        return value;
    })();
    _proxyRefreshPromise = p;
    try {
        return await p;
    } finally {
        if (_proxyRefreshPromise === p) _proxyRefreshPromise = null;
    }
}

/**
 * Synchronous variant for spawn paths: fresh cache → registry → last async probe result.
 * Always kicks a background refresh (incl. TCP probe) when the cache is stale.
 */
function getUnlockerProxySync(opts = {}) {
    if (process.platform !== "win32" && !opts.readSettingsSync) return null;
    if (_proxyCache.resolved && Date.now() - _proxyCache.ts < PROXY_CACHE_TTL_MS) {
        return _proxyCache.value;
    }
    let fromRegistry = null;
    try { fromRegistry = proxyFromSettings((opts.readSettingsSync || readPrimaryProxySettingsSync)()); } catch {}
    void resolveUnlockerProxy({ force: true, readSettings: opts.readSettings, probe: opts.probe }).catch(() => {});
    if (fromRegistry) return fromRegistry;
    return _proxyCache.resolved ? _proxyCache.value : null;
}

function resetUnlockerProxyCache() {
    _proxyCache = { value: null, ts: 0, resolved: false };
    _proxyRefreshPromise = null;
}

function mergeNoProxyList(existing) {
    const parts = String(existing || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const h of PROXY_NO_PROXY_LIST.split(",")) {
        if (!parts.some((p) => p.toLowerCase() === h)) parts.push(h);
    }
    return parts.join(",");
}

/** Env vars for Go/Node children (Go's net/http reads only HTTP(S)_PROXY / NO_PROXY, not WinINET). */
function buildProxyEnv(proxy) {
    if (!proxy || !proxy.url) return {};
    return {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        ALL_PROXY: proxy.url,
        NO_PROXY: PROXY_NO_PROXY_LIST,
    };
}

/**
 * Plans WinINET proxy sync for the isolated user's own HKCU (applied by the runner under that user).
 * A marker file remembers that we enabled it, so we disable it again once the unlocker is off.
 */
function planIsolatedProxyRegistry(markerPath, proxy) {
    if (proxy && proxy.hostPort) {
        try { fs.writeFileSync(markerPath, proxy.hostPort, "utf8"); } catch {}
        return { enable: true, server: proxy.hostPort, override: PROXY_WININET_OVERRIDE };
    }
    try {
        if (markerPath && fs.existsSync(markerPath)) {
            fs.unlinkSync(markerPath);
            return { enable: false };
        }
    } catch {}
    return null;
}

function getAppDataRoot() {
    if (electronApp && typeof electronApp.getPath === "function") {
        try { return electronApp.getPath("appData"); } catch {}
    }
    if (process.platform === "win32") {
        return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support");
    }
    return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function getSharedAppDir() {
    return path.join(getAppDataRoot(), "Antigravity");
}

function getScriptsDir() {
    return path.join(getSharedAppDir(), "agy-scripts");
}

function getCredsDir() {
    return path.join(getSharedAppDir(), "agy_winuser_creds");
}

function getCredFilePath(accountId) {
    return path.join(getCredsDir(), `${sanitizeId(accountId)}.dpapi`);
}

function getIsolatedAccountRoot(accountId) {
    return path.join(ACCOUNTS_DATA_ROOT, sanitizeId(accountId));
}

function getIsolatedGeminiDir(accountId) {
    return path.join(getIsolatedAccountRoot(accountId), ".gemini");
}

function getIsolatedTempDir(accountId) {
    return path.join(getIsolatedAccountRoot(accountId), "tmp");
}

function sanitizeId(raw) {
    const clean = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return clean || "default";
}

function buildWinUsername(accountId) {
    const clean = sanitizeId(accountId).replace(/[^a-z0-9]/g, "");
    const hash = crypto.createHash("sha1").update(clean).digest("hex").slice(0, 8);
    const name = `AgyAcc_${hash}`;
    return name.slice(0, MAX_WIN_USERNAME_LEN);
}

function generateStrongPassword() {
    // Guarantees uppercase, lowercase, digits, and safe symbols (no quotes/dollar/backtick)
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const digits = "23456789";
    const syms = "!@#%^&*-_+=";
    const all = upper + lower + digits + syms;
    const bytes = crypto.randomBytes(32);
    const chars = [
        upper[bytes[0] % upper.length],
        lower[bytes[1] % lower.length],
        digits[bytes[2] % digits.length],
        syms[bytes[3] % syms.length],
    ];
    for (let i = 4; i < 28; i++) {
        chars.push(all[bytes[i] % all.length]);
    }
    return chars.join("");
}

function getAntigravityInstallDir() {
    try {
        if (electronApp?.isPackaged && process.resourcesPath) {
            return path.dirname(process.resourcesPath);
        }
    } catch {}
    return path.resolve(__dirname, "..");
}

function getAdminScriptPath() {
    return path.join(getScriptsDir(), "agy-winuser-admin.ps1");
}

function getRunnerScriptPath() {
    return path.join(getScriptsDir(), "agy-ls-runner.ps1");
}

function buildAdminScriptContent() {
    return String.raw`param(
    [Parameter(Mandatory=$true)][ValidateSet("provision","remove")][string]$Action,
    [string]$SpecPath = "",
    [string]$SpecJson = "",
    [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference = "Stop"

function Write-Result($obj) {
    try {
        $json = $obj | ConvertTo-Json -Depth 6 -Compress
        [System.IO.File]::WriteAllText($ResultPath, $json, [System.Text.Encoding]::UTF8)
    } catch {}
}

function Grant-TraverseParents([string]$TargetPath, [string]$AccountName) {
    try {
        $cur = Split-Path -Path $TargetPath -Parent
        $parents = @()
        while ($cur -and $cur.Length -gt 3) {
            $parents += $cur
            $next = Split-Path -Path $cur -Parent
            if ($next -eq $cur) { break }
            $cur = $next
        }
        foreach ($p in $parents) {
            & icacls.exe $p /grant ($AccountName + ":(NP)(X)") /C /Q | Out-Null
        }
    } catch {}
}

try {
    $rawSpec = if ($SpecJson) { $SpecJson } else { Get-Content -Path $SpecPath -Raw -Encoding UTF8 }
    $spec = $rawSpec | ConvertFrom-Json
    $winUser = [string]$spec.winUser
    if ($winUser -notmatch '^AgyAcc_[a-zA-Z0-9]{4,12}$') {
        throw "Invalid Windows username: $winUser"
    }

    if ($Action -eq "provision") {
        $password = [string]$spec.password
        $primaryUser = [string]$spec.primaryUser
        $installDir = [string]$spec.installDir
        $accountRoot = [string]$spec.accountRoot
        $geminiDir = [string]$spec.geminiDir
        $tempDir = [string]$spec.tempDir
        $sharedBinDir = [string]$spec.sharedBinDir
        $nodeExecPath = [string]$spec.nodeExecPath

        $canonDataRoot = [System.IO.Path]::GetFullPath("C:\ProgramData\AntigravityAccounts")
        $canonRoot = [System.IO.Path]::GetFullPath($accountRoot)
        if ($canonRoot -notmatch '^C:\\ProgramData\\AntigravityAccounts\\[a-z0-9_-]+$') {
            throw "Unsafe accountRoot: $canonRoot"
        }
        $canonGemini = [System.IO.Path]::GetFullPath($geminiDir)
        $canonTemp = [System.IO.Path]::GetFullPath($tempDir)
        if (-not $canonGemini.StartsWith($canonRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe geminiDir: $canonGemini"
        }
        if (-not $canonTemp.StartsWith($canonRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe tempDir: $canonTemp"
        }
        $canonSharedBin = ""
        if ($sharedBinDir) {
            $canonSharedBin = [System.IO.Path]::GetFullPath($sharedBinDir)
            if ($canonSharedBin -ne "C:\ProgramData\AntigravityAccounts\bin") {
                throw "Unsafe sharedBinDir: $canonSharedBin"
            }
        }

        # 1. Ensure Secondary Logon service (seclogon) is available
        try {
            $svc = Get-Service -Name "seclogon" -ErrorAction SilentlyContinue
            if ($svc) {
                if ($svc.StartType -eq "Disabled") {
                    Set-Service -Name "seclogon" -StartupType Manual
                }
                if ($svc.Status -ne "Running") {
                    Start-Service -Name "seclogon" -ErrorAction SilentlyContinue
                }
            }
        } catch {}

        # 2. Create or update dedicated standard local Windows user
        $securePwd = ConvertTo-SecureString -String $password -AsPlainText -Force
        $existing = Get-LocalUser -Name $winUser -ErrorAction SilentlyContinue
        if (-not $existing) {
            New-LocalUser -Name $winUser -Password $securePwd -FullName "Antigravity Account ($winUser)" -Description "Isolated Google Antigravity account profile" -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
            try { Add-LocalGroupMember -SID "S-1-5-32-545" -Member $winUser -ErrorAction SilentlyContinue } catch {}
        } else {
            Set-LocalUser -Name $winUser -Password $securePwd -PasswordNeverExpires $true -UserMayNotChangePassword $true | Out-Null
            if (-not $existing.Enabled) {
                Enable-LocalUser -Name $winUser | Out-Null
            }
        }

        # 3. Hide account from Windows sign-in screen
        $regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
        if (-not (Test-Path $regPath)) {
            New-Item -Path $regPath -Force | Out-Null
        }
        New-ItemProperty -Path $regPath -Name $winUser -Value 0 -PropertyType DWord -Force | Out-Null

        # 4. Prepare isolated account directories with strict ACLs (no inherited Users write rights)
        foreach ($d in @($canonDataRoot, $canonRoot, $canonGemini, $canonTemp, $canonSharedBin)) {
            if ($d -and -not (Test-Path -LiteralPath $d)) {
                New-Item -ItemType Directory -Path $d -Force | Out-Null
            }
        }
        if ($canonSharedBin -and $nodeExecPath -and (Test-Path -LiteralPath $nodeExecPath)) {
            $wrapperPath = Join-Path $canonSharedBin "agy-node.cmd"
            $wrapperLines = @("@echo off", "set ELECTRON_RUN_AS_NODE=1", ('"' + $nodeExecPath + '" %*'))
            [System.IO.File]::WriteAllText($wrapperPath, ($wrapperLines -join [System.Environment]::NewLine) + [System.Environment]::NewLine, [System.Text.Encoding]::ASCII)
        }
        & icacls.exe $canonDataRoot /inheritance:r /grant "SYSTEM:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-32-545:(NP)(RX)" /C /Q | Out-Null
        & icacls.exe $canonRoot /inheritance:r /grant "SYSTEM:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F" /grant ($winUser + ":(OI)(CI)F") /C /Q | Out-Null
        if ($primaryUser) {
            & icacls.exe $canonRoot /grant ($primaryUser + ":(OI)(CI)F") /C /Q | Out-Null
        }
        if ($canonSharedBin) {
            & icacls.exe $canonSharedBin /inheritance:r /grant "SYSTEM:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-32-545:(OI)(CI)RX" /C /Q | Out-Null
        }

        # 5. Grant minimal read/execute access to Antigravity binaries without exposing primary user's home folder
        if ($installDir -and (Test-Path -LiteralPath $installDir)) {
            $canonInstall = [System.IO.Path]::GetFullPath($installDir)
            Grant-TraverseParents -TargetPath $canonInstall -AccountName $winUser
            & icacls.exe $canonInstall /grant ($winUser + ":(OI)(CI)RX") /C /Q | Out-Null
        }

        Write-Result @{ ok = $true; action = "provision"; winUser = $winUser }
        exit 0
    }

    if ($Action -eq "remove") {
        $accountRoot = [string]$spec.accountRoot
        $installDir = [string]$spec.installDir
        $sharedBinDir = [string]$spec.sharedBinDir
        $regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
        if (Test-Path $regPath) {
            Remove-ItemProperty -Path $regPath -Name $winUser -ErrorAction SilentlyContinue
        }
        # Remove NTFS ACEs BEFORE Remove-LocalUser so no orphaned SIDs remain in ACLs
        foreach ($aclPath in @("C:\ProgramData\AntigravityAccounts", $sharedBinDir, $installDir, $accountRoot)) {
            if ($aclPath -and (Test-Path -LiteralPath $aclPath)) {
                & icacls.exe $aclPath /remove $winUser /C /Q | Out-Null
            }
        }
        $existing = Get-LocalUser -Name $winUser -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-LocalUser -Name $winUser -ErrorAction SilentlyContinue
        }
        # Clean up Windows profile directory if created
        try {
            $prof = Get-CimInstance -ClassName Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.LocalPath -and ($_.LocalPath -match ("\\" + [regex]::Escape($winUser) + "$")) }
            if ($prof) { Remove-CimInstance -InputObject $prof -ErrorAction SilentlyContinue }
        } catch {}
        if ($accountRoot) {
            $canonDel = [System.IO.Path]::GetFullPath($accountRoot)
            if ($canonDel -match '^C:\\ProgramData\\AntigravityAccounts\\[a-z0-9_-]+$' -and (Test-Path -LiteralPath $canonDel)) {
                $item = Get-Item -LiteralPath $canonDel -Force
                if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                    Remove-Item -LiteralPath $canonDel -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
        Write-Result @{ ok = $true; action = "remove"; winUser = $winUser }
        exit 0
    }
} catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
`;
}

function buildRunnerScriptContent() {
    return String.raw`$ErrorActionPreference = "Stop"

$specB64 = $env:AGY_LS_LAUNCH_SPEC_B64
if (-not $specB64) {
    [Console]::Error.WriteLine("[AgyRunner] Missing AGY_LS_LAUNCH_SPEC_B64")
    exit 2
}
$specJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($specB64))
$spec = $specJson | ConvertFrom-Json

$credPath = [string]$spec.credPath
$winUser = [string]$spec.winUser
$binaryPath = [string]$spec.binaryPath
$workingDir = [string]$spec.workingDir
$tempDir = [string]$spec.tempDir
$parentPid = [int]$spec.parentPid
$stdinPayload = [string]$spec.stdinPayload

if (-not (Test-Path $credPath)) {
    [Console]::Error.WriteLine("[AgyRunner] Missing DPAPI credential file: $credPath")
    exit 3
}

$encrypted = (Get-Content -Path $credPath -Raw -Encoding UTF8).Trim()
$securePwd = ConvertTo-SecureString -String $encrypted

# Compile tiny native Job Object helper so child LS is ALWAYS terminated when runner exits
$jobHelperReady = $false
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgyJobHelper {
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public static IntPtr CreateKillOnCloseJob(IntPtr processHandle) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        try {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(info, ptr, false);
                if (!SetInformationJobObject(job, 9, ptr, (uint)size)) {
                    CloseHandle(job);
                    return IntPtr.Zero;
                }
            } finally {
                Marshal.FreeHGlobal(ptr);
            }
            if (!AssignProcessToJobObject(job, processHandle)) {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        } catch {
            CloseHandle(job);
            return IntPtr.Zero;
        }
    }
}
"@ -ErrorAction Stop
$jobHelperReady = $true
} catch {
    [Console]::Error.WriteLine("[AgyRunner] Warning: AgyJobHelper compilation failed, relying on parent watchdog: " + $_.Exception.Message)
}

$expectedParentStartTicks = $null
if ($parentPid -gt 0) {
    try {
        $pInit = [System.Diagnostics.Process]::GetProcessById($parentPid)
        if ($pInit -and -not $pInit.HasExited) {
            $expectedParentStartTicks = $pInit.StartTime.ToUniversalTime().Ticks
        } else {
            [Console]::Error.WriteLine("[AgyRunner] Parent PID $parentPid already exited before LS launch")
            exit 5
        }
    } catch {
        [Console]::Error.WriteLine("[AgyRunner] Parent PID $parentPid no longer exists before LS launch")
        exit 5
    }
}

function Escape-WinArg([string]$a) {
    if ($null -eq $a -or $a.Length -eq 0) { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $escaped = $a -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

# Sync WinINET proxy (Antigravity Unlocker 2) into the isolated user's own HKCU hive.
# Runs reg.exe AS the isolated user (LOGON_WITH_PROFILE loads its hive), so no admin rights are needed.
function Sync-IsolatedProxyRegistry($regSpec) {
    if ($null -eq $regSpec) { return }
    $key = "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    if ($regSpec.enable) {
        $server = [string]$regSpec.server
        $override = [string]$regSpec.override
        if ($server -notmatch '^[A-Za-z0-9.-]+:\d{1,5}$') { return }
        if ($override -notmatch '^[A-Za-z0-9.;<>*-]+$') { return }
        $cmd = 'reg add "' + $key + '" /v ProxyEnable /t REG_DWORD /d 1 /f >nul && reg add "' + $key + '" /v ProxyServer /t REG_SZ /d "' + $server + '" /f >nul && reg add "' + $key + '" /v ProxyOverride /t REG_SZ /d "' + $override + '" /f >nul'
    } else {
        $cmd = 'reg add "' + $key + '" /v ProxyEnable /t REG_DWORD /d 0 /f >nul'
    }
    try {
        $rp = New-Object System.Diagnostics.ProcessStartInfo
        $rp.FileName = Join-Path $env:SystemRoot "System32\cmd.exe"
        $rp.Arguments = '/d /s /c "' + $cmd + '"'
        $rp.WorkingDirectory = $workingDir
        $rp.UserName = $winUser
        $rp.Domain = $env:COMPUTERNAME
        $rp.Password = $securePwd
        $rp.LoadUserProfile = $true
        $rp.UseShellExecute = $false
        $rp.CreateNoWindow = $true
        $rProc = [System.Diagnostics.Process]::Start($rp)
        if ($rProc) {
            if (-not $rProc.WaitForExit(15000)) { try { $rProc.Kill() } catch {} }
            $rProc.Dispose()
        }
    } catch {
        [Console]::Error.WriteLine("[AgyRunner] Proxy registry sync failed: " + $_.Exception.Message)
    }
}

Sync-IsolatedProxyRegistry $spec.proxyRegistry

$argLine = (@($spec.args) | ForEach-Object { Escape-WinArg ([string]$_) }) -join ' '

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $binaryPath
$psi.Arguments = $argLine
$psi.WorkingDirectory = $workingDir
$psi.UserName = $winUser
$psi.Domain = $env:COMPUTERNAME
$psi.Password = $securePwd
$psi.LoadUserProfile = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

# Clear inherited primary-user environment completely and keep only minimal OS variables
$keepSys = @("SYSTEMROOT","WINDIR","COMSPEC","PATHEXT","OS","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS","SYSTEMDRIVE","PROGRAMDATA","PROGRAMFILES","PROGRAMFILES(X86)","COMMONPROGRAMFILES","ALLUSERSPROFILE","PUBLIC","COMPUTERNAME")
$savedSys = @{}
foreach ($k in $keepSys) {
    if ($psi.EnvironmentVariables.ContainsKey($k)) { $savedSys[$k] = $psi.EnvironmentVariables[$k] }
}
$psi.EnvironmentVariables.Clear()
foreach ($k in $savedSys.Keys) { $psi.EnvironmentVariables[$k] = $savedSys[$k] }

$sysDrive = if ($savedSys.ContainsKey("SYSTEMDRIVE")) { $savedSys["SYSTEMDRIVE"] } else { "C:" }
$userProf = Join-Path (Join-Path $sysDrive "Users") $winUser
$psi.EnvironmentVariables["USERNAME"] = $winUser
$psi.EnvironmentVariables["USERPROFILE"] = $userProf
$psi.EnvironmentVariables["HOME"] = $userProf
$psi.EnvironmentVariables["HOMEDRIVE"] = $sysDrive
$psi.EnvironmentVariables["HOMEPATH"] = "\Users\$winUser"
$psi.EnvironmentVariables["APPDATA"] = Join-Path $userProf "AppData\Roaming"
$psi.EnvironmentVariables["LOCALAPPDATA"] = Join-Path $userProf "AppData\Local"
if ($tempDir) {
    $psi.EnvironmentVariables["TEMP"] = $tempDir
    $psi.EnvironmentVariables["TMP"] = $tempDir
}

if ($spec.env) {
    foreach ($prop in $spec.env.PSObject.Properties) {
        if ($null -eq $prop.Value) {
            $psi.EnvironmentVariables.Remove($prop.Name)
        } else {
            $psi.EnvironmentVariables[$prop.Name] = [string]$prop.Value
        }
    }
}

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$started = $proc.Start()
if (-not $started) {
    [Console]::Error.WriteLine("[AgyRunner] Failed to start language_server.exe for $winUser")
    exit 4
}

$jobHandle = [IntPtr]::Zero
if ($jobHelperReady) {
    try { $jobHandle = [AgyJobHelper]::CreateKillOnCloseJob($proc.Handle) } catch {}
    if ($jobHandle -eq [IntPtr]::Zero) {
        [Console]::Error.WriteLine("[AgyRunner] Warning: CreateKillOnCloseJob returned null handle; relying on watchdog cleanup")
    }
}

try {
    if ($stdinPayload -and $stdinPayload.Length -gt 0) {
        $proc.StandardInput.Write($stdinPayload)
        $proc.StandardInput.Flush()
    }
    $proc.StandardInput.Close()
} catch {}

# Relay stdout and stderr asynchronously without throttling ready lines
$outTask = $proc.StandardOutput.ReadLineAsync()
$errTask = $proc.StandardError.ReadLineAsync()

$outOpen = $true
$errOpen = $true

function Stop-ChildTree($childProc) {
    try {
        if (-not $childProc.HasExited) {
            & taskkill.exe /PID $childProc.Id /T /F 2>$null | Out-Null
            if (-not $childProc.HasExited) { $childProc.Kill() }
        }
    } catch {}
}

try {
    while (-not $proc.HasExited -or $outOpen -or $errOpen) {
        $drainedOut = $false
        while ($outOpen -and $outTask.IsCompleted) {
            $line = $null
            try { $line = $outTask.Result } catch {}
            if ($null -eq $line) {
                $outOpen = $false
            } else {
                [Console]::Out.WriteLine($line)
                $drainedOut = $true
                $outTask = $proc.StandardOutput.ReadLineAsync()
            }
        }
        if ($drainedOut) { [Console]::Out.Flush() }

        $drainedErr = $false
        while ($errOpen -and $errTask.IsCompleted) {
            $eline = $null
            try { $eline = $errTask.Result } catch {}
            if ($null -eq $eline) {
                $errOpen = $false
            } else {
                [Console]::Error.WriteLine($eline)
                $drainedErr = $true
                $errTask = $proc.StandardError.ReadLineAsync()
            }
        }
        if ($drainedErr) { [Console]::Error.Flush() }

        # Watch parent Electron PID (+ StartTime to defend against PID reuse) so we cleanly terminate child LS if parent disappears
        if ($parentPid -gt 0 -and -not $proc.HasExited) {
            $parentAlive = $true
            try {
                $pObj = [System.Diagnostics.Process]::GetProcessById($parentPid)
                if ($pObj.HasExited) {
                    $parentAlive = $false
                } elseif ($null -ne $expectedParentStartTicks -and $expectedParentStartTicks -gt 0) {
                    try {
                        if ($pObj.StartTime.ToUniversalTime().Ticks -ne $expectedParentStartTicks) {
                            $parentAlive = $false
                        }
                    } catch {}
                }
            } catch {
                $parentAlive = $false
            }
            if (-not $parentAlive) {
                Stop-ChildTree $proc
                break
            }
        }

        if ($proc.HasExited -and -not $outOpen -and -not $errOpen) {
            break
        }
        $waitList = New-Object System.Collections.Generic.List[System.Threading.Tasks.Task]
        if ($outOpen) { [void]$waitList.Add($outTask) }
        if ($errOpen) { [void]$waitList.Add($errTask) }
        if ($waitList.Count -gt 0) {
            [void][System.Threading.Tasks.Task]::WaitAny($waitList.ToArray(), 250)
        } else {
            Start-Sleep -Milliseconds 50
        }
    }
    $exitCode = 0
    if ($proc.HasExited) { $exitCode = $proc.ExitCode }
    exit $exitCode
} finally {
    Stop-ChildTree $proc
    if ($jobHandle -ne [IntPtr]::Zero -and $jobHelperReady) {
        try { [AgyJobHelper]::CloseHandle($jobHandle) | Out-Null } catch {}
    }
    try { $proc.Dispose() } catch {}
}
`;
}

function ensureHelperScripts() {
    const dir = getScriptsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(getCredsDir(), { recursive: true });

    const adminPath = getAdminScriptPath();
    const adminContent = buildAdminScriptContent();
    if (!fs.existsSync(adminPath) || fs.readFileSync(adminPath, "utf8") !== adminContent) {
        fs.writeFileSync(adminPath, adminContent, "utf8");
    }

    const runnerPath = getRunnerScriptPath();
    const runnerContent = buildRunnerScriptContent();
    if (!fs.existsSync(runnerPath) || fs.readFileSync(runnerPath, "utf8") !== runnerContent) {
        fs.writeFileSync(runnerPath, runnerContent, "utf8");
    }

    return { adminPath, runnerPath };
}

function ensureSharedNodeWrapper() {
    const sharedBin = path.join(ACCOUNTS_DATA_ROOT, "bin");
    try {
        const wrapperPath = path.join(sharedBin, "agy-node.cmd");
        const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`;
        if (fs.existsSync(wrapperPath)) {
            try {
                if (fs.readFileSync(wrapperPath, "utf8") === content) {
                    return sharedBin;
                }
            } catch {}
        }
        fs.mkdirSync(sharedBin, { recursive: true });
        fs.writeFileSync(wrapperPath, content, "utf8");
        return sharedBin;
    } catch {
        return fs.existsSync(sharedBin) ? sharedBin : "";
    }
}

function buildSanitizedChildPath(rawPath, homeDir, sharedBin = "") {
    const homeNorm = String(homeDir || "").trim().replace(/[\\/]+$/, "").toLowerCase();
    const segments = String(rawPath || "")
        .split(";")
        .map((s) => s.trim())
        .filter((seg) => {
            if (!seg) return false;
            if (!homeNorm) return true;
            const segNorm = seg.replace(/[\\/]+$/, "").toLowerCase();
            return segNorm !== homeNorm && !segNorm.startsWith(homeNorm + "\\") && !segNorm.startsWith(homeNorm + "/");
        });
    const sysPath = segments.join(";");
    return sharedBin ? (sysPath ? `${sharedBin};${sysPath}` : sharedBin) : sysPath;
}

function secureDeleteFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return;
        try {
            const st = fs.lstatSync(filePath);
            if (st.isFile() && st.size > 0) {
                const fd = fs.openSync(filePath, "r+");
                try {
                    fs.writeSync(fd, Buffer.alloc(Math.min(st.size, 65536), 0), 0, Math.min(st.size, 65536), 0);
                    fs.fsyncSync(fd);
                } finally {
                    fs.closeSync(fd);
                }
            }
        } catch {}
        fs.unlinkSync(filePath);
    } catch {}
}

function escapePsSingleQuote(s) {
    return String(s || "").replace(/'/g, "''");
}

function buildElevatedBootstrapScript({ action, adminPath, adminSha256, specPath, specSha256, resultPath }) {
    const a = escapePsSingleQuote(action);
    const p1 = escapePsSingleQuote(adminPath);
    const h1 = escapePsSingleQuote(adminSha256);
    const p2 = escapePsSingleQuote(specPath);
    const h2 = escapePsSingleQuote(specSha256);
    const p3 = escapePsSingleQuote(resultPath);
    return `$ErrorActionPreference='Stop'
$s=[System.IO.File]::ReadAllBytes('${p1}')
$d=[System.IO.File]::ReadAllBytes('${p2}')
try{[System.IO.File]::WriteAllBytes('${p2}',(New-Object byte[] $d.Length));[System.IO.File]::Delete('${p2}')}catch{}
$sha=[System.Security.Cryptography.SHA256]::Create()
$c1=([BitConverter]::ToString($sha.ComputeHash($s))-replace'-','').ToLowerInvariant()
$c2=([BitConverter]::ToString($sha.ComputeHash($d))-replace'-','').ToLowerInvariant()
if($c1-ne'${h1}' -or $c2-ne'${h2}'){throw 'Admin script or spec integrity check failed'}
$sb=[scriptblock]::Create([System.Text.Encoding]::UTF8.GetString($s))
& $sb -Action '${a}' -SpecJson ([System.Text.Encoding]::UTF8.GetString($d)) -ResultPath '${p3}'`;
}

function runPowerShell(args, env = {}, timeoutMs = 120000) {
    return new Promise((resolve) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
            {
                windowsHide: true,
                timeout: timeoutMs,
                env: { ...process.env, ...env },
            },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    code: error ? (error.code ?? 1) : 0,
                    stdout: String(stdout || ""),
                    stderr: String(stderr || ""),
                    error: error ? String(error.message || error) : "",
                });
            }
        );
    });
}

function runPowerShellScript(scriptText, env = {}, timeoutMs = 120000) {
    const encoded = Buffer.from(String(scriptText || ""), "utf16le").toString("base64");
    return runPowerShell(["-EncodedCommand", encoded], env, timeoutMs);
}

async function saveEncryptedCredential(accountId, plainPassword) {
    fs.mkdirSync(getCredsDir(), { recursive: true });
    const credPath = getCredFilePath(accountId);
    const ps = `
$ErrorActionPreference = "Stop"
$plain = [Console]::In.ReadToEnd()
$sec = ConvertTo-SecureString -String $plain -AsPlainText -Force
$enc = ConvertFrom-SecureString -SecureString $sec
[System.IO.File]::WriteAllText($env:AGY_CRED_OUT, $enc, [System.Text.Encoding]::UTF8)
`;
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const res = await new Promise((resolve) => {
        const proc = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                env: { ...process.env, AGY_CRED_OUT: credPath },
            }
        );
        let stdout = "";
        let stderr = "";
        proc.stdin?.on?.("error", () => {});
        proc.stdout?.on?.("error", () => {});
        proc.stderr?.on?.("error", () => {});
        proc.stdout.on("data", (c) => { stdout += String(c); });
        proc.stderr.on("data", (c) => { stderr += String(c); });
        proc.on("error", (err) => resolve({ ok: false, stderr: String(err?.message || err) }));
        proc.on("close", (code) => resolve({ ok: code === 0, code: code ?? 1, stdout, stderr }));
        try {
            proc.stdin.end(String(plainPassword || ""), "utf8");
        } catch {}
    });
    if (!res.ok) {
        throw new Error(`Failed to store DPAPI credential: ${res.stderr || res.error}`);
    }
    return credPath;
}

async function runElevatedAdminAction(action, spec) {
    const { adminPath } = ensureHelperScripts();
    const privateDir = getCredsDir();
    fs.mkdirSync(privateDir, { recursive: true });
    const token = `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
    const specPath = path.join(privateDir, `agy_spec_${token}.json`);
    const resultPath = path.join(privateDir, `agy_res_${token}.json`);

    const adminBytes = fs.readFileSync(adminPath);
    const specBytes = Buffer.from(JSON.stringify(spec), "utf8");
    const adminSha256 = crypto.createHash("sha256").update(adminBytes).digest("hex");
    const specSha256 = crypto.createHash("sha256").update(specBytes).digest("hex");

    fs.writeFileSync(specPath, specBytes);
    try {
        // Run elevated via integrity-verified -EncodedCommand bootstrap (eliminates UAC TOCTOU)
        const bootstrap = buildElevatedBootstrapScript({
            action,
            adminPath,
            adminSha256,
            specPath,
            specSha256,
            resultPath,
        });
        const bootstrapB64 = Buffer.from(bootstrap, "utf16le").toString("base64");
        const launcher = `
$ErrorActionPreference = "Stop"
$argList = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", $env:AGY_ADMIN_BOOTSTRAP_B64
)
$p = Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -WindowStyle Hidden -Wait -PassThru
exit $p.ExitCode
`;
        const runRes = await runPowerShellScript(launcher, {
            AGY_ADMIN_BOOTSTRAP_B64: bootstrapB64,
        });

        let parsed = null;
        if (fs.existsSync(resultPath)) {
            try {
                parsed = JSON.parse(fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
            } catch {}
        }

        if (parsed && parsed.ok) {
            return { ok: true, ...parsed };
        }
        if (parsed && !parsed.ok) {
            return { ok: false, error: "uac_action_failed", message: parsed.error || "Elevated setup failed" };
        }
        const rawErr = (runRes.stderr || runRes.error || "").trim();
        if (/cancel|отмен/i.test(rawErr)) {
            return { ok: false, error: "uac_cancelled", message: "UAC cancelled by user" };
        }
        return { ok: false, error: "uac_failed", message: rawErr || `Elevated process exited with code ${runRes.code}` };
    } finally {
        secureDeleteFile(specPath);
        secureDeleteFile(resultPath);
    }
}

async function checkWindowsUserExists(winUser) {
    if (process.platform !== "win32" || !winUser) return false;
    const res = await runPowerShell([
        "-Command",
        `if (Get-LocalUser -Name $env:AGY_CHECK_USER -ErrorAction SilentlyContinue) { Write-Output "YES" } else { Write-Output "NO" }`,
    ], { AGY_CHECK_USER: winUser });
    return res.ok && res.stdout.trim().includes("YES");
}

function isIsolatedAccountProvisionedSync(accountId, winUser) {
    if (process.platform !== "win32") return false;
    const id = sanitizeId(accountId);
    if (id === "default") return true;
    const credPath = getCredFilePath(id);
    const geminiDir = getIsolatedGeminiDir(id);
    return Boolean(winUser && fs.existsSync(credPath) && fs.existsSync(geminiDir));
}

async function provisionIsolatedAccount(accountId, existingWinUser = "") {
    if (process.platform !== "win32") {
        return { ok: false, error: "unsupported_platform", message: "Windows user isolation requires Windows." };
    }
    const id = sanitizeId(accountId);
    if (id === "default") {
        return { ok: true, winUser: "", geminiDir: path.join(os.homedir(), ".gemini") };
    }

    const winUser = existingWinUser || buildWinUsername(id);
    const password = generateStrongPassword();
    const accountRoot = getIsolatedAccountRoot(id);
    const geminiDir = getIsolatedGeminiDir(id);
    const tempDir = getIsolatedTempDir(id);
    const sharedBinDir = path.join(ACCOUNTS_DATA_ROOT, "bin");
    const primaryUser = os.userInfo().username || process.env.USERNAME || "";
    const installDir = getAntigravityInstallDir();

    const adminRes = await runElevatedAdminAction("provision", {
        winUser,
        password,
        primaryUser,
        installDir,
        accountRoot,
        geminiDir,
        tempDir,
        sharedBinDir,
        nodeExecPath: process.execPath,
    });
    if (!adminRes.ok) {
        return adminRes;
    }

    await saveEncryptedCredential(id, password);
    ensureSharedNodeWrapper();

    return {
        ok: true,
        winUser,
        accountRoot,
        geminiDir,
        tempDir,
    };
}

async function removeIsolatedAccount(accountId, winUser) {
    const id = sanitizeId(accountId);
    const credPath = getCredFilePath(id);
    if (process.platform === "win32" && winUser) {
        const res = await runElevatedAdminAction("remove", {
            winUser,
            accountRoot: getIsolatedAccountRoot(id),
            installDir: getAntigravityInstallDir(),
            sharedBinDir: path.join(ACCOUNTS_DATA_ROOT, "bin"),
        });
        if (!res || !res.ok) {
            return res || { ok: false, error: "uac_failed" };
        }
    }
    try { if (fs.existsSync(credPath)) fs.unlinkSync(credPath); } catch {}
    try {
        const marker = getProxyMarkerPath(id);
        if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch {}
    return { ok: true };
}

function isBlockedWorkspacePath(normPath) {
    const home = os.homedir();
    const appDataRoot = getAppDataRoot();
    const norm = String(normPath || "").toLowerCase().replace(/[\\\/]+$/, "");
    if (!norm || norm.length <= 3) return true;

    const cleanNorm = (p) => p ? path.resolve(p).toLowerCase().replace(/[\\\/]+$/, "") : "";
    const exactBlocked = [
        home,
        path.dirname(home),
        path.join(home, "AppData"),
        process.env.USERPROFILE,
        process.env.LOCALAPPDATA,
        process.env.PROGRAMDATA,
        process.env.PUBLIC,
        process.env.ALLUSERSPROFILE,
        "c:",
    ].map(cleanNorm).filter(Boolean);

    if (exactBlocked.includes(norm)) return true;

    const subtreeBlocked = [
        process.env.WINDIR,
        process.env.PROGRAMFILES,
        process.env["ProgramFiles(x86)"],
        process.env.CommonProgramFiles,
        process.env["CommonProgramFiles(x86)"],
        ACCOUNTS_DATA_ROOT,
        appDataRoot,
        getSharedAppDir(),
        getCredsDir(),
        getScriptsDir(),
        path.join(home, ".gemini"),
        path.join(home, ".gemini-profiles"),
        path.join(home, ".ssh"),
        path.join(home, ".aws"),
        path.join(home, ".gnupg"),
        path.join(home, ".kube"),
        path.join(home, ".docker"),
        path.join(home, ".azure"),
        path.join(home, ".config"),
        path.join(home, "AppData", "Roaming"),
        path.join(home, "AppData", "LocalLow"),
        path.join(home, "AppData", "Local", "Programs"),
        path.join(home, "AppData", "Local", "Google"),
        path.join(home, "AppData", "Local", "Microsoft"),
    ].map(cleanNorm).filter(Boolean);

    for (const prefix of subtreeBlocked) {
        if (norm === prefix || norm.startsWith(prefix + "\\")) {
            return true;
        }
    }

    // Also block if target is a parent directory containing sensitive roots
    for (const critical of [home, appDataRoot, process.env.WINDIR, process.env.PROGRAMFILES].map(cleanNorm).filter(Boolean)) {
        if (critical.startsWith(norm + "\\")) {
            return true;
        }
    }
    return false;
}

/**
 * Grants Modify (read/write) ACL on a user-selected workspace folder to the
 * secondary Windows account. Because the primary user owns folders inside
 * their home directory, icacls succeeds without UAC.
 */
async function grantWorkspaceAccess(winUser, folderPath) {
    if (process.platform !== "win32" || !winUser || !folderPath) {
        return { ok: true, skipped: true };
    }
    if (!/^AgyAcc_[a-zA-Z0-9]{4,12}$/.test(String(winUser))) {
        return { ok: false, error: "invalid_win_user" };
    }
    try {
        const resolved = path.resolve(folderPath);
        if (isBlockedWorkspacePath(resolved)) {
            return { ok: false, error: "blocked_sensitive_root" };
        }
        if (!fs.existsSync(resolved)) {
            return { ok: false, error: "folder_not_found" };
        }
        let realTarget = resolved;
        try {
            const lst = fs.lstatSync(resolved);
            if (lst.isSymbolicLink()) {
                return { ok: false, error: "blocked_sensitive_root" };
            }
            realTarget = fs.realpathSync(resolved);
        } catch {
            return { ok: false, error: "folder_not_found" };
        }
        if (isBlockedWorkspacePath(realTarget)) {
            return { ok: false, error: "blocked_sensitive_root" };
        }
        try {
            if (!fs.statSync(realTarget).isDirectory()) {
                return { ok: false, error: "folder_not_found" };
            }
        } catch {
            return { ok: false, error: "folder_not_found" };
        }
        // Grant non-inheriting Traverse (X) on parent directories if inside user profile,
        // and inheritable Modify (OI)(CI)M on the workspace folder itself (without slow /T walk).
        const ps = `
$ErrorActionPreference = "Stop"
$target = $env:AGY_GRANT_DIR
$user = $env:AGY_GRANT_USER
$cur = Split-Path -Path $target -Parent
while ($cur -and $cur.Length -gt 3) {
    & icacls.exe $cur /grant ($user + ":(NP)(X)") /C /Q | Out-Null
    $next = Split-Path -Path $cur -Parent
    if ($next -eq $cur) { break }
    $cur = $next
}
& icacls.exe $target /grant ($user + ":(OI)(CI)M") /C /Q | Out-Null
Write-Output "OK"
`;
        const res = await runPowerShellScript(ps, {
            AGY_GRANT_DIR: realTarget,
            AGY_GRANT_USER: winUser,
        }, 15000);
        return { ok: res.ok, stderr: res.stderr };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

function getProxyMarkerPath(accountId) {
    return path.join(getIsolatedAccountRoot(accountId), ".agy_proxy_registry");
}

const ISOLATED_ENV_FORWARD_KEYS = [
    "ANTIGRAVITY_SERVER_CSRF_TOKEN",
    "AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP",
    "CHROME_DEVTOOLS_MCP_JS",
    "CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY",
    "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS",
    "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS",
    "AGY_BROWSER_ACTIVE_PORT_FILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

/**
 * Builds the minimal environment for the isolated LS (Windows env is case-insensitive).
 * Explicit HTTP(S)_PROXY from the parent env wins; otherwise the detected unlocker proxy
 * is injected. Loopback is always kept in NO_PROXY so local-server/LS traffic stays direct.
 */
function buildIsolatedChildEnv({ env, proxy = null, rawPath = "", homeDir = "", sharedBin = "" } = {}) {
    const childEnv = {};
    for (const k of ISOLATED_ENV_FORWARD_KEYS) {
        if (env && env[k] !== undefined && env[k] !== null && String(env[k]) !== "") {
            childEnv[k.toUpperCase()] = String(env[k]);
        }
    }
    // Make LS print ANTIGRAVITY_OPEN_URL so Electron opens OAuth in the primary user's browser
    childEnv["ANTIGRAVITY_VSCODE_HOST"] = "1";

    const hasExplicitProxy = Boolean(childEnv.HTTP_PROXY || childEnv.HTTPS_PROXY || childEnv.ALL_PROXY);
    if (proxy && !hasExplicitProxy) {
        Object.assign(childEnv, buildProxyEnv(proxy));
    }
    if (proxy || hasExplicitProxy) {
        childEnv.NO_PROXY = mergeNoProxyList(childEnv.NO_PROXY);
    }

    // Build clean PATH excluding primary user's profile directories
    const cleanPath = buildSanitizedChildPath(rawPath, homeDir, sharedBin);
    if (cleanPath) {
        childEnv["PATH"] = cleanPath;
    }
    return childEnv;
}

/**
 * Spawns language_server.exe under the account's dedicated local Windows user
 * via agy-ls-runner.ps1 (LOGON_WITH_PROFILE + Job Object).
 * Returns a standard ChildProcess whose stdout/stderr relay the LS output.
 */
function spawnIsolatedLanguageServer(opts) {
    const {
        accountId,
        winUser,
        binaryPath,
        args,
        env,
        stdinPayload = "",
    } = opts;

    const id = sanitizeId(accountId);
    const { runnerPath } = ensureHelperScripts();
    const credPath = getCredFilePath(id);
    const geminiDir = getIsolatedGeminiDir(id);
    const tempDir = getIsolatedTempDir(id);
    const sharedBin = ensureSharedNodeWrapper();

    if (!fs.existsSync(credPath)) {
        throw new Error(`Windows account credentials missing for ${id}. Re-provision this account.`);
    }
    try { fs.mkdirSync(geminiDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}

    // Pass only safe/required overrides to child LS environment
    const basePathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const proxy = opts.proxy !== undefined ? opts.proxy : getUnlockerProxySync();
    const childEnv = buildIsolatedChildEnv({
        env,
        proxy,
        rawPath: process.env[basePathKey] || "",
        homeDir: os.homedir(),
        sharedBin,
    });

    const spec = {
        accountId: id,
        winUser,
        credPath,
        binaryPath,
        workingDir: geminiDir,
        tempDir,
        parentPid: process.pid,
        args: Array.isArray(args) ? args : [],
        env: childEnv,
        stdinPayload: String(stdinPayload || ""),
        proxyRegistry: planIsolatedProxyRegistry(getProxyMarkerPath(id), proxy),
    };
    if (proxy) {
        console.log(`[AgyWinIsolation] [${id}] routing isolated LS via proxy ${proxy.url} (${proxy.source})`);
    }

    const specB64 = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
    const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runnerPath],
        {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: {
                ...process.env,
                AGY_LS_LAUNCH_SPEC_B64: specB64,
            },
        }
    );
    proc.stdin?.on?.("error", () => {});
    proc.stdout?.on?.("error", () => {});
    proc.stderr?.on?.("error", () => {});
    proc.on?.("error", (err) => {
        console.error(`[AgyWinIsolation] [${id}] failed to spawn runner powershell.exe: ${err?.message || err}`);
    });
    return proc;
}

module.exports = {
    ACCOUNTS_DATA_ROOT,
    getSharedAppDir,
    getCredFilePath,
    getIsolatedAccountRoot,
    getIsolatedGeminiDir,
    getIsolatedTempDir,
    buildWinUsername,
    generateStrongPassword,
    buildAdminScriptContent,
    buildRunnerScriptContent,
    buildSanitizedChildPath,
    buildElevatedBootstrapScript,
    isIsolatedAccountProvisionedSync,
    checkWindowsUserExists,
    provisionIsolatedAccount,
    removeIsolatedAccount,
    grantWorkspaceAccess,
    spawnIsolatedLanguageServer,
    ensureHelperScripts,
    UNLOCKER_DEFAULT_PROXY_HOST,
    UNLOCKER_DEFAULT_PROXY_PORT,
    PROXY_NO_PROXY_LIST,
    PROXY_WININET_OVERRIDE,
    parseWinInetProxyServer,
    parseInternetSettingsRegOutput,
    probeTcpPort,
    resolveUnlockerProxy,
    getUnlockerProxySync,
    resetUnlockerProxyCache,
    mergeNoProxyList,
    buildProxyEnv,
    buildIsolatedChildEnv,
    planIsolatedProxyRegistry,
};
