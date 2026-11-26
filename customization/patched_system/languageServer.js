"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LS_BINARY = void 0;
exports.getLsCL = getLsCL;
exports.extractOpenUrl = extractOpenUrl;
exports.getLsProcess = getLsProcess;
exports.getLsPort = getLsPort;
exports.getLsCsrfToken = getLsCsrfToken;
exports.getLsBaseUrl = getLsBaseUrl;
exports.mintLanguageServerBootstrapToken = mintLanguageServerBootstrapToken;
exports.clearLsProcess = clearLsProcess;
exports.extractCrashStackTrace = extractCrashStackTrace;
exports.prefetchShellEnv = prefetchShellEnv;
exports.startLanguageServer = startLanguageServer;
exports.setIntentionalTermination = setIntentionalTermination;
exports.startAndMonitorLanguageServer = startAndMonitorLanguageServer;
exports.configureLanguageServerPool = configureLanguageServerPool;
exports.ensureProfileServer = ensureProfileServer;
exports.getProfileServerInfo = getProfileServerInfo;
exports.setActiveProfileServer = setActiveProfileServer;
exports.switchActiveProfileInPlace = switchActiveProfileInPlace;
exports.stopProfileServer = stopProfileServer;
exports.getRunningProfiles = getRunningProfiles;
exports.consumeForceRootReload = consumeForceRootReload;
exports.killLanguageServer = killLanguageServer;
exports.setupLocalCertTrust = setupLocalCertTrust;
exports.setupLocalCertTrustForSession = setupLocalCertTrustForSession;
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path_1 = __importDefault(require("path"));
const readline = __importStar(require("readline"));
const stream_1 = require("stream");
const util_1 = require("util");
const authBootstrap_1 = require("./authBootstrap");
const paths_1 = require("./paths");
const utils_1 = require("./utils");
const wsl_1 = require("./wsl");
const lsDefaults_1 = require("./lsDefaults");
const loginShellEnvReads_1 = require("./loginShellEnvReads");
const winIsolation = require("./agyWinUserIsolation");
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LS_STARTUP_TIMEOUT_MS = 60000;
// ---------------------------------------------------------------------------
// Crash Monitoring Constants
// ---------------------------------------------------------------------------
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS = 3;
const RESTART_COOLDOWN_MS = 2000;
const MAX_STDERR_BUFFER = 100000;
/** Exit code used by `language_server` when requesting an immediate self-restart. */
const LS_RESTART_EXIT_CODE = 42;
const CRASH_TRIGGER_PHRASES = [
    'panic:',
    'fatal error:',
    'unexpected fault address',
    'runtime:',
    'running GoogleExitFunction',
    'panic serving',
];
const isWindows = process.platform === 'win32';
const binName = isWindows ? 'language_server.exe' : 'language_server';
exports.LS_BINARY = electron_1.app?.isPackaged && process.resourcesPath
    ? path_1.default.join(process.resourcesPath, 'bin', binName)
    : process.env.CODEIUM_LANGUAGE_SERVER_BIN ||
        path_1.default.join(__dirname, '..', 'bin', binName);
/**
 * Gets the build CL of the language server by running it with --stamp.
 */
function getLsCL() {
    return new Promise((resolve) => {
        (0, child_process_1.execFile)(exports.LS_BINARY, ['--stamp'], (error, stdout, _stderr) => {
            if (error) {
                console.error('Failed to get LS stamp:', error);
                resolve('');
                return;
            }
            const match = /Built at CL: (\d+)/.exec(stdout);
            if (match) {
                resolve(match[1]);
            }
            else {
                resolve('');
            }
        });
    });
}
// Pattern: "listening on <proto> port at <N> for HTTP or HTTPS"
const PORT_PATTERN = /listening on \w+ port at (\d+) for HTTP(S)?\b/i;
// Pattern: OAuth authorization URL
const AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/;
// Pattern: URL the LS asks the host to open (printed instead of opening a
// browser when ANTIGRAVITY_VSCODE_HOST=1 is set, e.g. sign-in in WSL mode).
const OPEN_URL_PATTERN = /ANTIGRAVITY_OPEN_URL: (\S+)/;
/** Returns the validated http(s) URL from an ANTIGRAVITY_OPEN_URL line, if any. */
function extractOpenUrl(line) {
    const m = OPEN_URL_PATTERN.exec(line);
    if (!m || !URL.canParse(m[1])) {
        return null;
    }
    return /^https?:$/.test(new URL(m[1]).protocol) ? m[1] : null;
}
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _lsProcess = null;
let _intentionalTermination = false;
let _restartCount = 0;
let _lastRestartTime = 0;
let _lsStdinIsLiveness = false;
let _killLsPromise = null;
let _lastStartParams = null;
let _profileSwitchPromise = null;
let _forceRootReload = false;
const _profileServers = new Map();
const _startingPromises = new Map();
const _restartCounters = new Map();
const _profileGenerations = new Map();
const _profileQueues = new Map();
const _pendingRestartTimers = new Map();
let _poolBaseOptions = null;

function getProfileGeneration(key) {
    return _profileGenerations.get(key) || 0;
}
function cancelPendingRestart(key) {
    const pending = _pendingRestartTimers.get(key);
    if (pending) {
        _pendingRestartTimers.delete(key);
        try { pending.cancel(); } catch {}
    }
}
function bumpProfileGeneration(key) {
    const next = getProfileGeneration(key) + 1;
    _profileGenerations.set(key, next);
    cancelPendingRestart(key);
    return next;
}
function enqueueProfileOp(key, fn) {
    const prev = _profileQueues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    _profileQueues.set(key, tail);
    tail.finally(() => {
        if (_profileQueues.get(key) === tail) {
            _profileQueues.delete(key);
        }
    });
    return next;
}
function configureLanguageServerPool(options = {}) {
    _poolBaseOptions = { ...(options || {}) };
    if (!_lastStartParams) {
        _lastStartParams = {
            port: 0,
            csrf: crypto.randomUUID(),
            options: _poolBaseOptions,
        };
    }
    else {
        _lastStartParams.options = { ..._lastStartParams.options, ..._poolBaseOptions };
    }
}
function getProfileServerInfo(profileId) {
    const key = normalizeProfileKey(profileId);
    const entry = _profileServers.get(key);
    if (!entry || !isServerEntryAlive(entry)) {
        return null;
    }
    return {
        profileKey: key,
        port: entry.port,
        csrf: entry.csrf,
        baseUrl: `https://127.0.0.1:${entry.port}`,
        running: true,
        winUser: entry.winUser || '',
        geminiDir: entry.geminiDir || '',
    };
}
function setActiveProfileServer(profileId) {
    const key = normalizeProfileKey(profileId);
    const entry = _profileServers.get(key);
    (0, paths_1.setActiveProfileName)(key === 'default' ? '' : key, false);
    if (entry && isServerEntryAlive(entry)) {
        _lsProcess = entry.process;
        _lsStdinIsLiveness = entry.stdinIsLiveness;
        (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: entry.port, csrfToken: entry.csrf });
        return { ok: true, port: entry.port, csrf: entry.csrf, profileKey: key };
    }
    return { ok: false, profileKey: key };
}
function normalizeProfileKey(raw) {
    const clean = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return clean || 'default';
}
function getActiveProfileKey() {
    return normalizeProfileKey((0, paths_1.getActiveProfileName)());
}
function isServerEntryAlive(entry) {
    if (!entry || !entry.process || !entry.port) {
        return false;
    }
    const p = entry.process;
    return (p.exitCode ?? null) === null && (p.signalCode ?? null) === null && !p.killed;
}
function getRunningProfiles() {
    const out = [];
    for (const [key, entry] of _profileServers.entries()) {
        if (isServerEntryAlive(entry)) {
            out.push(key);
        }
    }
    return out;
}
function consumeForceRootReload() {
    const v = _forceRootReload;
    _forceRootReload = false;
    return v;
}
/** Returns the active language server process, or null if not running. */
function getLsProcess() {
    return _lsProcess;
}
/** Returns the active language server port, or 0 if not running. */
function getLsPort() {
    return (0, authBootstrap_1.getActiveLsPort)();
}
/** Returns the active language server admin CSRF token held in main-process memory. */
function getLsCsrfToken() {
    return (0, authBootstrap_1.getActiveLsCsrfToken)();
}
/** Returns the base URL (e.g. `https://127.0.0.1:54321`) of the active language server, if running. */
function getLsBaseUrl() {
    return (0, authBootstrap_1.getActiveLsBaseUrl)();
}
/** Mints a single-use UI bootstrap token from `POST /auth/mint` on the active language server. */
async function mintLanguageServerBootstrapToken() {
    return (0, authBootstrap_1.mintActiveLsBootstrapToken)();
}
/** Clears the language server process reference (call after killing it). */
function clearLsProcess() {
    _lsProcess = null;
}
// ---------------------------------------------------------------------------
// Crash log extraction
// ---------------------------------------------------------------------------
/**
 * Extract lines after a crash trigger phrase from a list of stderr lines.
 * Returns all lines from the first trigger phrase onwards.
 */
function getLinesAfterCrash(lines) {
    const crashLines = [];
    let foundTrigger = false;
    for (const line of lines) {
        if (CRASH_TRIGGER_PHRASES.some((phrase) => line.includes(phrase))) {
            foundTrigger = true;
        }
        if (foundTrigger) {
            crashLines.push(line);
        }
    }
    return crashLines;
}
/**
 * Best-effort extraction of the crash stack trace from buffered stderr.
 * Returns the stack trace string, or undefined if no trigger phrase was found.
 */
function extractCrashStackTrace(stderr) {
    const lines = stderr.split('\n');
    const crashLines = getLinesAfterCrash(lines);
    return crashLines.length > 0 ? crashLines.join('\n') : undefined;
}
/**
 * Sets environment variables for bundled node modules so the language
 * server can find them.
 *
 * NOTE: If you add a new module that needs to be executed this way:
 * 1. Add it to `asarUnpack` in `package.json` so it is available on the filesystem.
 * 2. Add it to `modules` in the callsite of setupNodeModules.
 */
function setupNodeModules(env, modules) {
    for (const mod of modules) {
        let entryPoint = '';
        if (!electron_1.app.isPackaged) {
            entryPoint = path_1.default.join(__dirname, '..', 'node_modules', mod.name, ...mod.relativePath);
        }
        else {
            entryPoint = path_1.default.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', mod.name, ...mod.relativePath);
        }
        env[mod.envVar] = entryPoint;
    }
}
// Not with the shell-env package: the process-wide exit and signal hooks of
// its execa dependency reset Electron's SIGTERM handling, after which a
// SIGTERM killed the app without running before-quit (so the language server
// was not shut down).
const shellEnvReads = new loginShellEnvReads_1.LoginShellEnvReads(false);
let _cachedShellEnv = null;
/**
 * Starts loading the login-shell env (spawns an interactive shell, which can
 * take seconds with heavy rc files) so it overlaps app startup instead of
 * blocking the LS spawn. Consumed by the next startLanguageServer call, which
 * waits 10 s at most; later calls (LS restarts) reload it so rc edits are
 * still picked up, unless a read is still running.
 */
function prefetchShellEnv() {
    shellEnvReads.prefetch();
}
/**
 * Spawn the language server and resolve with a LanguageServerHandle once
 * the LS reports its HTTP port. Rejects on timeout or unexpected exit
 * during startup.
 *
 * After resolving, callers should monitor `handle.exitPromise` to detect
 * crashes that occur after startup.
 */
async function startLanguageServer(port, csrf, options = {}) {
    const { headless, hostBridgeUrl, hostBridgeToken, wsl, profileId, winUser, geminiDir: explicitGeminiDir } = options;
    const profileKey = normalizeProfileKey(profileId !== undefined ? profileId : (0, paths_1.getActiveProfileName)());
    const profileArg = profileKey === 'default' ? '' : profileKey;
    const useWinIsolation = Boolean(isWindows && profileArg && winUser);
    const resolvedGeminiDir = profileArg
        ? (explicitGeminiDir || (useWinIsolation ? winIsolation.getIsolatedGeminiDir(profileArg) : (0, paths_1.getGeminiDirForProfile)(profileArg)))
        : '';
    const isForActive = profileKey === getActiveProfileKey();
    const loginShellEnv = _cachedShellEnv !== null
        ? _cachedShellEnv
        : await shellEnvReads.take();
    if (_cachedShellEnv === null) {
        _cachedShellEnv = loginShellEnv;
    }
    if (_intentionalTermination) {
        throw new Error('Language server startup aborted during shutdown');
    }
    return new Promise((resolve, reject) => {
        let logStreamEnded = false;
        let logStreamBroken = false;
        const logStream = fs.createWriteStream((0, paths_1.getLsLogPath)(profileArg), { flags: 'w' });
        logStream.on('error', (err) => {
            logStreamBroken = true;
            console.warn(`[LS] Log stream error [${profileKey}]:`, err?.message || err);
            try { logStream.destroy?.(); } catch {}
        });
        const closeLogStream = () => {
            if (!logStreamEnded) {
                logStreamEnded = true;
                if (!logStreamBroken) {
                    try { logStream.end(); } catch {}
                }
            }
        };
        if (isForActive) {
            (0, authBootstrap_1.setActiveLanguageServerAuth)({ csrfToken: csrf });
        }
        // We need to pass the override flags because the LS is running in standalone mode.
        // Secrets (CSRF token and host bridge token) are passed via child env / stdin
        // rather than CLI argv so they are never exposed in `ps` or `/proc/<pid>/cmdline`.
        const args = [
            ...(0, lsDefaults_1.baseLsArgs)({
                ideVersion: electron_1.app.getVersion(),
                httpsServerPort: port,
                appDataDir: (0, paths_1.getAppDataDirName)(profileArg),
                overrideIdeName: (0, paths_1.getOverrideIdeName)(),
            }),
            '--enable_sidecars',
        ];
        if (profileArg && resolvedGeminiDir) {
            try { fs.mkdirSync(resolvedGeminiDir, isWindows ? { recursive: true } : { recursive: true, mode: 0o700 }); } catch {}
            args.push(`--gemini_dir=${resolvedGeminiDir}`);
        }
        // Point the LS at the main process' host bridge server. The LS tolerates
        // these being absent, but we always pass them when the server is up.
        const hasHostBridgeToken = Boolean(hostBridgeUrl && hostBridgeToken);
        if (hasHostBridgeToken) {
            args.push(`--host_bridge_url=${hostBridgeUrl}`, '--read_host_bridge_token_from_stdin');
        }
        if (headless) {
            args.push('--headless');
        }
        let spawnCmd = exports.LS_BINARY;
        let spawnArgs = args;
        if (wsl && !useWinIsolation) {
            // ANTIGRAVITY_VSCODE_HOST=1 makes the LS print sign-in URLs
            // --exit_on_stdin_close ties the LS lifetime to our stdin pipe
            args.push('--exit_on_stdin_close');
            spawnCmd = wsl_1.WSL_EXE;
            spawnArgs = (0, wsl_1.wslShellArgs)(wsl.distro, `ANTIGRAVITY_VSCODE_HOST=1 exec "${wsl.binaryPath}" "$@"`, args);
        }
        // Electron apps don't inherit shell environment variables when they are not launched through the terminal.
        // We need to load the shell env explicitly so the language server can discover tools in the user's environment.
        const env = { ...process.env, ...loginShellEnv };
        env['ANTIGRAVITY_SERVER_CSRF_TOKEN'] = csrf;
        env['AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP'] = '1';
        if (!isWindows && profileArg && resolvedGeminiDir) {
            const xdgBase = path_1.default.join(resolvedGeminiDir, '.xdg');
            const xdgConfig = path_1.default.join(xdgBase, 'config');
            const xdgData = path_1.default.join(xdgBase, 'data');
            const xdgCache = path_1.default.join(xdgBase, 'cache');
            const xdgState = path_1.default.join(xdgBase, 'state');
            for (const dir of [xdgBase, xdgConfig, xdgData, xdgCache, xdgState]) {
                try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
            }
            env['XDG_CONFIG_HOME'] = xdgConfig;
            env['XDG_DATA_HOME'] = xdgData;
            env['XDG_CACHE_HOME'] = xdgCache;
            env['XDG_STATE_HOME'] = xdgState;
        }
        if (wsl && !useWinIsolation) {
            (0, authBootstrap_1.appendWslAuthEnvForwarding)(env);
        }
        if (electron_1.app.commandLine?.hasSwitch?.('remote-debugging-port')) {
            // Pass the path without reading it so LS discovers the opt-in debug port lazily.
            env['AGY_BROWSER_ACTIVE_PORT_FILE'] = (0, paths_1.getActivePortFilePath)();
        }
        else {
            delete env['AGY_BROWSER_ACTIVE_PORT_FILE'];
            delete env['AGY_BROWSER_WS_URL'];
        }
        if (!useWinIsolation) {
            (0, utils_1.setupNodeWrapper)(env);
        }
        setupNodeModules(env, [
            {
                name: 'chrome-devtools-mcp',
                envVar: 'CHROME_DEVTOOLS_MCP_JS',
                relativePath: ['build', 'src', 'bin', 'chrome-devtools-mcp.js'],
            },
        ]);
        // Disable implicit cd4a.config.json discovery/watch, usage telemetry, and
        // detached npm update checks in Hub-spawned chrome-devtools-mcp processes.
        env['CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY'] = '1';
        env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] = '1';
        env['CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS'] = '1';
        const stdinPayload = hasHostBridgeToken && hostBridgeToken ? `${hostBridgeToken}\n\n` : '';
        let proc;
        if (useWinIsolation) {
            console.log(`Spawning [${profileKey}] isolated as Windows user "${winUser}": ${exports.LS_BINARY} ${(0, authBootstrap_1.redactSensitiveArgsForLog)(args).join(' ')}`);
            try {
                proc = winIsolation.spawnIsolatedLanguageServer({
                    accountId: profileKey,
                    winUser,
                    binaryPath: exports.LS_BINARY,
                    args,
                    env,
                    stdinPayload,
                });
            }
            catch (spawnErr) {
                closeLogStream();
                reject(spawnErr);
                return;
            }
        }
        else {
            console.log(`Spawning [${profileKey}]: ${spawnCmd} ${(0, authBootstrap_1.redactSensitiveArgsForLog)(spawnArgs).join(' ')}`);
            try {
                proc = (0, child_process_1.spawn)(spawnCmd, spawnArgs, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                });
            }
            catch (spawnErr) {
                closeLogStream();
                reject(spawnErr);
                return;
            }
        }
        const stdinIsLiveness = !!wsl && !useWinIsolation;
        if (isForActive) {
            _lsProcess = proc;
            _lsStdinIsLiveness = stdinIsLiveness;
        }
        proc.stdin?.on?.('error', () => {
            // Ignore EPIPE if the child exits before consuming stdin.
        });
        proc.stdout?.on?.('error', () => {});
        proc.stderr?.on?.('error', () => {});
        if (!useWinIsolation) {
            if (hasHostBridgeToken && hostBridgeToken) {
                if (wsl) {
                    // `--exit_on_stdin_close` is true: `readHostTokensFromStdin` returns
                    // immediately after line 1, and stdin must stay open for liveness.
                    proc.stdin?.write?.(`${hostBridgeToken}\n`);
                }
                else if (headless) {
                    // `--exit_on_stdin_close` is false, and stdin stays open for headless
                    // OAuth input: send line 1 + empty line 2 so LS startup does not block.
                    proc.stdin?.write?.(`${hostBridgeToken}\n\n`);
                }
                else {
                    // Desktop local mode: write hostBridgeToken + empty line 2 and close stdin.
                    proc.stdin?.end?.(`${hostBridgeToken}\n\n`);
                }
            }
            else if (!headless && !wsl) {
                // Close stdin immediately — the LS may block waiting for metadata on stdin.
                // In WSL mode stdin must stay open: it is the LS's liveness signal.
                proc.stdin?.end?.();
            }
        }
        else {
            proc.stdin?.end?.();
        }
        const combined = new stream_1.PassThrough();
        combined.on('error', () => {});
        proc.stdout?.pipe(combined, { end: false });
        proc.stderr?.pipe(combined, { end: false });
        // Buffer stderr for crash log extraction (ring buffer)
        const stderrChunks = [];
        let stderrLength = 0;
        proc.stderr?.on('data', (data) => {
            const str = data.toString();
            stderrChunks.push(str);
            stderrLength += str.length;
            while (stderrChunks.length > 0 && stderrLength > MAX_STDERR_BUFFER) {
                stderrLength -= stderrChunks.shift().length;
            }
        });
        let resolved = false;
        let settledExit = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { void killSingleProcess(proc, stdinIsLiveness); } catch {}
                reject(new Error(`Timeout: language server did not report its port within ${LS_STARTUP_TIMEOUT_MS / 1000}s`));
            }
        }, LS_STARTUP_TIMEOUT_MS);
        const rl = readline.createInterface({ input: combined, crlfDelay: Infinity });
        rl.on('error', () => {});
        rl.on('close', () => {
            closeLogStream();
        });
        rl.on('line', (line) => {
            if (!logStreamEnded && !logStreamBroken) {
                try { logStream.write(line + '\n'); } catch {}
            }
            if (!resolved) {
                const m = PORT_PATTERN.exec(line);
                if (m) {
                    resolved = true;
                    clearTimeout(timer);
                    const actualPort = parseInt(m[1], 10);
                    if (profileKey === getActiveProfileKey()) {
                        (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: actualPort, csrfToken: csrf });
                    }
                    resolve({
                        port: actualPort,
                        process: proc,
                        exitPromise,
                        profileKey,
                        stdinIsLiveness,
                    });
                }
            }
            const authMatch = AUTH_URL_PATTERN.exec(line);
            if (authMatch) {
                const safeAuthUrl = (0, authBootstrap_1.redactUrlTokens)(authMatch[0]);
                console.log('\n' + '='.repeat(60));
                console.log('  Please visit the following URL to authorize.');
                console.log('  After authorizing, paste the authorization code below.');
                console.log(`  ${safeAuthUrl}`);
                console.log('='.repeat(60) + '\n');
            }
            const openUrl = extractOpenUrl(line);
            if (openUrl) {
                const safeLog = (0, authBootstrap_1.redactUrlTokens)(openUrl);
                let parsed = null;
                try { parsed = new URL(openUrl); } catch {}
                const isGoogleOAuth = Boolean(parsed && parsed.protocol === 'https:' && /(?:^|\.)accounts\.google\.com$/i.test(parsed.hostname));
                if (!parsed || (useWinIsolation && !isGoogleOAuth)) {
                    console.warn(`[Isolation] Blocked non-OAuth openExternal from isolated LS [${profileKey}]: ${safeLog}`);
                }
                else {
                    console.log(`Opening URL requested by the language server: ${safeLog}`);
                    if (isGoogleOAuth) {
                        try { require('./agyTabManager').recordOAuthInitiator?.(profileKey, openUrl); } catch {}
                    }
                    void require('./externalUrl').openExternalSafely(openUrl, 'unconfirmed');
                }
            }
        });
        // Exit promise — resolves whenever the process exits (whether during
        // startup or after). Includes crash stack trace extraction.
        const exitPromise = new Promise((exitResolve) => {
            const cleanupProcResources = () => {
                if (_lsProcess === proc) {
                    clearLsProcess();
                }
                const pooled = _profileServers.get(profileKey);
                if (pooled && pooled.process === proc) {
                    _profileServers.delete(profileKey);
                }
                try { rl.close(); } catch {}
                closeLogStream();
            };
            proc.on('error', (err) => {
                cleanupProcResources();
                clearTimeout(timer);
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Failed to spawn language server (${spawnCmd}): ${err?.message || err}`));
                }
                if (!settledExit) {
                    settledExit = true;
                    exitResolve({ code: null, signal: null, error: err, crashStackTrace: undefined });
                }
            });
            proc.on('exit', (code, signal) => {
                cleanupProcResources();
                const fullStderr = stderrChunks.join('');
                const crashStackTrace = extractCrashStackTrace(fullStderr);
                // If we haven't resolved the startup promise yet, reject it.
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    reject(new Error(`Language server exited unexpectedly (code=${code}, signal=${signal})`));
                }
                if (!settledExit) {
                    settledExit = true;
                    exitResolve({ code, signal, crashStackTrace });
                }
            });
        });
    });
}
/** Sets whether the termination was intentional (suppresses crash reports). */
function setIntentionalTermination(value) {
    _intentionalTermination = value;
}
/**
 * Start the language server AND set up the restart monitoring loop.
 * Resolves with the handle on first successful startup.
 */
async function startAndMonitorLanguageServer(port, csrf, options = {}) {
    _lastStartParams = { port, csrf, options };
    setIntentionalTermination(false); // Reset
    const profileKey = normalizeProfileKey(options.profileId !== undefined ? options.profileId : (0, paths_1.getActiveProfileName)());
    const gen = bumpProfileGeneration(profileKey);
    const handle = await startLanguageServer(port, csrf, { ...options, profileId: profileKey });
    const entry = {
        profileKey,
        generation: gen,
        process: handle.process,
        port: handle.port,
        csrf,
        exitPromise: handle.exitPromise,
        stdinIsLiveness: handle.stdinIsLiveness,
        intentionalStop: false,
        winUser: options.winUser || '',
        geminiDir: options.geminiDir || '',
    };
    _profileServers.set(profileKey, entry);
    _restartCounters.set(profileKey, { count: 0, lastTime: 0 });
    if (profileKey === getActiveProfileKey()) {
        _lsProcess = entry.process;
        _lsStdinIsLiveness = entry.stdinIsLiveness;
        (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: entry.port, csrfToken: csrf });
        if (options.onPortChanged) {
            options.onPortChanged(entry.port);
        }
    }
    monitorLsCrashInternal(entry, port, csrf, options);
    return handle;
}
async function switchActiveProfileInPlace(targetProfileId) {
    const requestedProfile = String(targetProfileId ?? '').trim().toLowerCase();
    if (!requestedProfile || !/^[a-z0-9_-]+$/.test(requestedProfile)) {
        throw new Error('invalid_profile_id');
    }
    if (!_lastStartParams) {
        throw new Error('Language server has not started yet');
    }
    if (_profileSwitchPromise) {
        return _profileSwitchPromise;
    }
    _profileSwitchPromise = enqueueProfileOp(normalizeProfileKey(requestedProfile), async () => {
        const targetKey = normalizeProfileKey(requestedProfile);
        const prevKey = getActiveProfileKey();
        const existing = _profileServers.get(targetKey);

        if (targetKey === prevKey && isServerEntryAlive(existing)) {
            return { ok: true, same: true, profile: targetKey, port: existing.port, reused: true };
        }

        // Reuse already-running LS for target profile (instant switch, keeps all other profiles' agents alive!)
        if (isServerEntryAlive(existing)) {
            (0, paths_1.setActiveProfileName)(targetKey === 'default' ? '' : targetKey, true);
            _lsProcess = existing.process;
            _lsStdinIsLiveness = existing.stdinIsLiveness;
            _forceRootReload = true;
            (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: existing.port, csrfToken: existing.csrf });
            _lastStartParams.options?.onPortChanged?.(existing.port);
            return { ok: true, profile: targetKey, port: existing.port, reused: true };
        }

        // Spawn a dedicated LS for the target profile WITHOUT killing the previous profile's LS!
        const profileArg = targetKey === 'default' ? '' : targetKey;
        let accWinUser = '';
        let accGeminiDir = '';
        try {
            const acc = require('./agyAccounts').getAccountById?.(targetKey);
            if (acc) {
                accWinUser = acc.winUser || '';
                accGeminiDir = acc.geminiDir || '';
            }
        } catch {}
        if (profileArg) {
            const gDir = accGeminiDir || (0, paths_1.getGeminiDirForProfile)(profileArg);
            try { fs.mkdirSync(gDir, process.platform === 'win32' ? { recursive: true } : { recursive: true, mode: 0o700 }); } catch {}
        }
        const gen = bumpProfileGeneration(targetKey);
        const spawnOptions = {
            ..._lastStartParams.options,
            profileId: targetKey,
            winUser: accWinUser,
            geminiDir: accGeminiDir,
        };
        const freshCsrf = crypto.randomUUID();
        const handle = await startLanguageServer(0, freshCsrf, spawnOptions);
        if (_intentionalTermination || getProfileGeneration(targetKey) !== gen) {
            await killSingleProcess(handle.process, handle.stdinIsLiveness).catch(() => {});
            throw new Error('Profile switch superseded');
        }
        const entry = {
            profileKey: targetKey,
            generation: gen,
            process: handle.process,
            port: handle.port,
            csrf: freshCsrf,
            exitPromise: handle.exitPromise,
            stdinIsLiveness: handle.stdinIsLiveness,
            intentionalStop: false,
            winUser: accWinUser,
            geminiDir: accGeminiDir,
        };
        _profileServers.set(targetKey, entry);
        (0, paths_1.setActiveProfileName)(profileArg, true);
        _lsProcess = entry.process;
        _lsStdinIsLiveness = entry.stdinIsLiveness;
        _restartCounters.set(targetKey, { count: 0, lastTime: 0 });
        _forceRootReload = true;
        (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: entry.port, csrfToken: entry.csrf });
        monitorLsCrashInternal(entry, 0, entry.csrf, spawnOptions);
        spawnOptions.onPortChanged?.(entry.port);
        return { ok: true, profile: targetKey, port: entry.port, reused: false };
    }).finally(() => {
        _profileSwitchPromise = null;
    });
    return _profileSwitchPromise;
}
async function ensureProfileServer(profileId, extraOptions = {}) {
    const profileKey = normalizeProfileKey(profileId);
    const existing = _profileServers.get(profileKey);
    if (!_profileQueues.has(profileKey) && isServerEntryAlive(existing)) {
        return {
            ok: true,
            reused: true,
            profileKey,
            port: existing.port,
            csrf: existing.csrf,
            baseUrl: `https://127.0.0.1:${existing.port}`,
            winUser: existing.winUser || '',
            geminiDir: existing.geminiDir || '',
        };
    }
    const pending = _startingPromises.get(profileKey);
    if (pending && pending._gen === getProfileGeneration(profileKey)) {
        return pending;
    }
    const startGen = bumpProfileGeneration(profileKey);
    const startPromise = enqueueProfileOp(profileKey, async () => {
        const queuedExisting = _profileServers.get(profileKey);
        if (isServerEntryAlive(queuedExisting)) {
            return {
                ok: true,
                reused: true,
                profileKey,
                port: queuedExisting.port,
                csrf: queuedExisting.csrf,
                baseUrl: `https://127.0.0.1:${queuedExisting.port}`,
                winUser: queuedExisting.winUser || '',
                geminiDir: queuedExisting.geminiDir || '',
            };
        }
        if (_intentionalTermination || getProfileGeneration(profileKey) !== startGen) {
            throw new Error(`Language server startup superseded for [${profileKey}]`);
        }
        setIntentionalTermination(false);
        const baseOpts = _poolBaseOptions || _lastStartParams?.options || {};
        const csrf = crypto.randomUUID();
        const mergedOptions = {
            ...baseOpts,
            ...extraOptions,
            profileId: profileKey,
        };
        const targetPort = profileKey === 'default' && Number(process.env.JETSKI_LS_PORT) > 0
            ? Number(process.env.JETSKI_LS_PORT)
            : 0;
        const handle = await startLanguageServer(targetPort, csrf, mergedOptions);
        if (_intentionalTermination || getProfileGeneration(profileKey) !== startGen) {
            await killSingleProcess(handle.process, handle.stdinIsLiveness).catch(() => {});
            throw new Error(`Language server startup superseded for [${profileKey}]`);
        }
        const entry = {
            profileKey,
            generation: startGen,
            process: handle.process,
            port: handle.port,
            csrf,
            exitPromise: handle.exitPromise,
            stdinIsLiveness: handle.stdinIsLiveness,
            intentionalStop: false,
            winUser: mergedOptions.winUser || '',
            geminiDir: mergedOptions.geminiDir || '',
        };
        _profileServers.set(profileKey, entry);
        _restartCounters.set(profileKey, { count: 0, lastTime: 0 });
        if (profileKey === getActiveProfileKey()) {
            _lsProcess = entry.process;
            _lsStdinIsLiveness = entry.stdinIsLiveness;
            (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: entry.port, csrfToken: csrf });
        }
        setupLocalCertTrust();
        monitorLsCrashInternal(entry, 0, csrf, mergedOptions);
        mergedOptions.onInstancePortChanged?.(profileKey, entry.port, csrf);
        return {
            ok: true,
            reused: false,
            profileKey,
            port: entry.port,
            csrf,
            baseUrl: `https://127.0.0.1:${entry.port}`,
            winUser: entry.winUser,
            geminiDir: entry.geminiDir,
        };
    }).finally(() => {
        if (_startingPromises.get(profileKey) === startPromise) {
            _startingPromises.delete(profileKey);
        }
    });
    startPromise._gen = startGen;
    _startingPromises.set(profileKey, startPromise);
    return startPromise;
}
async function stopProfileServer(profileId, opts = {}) {
    const targetKey = normalizeProfileKey(profileId);
    if (!opts.allowActive && targetKey === getActiveProfileKey()) {
        return { ok: false, error: 'cannot_stop_active' };
    }
    bumpProfileGeneration(targetKey);
    const current = _profileServers.get(targetKey);
    if (current) {
        current.intentionalStop = true;
    }
    return enqueueProfileOp(targetKey, async () => {
        const entry = _profileServers.get(targetKey);
        if (!entry) {
            return { ok: true, stopped: false };
        }
        entry.intentionalStop = true;
        _profileServers.delete(targetKey);
        await killSingleProcess(entry.process, entry.stdinIsLiveness);
        return { ok: true, stopped: true };
    });
}
function monitorLsCrashInternal(entry, port, csrf, options) {
    const profileKey = entry.profileKey || 'default';
    const myGen = entry.generation ?? getProfileGeneration(profileKey);
    void entry.exitPromise.then(async (exitInfo) => {
        const pooled = _profileServers.get(profileKey);
        if (pooled === entry) {
            _profileServers.delete(profileKey);
        }
        if (entry.intentionalStop || _intentionalTermination || getProfileGeneration(profileKey) !== myGen) {
            return;
        }
        const isStillActive = profileKey === getActiveProfileKey();
        if (isStillActive) {
            clearLsProcess();
            (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: 0 });
            options.onExited?.();
        }
        options.onInstanceExited?.(profileKey, exitInfo);
        const { code, signal, crashStackTrace } = exitInfo;
        const isSelfRestart = code === LS_RESTART_EXIT_CODE && !signal;
        if (isSelfRestart) {
            console.log(`Language server [${profileKey}] exited for restart (code ${LS_RESTART_EXIT_CODE}). Restarting…`);
        }
        else {
            const summary = signal
                ? `killed by signal ${signal}`
                : `exited with code ${code}`;
            console.error(`\nLanguage server [${profileKey}] crashed: ${summary}`);
            if (crashStackTrace) {
                console.error('--- Crash Stack Trace ---');
                console.error(crashStackTrace);
                console.error('--- End Crash Stack trace ---');
            }
            const counter = _restartCounters.get(profileKey) || { count: 0, lastTime: 0 };
            const now = Date.now();
            if (now - counter.lastTime > RESTART_WINDOW_MS) {
                counter.count = 0;
            }
            counter.lastTime = now;
            if (counter.count >= MAX_RESTARTS) {
                const msg = `Language server [${profileKey}] crashed ${MAX_RESTARTS} times in a row. Giving up.`;
                console.error(msg);
                if (isStillActive) {
                    (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: 0, csrfToken: '' });
                }
                return;
            }
            counter.count++;
            _restartCounters.set(profileKey, counter);
            console.log(`Attempting restart [${profileKey}] ${counter.count}/${MAX_RESTARTS} in ${RESTART_COOLDOWN_MS / 1000}s...`);
            const cancelled = await new Promise((resolveSleep) => {
                cancelPendingRestart(profileKey);
                const timer = setTimeout(() => {
                    if (_pendingRestartTimers.get(profileKey)?.timer === timer) {
                        _pendingRestartTimers.delete(profileKey);
                    }
                    resolveSleep(false);
                }, RESTART_COOLDOWN_MS);
                _pendingRestartTimers.set(profileKey, {
                    timer,
                    cancel: () => {
                        clearTimeout(timer);
                        resolveSleep(true);
                    },
                });
            });
            if (cancelled) {
                return;
            }
        }
        if (_intentionalTermination || entry.intentionalStop || getProfileGeneration(profileKey) !== myGen) {
            return;
        }
        await enqueueProfileOp(profileKey, async () => {
            if (_intentionalTermination ||
                entry.intentionalStop ||
                getProfileGeneration(profileKey) !== myGen ||
                _profileServers.has(profileKey)) {
                return;
            }
            try {
                const nextCsrf = crypto.randomUUID();
                const spawnOpts = {
                    ...options,
                    profileId: profileKey,
                    winUser: entry.winUser || options.winUser || '',
                    geminiDir: entry.geminiDir || options.geminiDir || '',
                };
                const newHandle = await startLanguageServer(port, nextCsrf, spawnOpts);
                if (_intentionalTermination || entry.intentionalStop || getProfileGeneration(profileKey) !== myGen) {
                    await killSingleProcess(newHandle.process, newHandle.stdinIsLiveness).catch(() => {});
                    return;
                }
                const newEntry = {
                    profileKey,
                    generation: myGen,
                    process: newHandle.process,
                    port: newHandle.port,
                    csrf: nextCsrf,
                    exitPromise: newHandle.exitPromise,
                    stdinIsLiveness: newHandle.stdinIsLiveness,
                    intentionalStop: false,
                    winUser: spawnOpts.winUser,
                    geminiDir: spawnOpts.geminiDir,
                };
                _profileServers.set(profileKey, newEntry);
                if (profileKey === getActiveProfileKey()) {
                    _lsProcess = newEntry.process;
                    _lsStdinIsLiveness = newEntry.stdinIsLiveness;
                    (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: newEntry.port, csrfToken: nextCsrf });
                    if (spawnOpts.onPortChanged) {
                        spawnOpts.onPortChanged(newEntry.port);
                    }
                }
                spawnOpts.onInstancePortChanged?.(profileKey, newEntry.port, nextCsrf);
                monitorLsCrashInternal(newEntry, port, nextCsrf, spawnOpts);
            }
            catch (err) {
                if (!_intentionalTermination) {
                    console.error(`Failed to restart language server [${profileKey}]: ${err.message}`);
                }
                if (profileKey === getActiveProfileKey()) {
                    (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: 0, csrfToken: '' });
                }
            }
        });
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function killSingleProcess(proc, stdinIsLiveness) {
    if (!proc) return;
    if ((proc.exitCode ?? null) !== null || (proc.signalCode ?? null) !== null) return;
    const pid = proc.pid;
    const exitPromise = new Promise((resolve) => {
        proc.once('exit', () => resolve());
    });
    if (stdinIsLiveness && proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
    }
    else if (process.platform === 'win32' && pid !== undefined) {
        await (0, util_1.promisify)(child_process_1.execFile)('taskkill', ['/pid', String(pid), '/T', '/F'], {
            timeout: 5000,
            windowsHide: true,
        }).catch(() => {
            try { proc.kill('SIGTERM'); } catch {}
        });
    }
    else {
        try { proc.kill('SIGTERM'); } catch {}
    }
    const result = await Promise.race([
        exitPromise.then(() => 'exited'),
        sleep(5000).then(() => 'timeout'),
    ]);
    if (result === 'timeout' && pid !== undefined) {
        console.warn(`Language server (PID ${pid}) did not exit gracefully within 5s. Sending SIGKILL.`);
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch {
            // Process already dead or exited
        }
    }
}
async function killLanguageServer() {
    setIntentionalTermination(true);
    for (const key of [..._pendingRestartTimers.keys()]) {
        bumpProfileGeneration(key);
    }
    for (const key of [..._profileGenerations.keys()]) {
        bumpProfileGeneration(key);
    }
    if (_killLsPromise) {
        return _killLsPromise;
    }
    _killLsPromise = (async () => {
        const targets = new Map();
        for (const entry of _profileServers.values()) {
            entry.intentionalStop = true;
            if (entry.process) {
                targets.set(entry.process, entry.stdinIsLiveness);
            }
        }
        _profileServers.clear();
        const activeProc = getLsProcess();
        if (activeProc && !targets.has(activeProc)) {
            targets.set(activeProc, _lsStdinIsLiveness);
        }
        if (targets.size === 0) {
            return;
        }
        console.log(`Shutting down ${targets.size} language server instance(s)…`);
        await Promise.all(Array.from(targets.entries()).map(([proc, liveness]) => killSingleProcess(proc, liveness)));
        clearLsProcess();
    })().finally(() => {
        clearLsProcess();
        (0, authBootstrap_1.setActiveLanguageServerAuth)({ port: 0, csrfToken: '' });
        _killLsPromise = null;
    });
    return _killLsPromise;
}
/**
 * Sets up certificate verification in Electron to trust local connections
 * (127.0.0.1 or localhost) used by the language server.
 */
const trustedSessions = new WeakSet();
function setupLocalCertTrustForSession(targetSession) {
    if (!targetSession || trustedSessions.has(targetSession)) {
        return;
    }
    trustedSessions.add(targetSession);
    targetSession.setCertificateVerifyProc((request, callback) => {
        if (request.hostname === '127.0.0.1' || request.hostname === 'localhost') {
            callback(0); // Accept
        }
        else {
            callback(-3); // Default validation
        }
    });
}
function setupLocalCertTrust() {
    setupLocalCertTrustForSession(electron_1.session.defaultSession);
}
