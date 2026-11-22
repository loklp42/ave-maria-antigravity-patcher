"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

let electronApp = null;
try { electronApp = require("electron").app; } catch {}

const ACCOUNTS_DATA_ROOT = "C:\\ProgramData\\AntigravityAccounts";
const MAX_WIN_USERNAME_LEN = 20; // Windows NetBIOS SAM account name limit

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
    [Parameter(Mandatory=$true)][string]$SpecPath,
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
    $spec = Get-Content -Path $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
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
            try { Add-LocalGroupMember -Group "Users" -Member $winUser -ErrorAction SilentlyContinue } catch {}
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

        # 4. Prepare isolated account directories with strict ACLs (winUser + primaryUser + SYSTEM + Administrators)
        $dataRoot = Split-Path -Path $accountRoot -Parent
        foreach ($d in @($dataRoot, $accountRoot, $geminiDir, $tempDir, $sharedBinDir)) {
            if ($d -and -not (Test-Path $d)) {
                New-Item -ItemType Directory -Path $d -Force | Out-Null
            }
        }
        & icacls.exe $dataRoot /grant "Users:(NP)(RX)" /C /Q | Out-Null
        & icacls.exe $accountRoot /inheritance:r /grant "SYSTEM:(OI)(CI)F" /grant "Administrators:(OI)(CI)F" /grant ($winUser + ":(OI)(CI)F") /C /Q | Out-Null
        if ($primaryUser) {
            & icacls.exe $accountRoot /grant ($primaryUser + ":(OI)(CI)F") /C /Q | Out-Null
        }
        if ($sharedBinDir) {
            & icacls.exe $sharedBinDir /grant "Users:(OI)(CI)RX" /C /Q | Out-Null
        }

        # 5. Grant minimal read/execute access to Antigravity binaries without exposing primary user's home folder
        if ($installDir -and (Test-Path $installDir)) {
            Grant-TraverseParents -TargetPath $installDir -AccountName $winUser
            & icacls.exe $installDir /grant ($winUser + ":(OI)(CI)RX") /C /Q | Out-Null
        }

        Write-Result @{ ok = $true; action = "provision"; winUser = $winUser }
        exit 0
    }

    if ($Action -eq "remove") {
        $accountRoot = [string]$spec.accountRoot
        $regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
        if (Test-Path $regPath) {
            Remove-ItemProperty -Path $regPath -Name $winUser -ErrorAction SilentlyContinue
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
        if ($accountRoot -and $accountRoot.StartsWith("C:\ProgramData\AntigravityAccounts\") -and (Test-Path $accountRoot)) {
            Remove-Item -Path $accountRoot -Recurse -Force -ErrorAction SilentlyContinue
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
                SetInformationJobObject(job, 9, ptr, (uint)size);
            } finally {
                Marshal.FreeHGlobal(ptr);
            }
            AssignProcessToJobObject(job, processHandle);
            return job;
        } catch {
            CloseHandle(job);
            return IntPtr.Zero;
        }
    }
}
"@ -ErrorAction SilentlyContinue

function Escape-WinArg([string]$a) {
    if ($null -eq $a -or $a.Length -eq 0) { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $escaped = $a -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

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

# Sanitize user-specific environment variables so child process never tries writing into primary user's profile
$userProf = Join-Path "C:\Users" $winUser
$psi.EnvironmentVariables["USERNAME"] = $winUser
$psi.EnvironmentVariables["USERPROFILE"] = $userProf
$psi.EnvironmentVariables["HOME"] = $userProf
$psi.EnvironmentVariables["HOMEDRIVE"] = "C:"
$psi.EnvironmentVariables["HOMEPATH"] = "\Users\$winUser"
$psi.EnvironmentVariables["APPDATA"] = Join-Path $userProf "AppData\Roaming"
$psi.EnvironmentVariables["LOCALAPPDATA"] = Join-Path $userProf "AppData\Local"
if ($tempDir) {
    $psi.EnvironmentVariables["TEMP"] = $tempDir
    $psi.EnvironmentVariables["TMP"] = $tempDir
}
$psi.EnvironmentVariables.Remove("AGY_LS_LAUNCH_SPEC_B64")

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
try { $jobHandle = [AgyJobHelper]::CreateKillOnCloseJob($proc.Handle) } catch {}

try {
    if ($stdinPayload -and $stdinPayload.Length -gt 0) {
        $proc.StandardInput.Write($stdinPayload)
        $proc.StandardInput.Flush()
    }
    $proc.StandardInput.Close()
} catch {}

# Relay stdout and stderr asynchronously without deadlocking
$outTask = $proc.StandardOutput.ReadLineAsync()
$errTask = $proc.StandardError.ReadLineAsync()

$outOpen = $true
$errOpen = $true

try {
    while (-not $proc.HasExited -or $outOpen -or $errOpen) {
        if ($outOpen -and $outTask.IsCompleted) {
            $line = $null
            try { $line = $outTask.Result } catch {}
            if ($null -eq $line) {
                $outOpen = $false
            } else {
                [Console]::Out.WriteLine($line)
                [Console]::Out.Flush()
                $outTask = $proc.StandardOutput.ReadLineAsync()
            }
        }
        if ($errOpen -and $errTask.IsCompleted) {
            $eline = $null
            try { $eline = $errTask.Result } catch {}
            if ($null -eq $eline) {
                $errOpen = $false
            } else {
                [Console]::Error.WriteLine($eline)
                [Console]::Error.Flush()
                $errTask = $proc.StandardError.ReadLineAsync()
            }
        }

        # Watch parent Electron PID so we cleanly terminate child LS if parent disappears
        if ($parentPid -gt 0 -and -not $proc.HasExited) {
            $parentAlive = $true
            try {
                $pObj = [System.Diagnostics.Process]::GetProcessById($parentPid)
                if ($pObj.HasExited) { $parentAlive = $false }
            } catch {
                $parentAlive = $false
            }
            if (-not $parentAlive) {
                try { $proc.Kill() } catch {}
                break
            }
        }

        if ($proc.HasExited -and -not $outOpen -and -not $errOpen) {
            break
        }
        Start-Sleep -Milliseconds 35
    }
    $exitCode = 0
    if ($proc.HasExited) { $exitCode = $proc.ExitCode }
    exit $exitCode
} finally {
    try {
        if (-not $proc.HasExited) { $proc.Kill() }
    } catch {}
    if ($jobHandle -ne [IntPtr]::Zero) {
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
        fs.mkdirSync(sharedBin, { recursive: true });
        const wrapperPath = path.join(sharedBin, "agy-node.cmd");
        const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`;
        if (!fs.existsSync(wrapperPath) || fs.readFileSync(wrapperPath, "utf8") !== content) {
            fs.writeFileSync(wrapperPath, content, "utf8");
        }
        return sharedBin;
    } catch {
        return "";
    }
}

function runPowerShell(args, env = {}) {
    return new Promise((resolve) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
            {
                windowsHide: true,
                timeout: 120000,
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

function runPowerShellScript(scriptText, env = {}) {
    const encoded = Buffer.from(String(scriptText || ""), "utf16le").toString("base64");
    return runPowerShell(["-EncodedCommand", encoded], env);
}

async function saveEncryptedCredential(accountId, plainPassword) {
    fs.mkdirSync(getCredsDir(), { recursive: true });
    const credPath = getCredFilePath(accountId);
    const ps = `
$ErrorActionPreference = "Stop"
$sec = ConvertTo-SecureString -String $env:AGY_PLAIN_PWD -AsPlainText -Force
$enc = ConvertFrom-SecureString -SecureString $sec
[System.IO.File]::WriteAllText($env:AGY_CRED_OUT, $enc, [System.Text.Encoding]::UTF8)
`;
    const res = await runPowerShellScript(ps, {
        AGY_PLAIN_PWD: plainPassword,
        AGY_CRED_OUT: credPath,
    });
    if (!res.ok) {
        throw new Error(`Failed to store DPAPI credential: ${res.stderr || res.error}`);
    }
    return credPath;
}

async function runElevatedAdminAction(action, spec) {
    const { adminPath } = ensureHelperScripts();
    const tmpDir = os.tmpdir();
    const token = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const specPath = path.join(tmpDir, `agy_spec_${token}.json`);
    const resultPath = path.join(tmpDir, `agy_res_${token}.json`);

    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    try {
        // Trigger UAC prompt once via Start-Process -Verb RunAs -Wait.
        // Quote all path arguments explicitly because Windows profile paths may contain spaces (e.g. "John Doe").
        const launcher = `
$ErrorActionPreference = "Stop"
$argList = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $env:AGY_ADMIN_SCRIPT),
    "-Action", $env:AGY_ADMIN_ACTION,
    "-SpecPath", ('"{0}"' -f $env:AGY_ADMIN_SPEC),
    "-ResultPath", ('"{0}"' -f $env:AGY_ADMIN_RES)
)
$p = Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -WindowStyle Hidden -Wait -PassThru
exit $p.ExitCode
`;
        const runRes = await runPowerShellScript(launcher, {
            AGY_ADMIN_SCRIPT: adminPath,
            AGY_ADMIN_ACTION: action,
            AGY_ADMIN_SPEC: specPath,
            AGY_ADMIN_RES: resultPath,
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
        try { if (fs.existsSync(specPath)) fs.unlinkSync(specPath); } catch {}
        try { if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); } catch {}
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
    try { if (fs.existsSync(credPath)) fs.unlinkSync(credPath); } catch {}
    if (process.platform !== "win32" || !winUser) {
        return { ok: true };
    }
    return runElevatedAdminAction("remove", {
        winUser,
        accountRoot: getIsolatedAccountRoot(id),
    });
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
    try {
        const resolved = path.resolve(folderPath);
        if (!fs.existsSync(resolved)) {
            return { ok: false, error: "folder_not_found" };
        }
        // Grant non-inheriting Traverse (X) on parent directories if inside user profile,
        // and Modify (OI)(CI)M on the workspace folder itself.
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
& icacls.exe $target /grant ($user + ":(OI)(CI)M") /T /C /Q | Out-Null
Write-Output "OK"
`;
        const res = await runPowerShellScript(ps, {
            AGY_GRANT_DIR: resolved,
            AGY_GRANT_USER: winUser,
        });
        return { ok: res.ok, stderr: res.stderr };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
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
    const childEnv = {};
    const forwardKeys = [
        "ANTIGRAVITY_SERVER_CSRF_TOKEN",
        "AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP",
        "CHROME_DEVTOOLS_MCP_JS",
        "CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY",
        "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS",
        "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS",
        "AGY_BROWSER_ACTIVE_PORT_FILE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ];
    for (const k of forwardKeys) {
        if (env && env[k] !== undefined) {
            childEnv[k] = String(env[k]);
        }
    }
    // Make LS print ANTIGRAVITY_OPEN_URL so Electron opens OAuth in the primary user's browser
    childEnv["ANTIGRAVITY_VSCODE_HOST"] = "1";

    // Build clean PATH with shared node wrapper instead of primary user's AppData
    const basePathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const sysPath = String(process.env[basePathKey] || "");
    if (sharedBin) {
        childEnv["PATH"] = `${sharedBin};${sysPath}`;
    }

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
    };

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
    isIsolatedAccountProvisionedSync,
    checkWindowsUserExists,
    provisionIsolatedAccount,
    removeIsolatedAccount,
    grantWorkspaceAccess,
    spawnIsolatedLanguageServer,
    ensureHelperScripts,
};
