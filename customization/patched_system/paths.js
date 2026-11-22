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
exports.IDE_BACKUP_DATA_DIR = exports.IDE_NEW_DATA_DIR = exports.IDE_OLD_DATA_DIR = void 0;
exports.getActiveProfileName = getActiveProfileName;
exports.setActiveProfileName = setActiveProfileName;
exports.getGeminiDirForProfile = getGeminiDirForProfile;
exports.getAppDataDirForProfile = getAppDataDirForProfile;
exports.getSharedConfigDir = getSharedConfigDir;
exports.isGeminiProfileReady = isGeminiProfileReady;
exports.getOverrideIdeName = getOverrideIdeName;
exports.getGeminiDir = getGeminiDir;
exports.getAppDataDirName = getAppDataDirName;
exports.getAppDataDir = getAppDataDir;
exports.getSettingsPbPath = getSettingsPbPath;
exports.getAppStoragePath = getAppStoragePath;
exports.getWindowStatePath = getWindowStatePath;
exports.getActivePortFilePath = getActivePortFilePath;
exports.tightenActivePortPermissions = tightenActivePortPermissions;
exports.removeStaleActivePortFile = removeStaleActivePortFile;
exports.getLsLogPath = getLsLogPath;
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const constants_1 = require("./constants");
let _runtimeProfileOverride = null;
function getFallbackAppDataDir() {
    if (process.platform === 'win32') {
        return process.env.APPDATA || path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming');
    }
    if (process.platform === 'darwin') {
        return path_1.default.join(os_1.default.homedir(), 'Library', 'Application Support');
    }
    return process.env.XDG_CONFIG_HOME || path_1.default.join(os_1.default.homedir(), '.config');
}
function getActiveProfileFilePath() {
    try {
        const appData = electron_1.app?.getPath?.('appData') || getFallbackAppDataDir();
        return path_1.default.join(appData, 'agy_active_profile.json');
    }
    catch {
        return '';
    }
}
function sanitizeProfileId(raw) {
    const clean = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return clean && clean !== 'default' ? clean : '';
}
function setActiveProfileName(profileId, persist = true) {
    const clean = sanitizeProfileId(profileId);
    _runtimeProfileOverride = clean;
    if (persist) {
        try {
            const fp = getActiveProfileFilePath();
            if (fp) {
                fs.writeFileSync(fp, JSON.stringify({ activeProfile: clean || 'default' }, null, 2), 'utf8');
            }
        }
        catch {
            // ignore
        }
    }
    return clean;
}
function getActiveProfileName() {
    if (_runtimeProfileOverride !== null) {
        return _runtimeProfileOverride;
    }
    try {
        const sw = electron_1.app?.commandLine?.getSwitchValue?.('agy-profile');
        if (sw && sw.trim()) {
            const clean = sanitizeProfileId(sw);
            _runtimeProfileOverride = clean;
            return clean;
        }
    }
    catch {
        // ignore
    }
    if (process.env.AGY_PROFILE && process.env.AGY_PROFILE.trim()) {
        const clean = sanitizeProfileId(process.env.AGY_PROFILE);
        _runtimeProfileOverride = clean;
        return clean;
    }
    try {
        const fp = getActiveProfileFilePath();
        if (fp && fs.existsSync(fp)) {
            const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const clean = sanitizeProfileId(parsed?.activeProfile);
            _runtimeProfileOverride = clean;
            return clean;
        }
    }
    catch {
        // ignore
    }
    _runtimeProfileOverride = '';
    return '';
}
function getOverrideIdeName() {
    // Must always remain 'antigravity' so language_server runs in antigravity-hub mode
    // and supports interactive Google OAuth login across all profiles.
    return 'antigravity';
}
function normalizeProfilePathId(raw) {
    const requested = String(raw ?? '').trim().toLowerCase();
    if (!requested || requested === 'default') {
        return '';
    }
    return /^[a-z0-9_-]+$/.test(requested) ? requested : null;
}
function getSharedConfigDir() {
    try {
        const appData = electron_1.app?.getPath?.('appData') || getFallbackAppDataDir();
        return path_1.default.join(appData, 'Antigravity');
    }
    catch {
        return electron_1.app?.getPath?.('userData') || path_1.default.join(getFallbackAppDataDir(), 'Antigravity');
    }
}
function getGeminiDirForProfile(profileId, explicitDir) {
    if (typeof explicitDir === 'string' && explicitDir.trim()) {
        return explicitDir.trim();
    }
    const profile = normalizeProfilePathId(profileId);
    if (profile === null) {
        return '';
    }
    if (!profile) {
        return path_1.default.join(os_1.default.homedir(), '.gemini');
    }
    if (process.platform === 'win32') {
        const isolated = path_1.default.join('C:\\ProgramData\\AntigravityAccounts', profile, '.gemini');
        if (fs.existsSync(isolated)) {
            return isolated;
        }
    }
    return path_1.default.join(os_1.default.homedir(), '.gemini-profiles', profile);
}
function getAppDataDirForProfile(profileId, explicitGeminiDir) {
    const gDir = getGeminiDirForProfile(profileId, explicitGeminiDir) || path_1.default.join(os_1.default.homedir(), '.gemini');
    return path_1.default.join(gDir, getAppDataDirName());
}
function isGeminiProfileReady(profileId) {
    const profile = normalizeProfilePathId(profileId);
    if (profile === null) {
        return false;
    }
    if (!profile) {
        return true;
    }
    const profileDir = getGeminiDirForProfile(profile);
    try {
        return fs.statSync(profileDir).isDirectory() && fs.readdirSync(profileDir).length > 0;
    }
    catch {
        return false;
    }
}
function getGeminiDir() {
    const profile = getActiveProfileName();
    return getGeminiDirForProfile(profile) || path_1.default.join(os_1.default.homedir(), '.gemini');
}
function getAppDataDirName() {
    if (!electron_1.app.isPackaged) {
        return 'antigravity-dev';
    }
    return electron_1.app.getName().toLowerCase().replace(/\s+/g, '');
}
function getAppDataDir() {
    return path_1.default.join(getGeminiDir(), getAppDataDirName());
}
function getSettingsPbPath() {
    return path_1.default.join(getGeminiDir(), 'config', 'config.json');
}
/**
 * Returns the path to the persistent app storage file.
 * This is used to back a lightweight key-value store for UI state,
 * and is not used for e.g. settings or other "core" app state.
 */
function getAppStoragePath() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'app_storage.json');
}
/**
 * Returns the path to the persistent window geometry and state file.
 */
function getWindowStatePath() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'window_state.json');
}
/**
 * Returns the path to the file used to communicate AGY Hub's remote debugging port.
 * Used by recording encoder.
 */
function getActivePortFilePath() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'DevToolsActivePort');
}
/**
 * Best-effort POSIX hardening of `DevToolsActivePort`, which holds the CDP
 * WebSocket secret: restricts `userDataDir` to `0o700` and `activePortFile` to
 * `0o600`, each only if it exists, is owned by the current user, and is looser.
 * Never throws.
 */
function tightenActivePortPermissions(userDataDir, activePortFile) {
    if (process.platform === 'win32') {
        return;
    }
    for (const [target, mode] of [
        [userDataDir, 0o700],
        [activePortFile, 0o600],
    ]) {
        try {
            const st = fs.statSync(target);
            if (st.uid === process.getuid?.() && st.mode & 0o777 & ~mode) {
                fs.chmodSync(target, st.mode & mode);
            }
        }
        catch {
            // Missing path or foreign filesystem: leave as is.
        }
    }
}
/**
 * Best-effort removal of a leftover `DevToolsActivePort` file when remote
 * debugging is disabled. On POSIX, skips files not owned by the current user.
 * Never throws.
 */
function removeStaleActivePortFile(activePortFile) {
    try {
        if (process.platform !== 'win32' && typeof process.getuid === 'function') {
            const st = fs.lstatSync(activePortFile);
            if (st.uid !== process.getuid()) {
                return;
            }
        }
        fs.rmSync(activePortFile, { force: true });
    }
    catch {
        // Missing file, foreign filesystem, or partial fs mock: leave as is.
    }
}
function getLsLogPath(profileId) {
    const prof = profileId !== undefined ? sanitizeProfileId(profileId) : getActiveProfileName();
    const fileName = prof
        ? constants_1.LS_LOG_FILE_NAME.replace(/(\.[^.]+)?$/, `_${prof}$1`)
        : constants_1.LS_LOG_FILE_NAME;
    return path_1.default.join(electron_1.app.getPath('logs'), fileName);
}
/** User data dir for the old IDE (source for copy). */
exports.IDE_OLD_DATA_DIR = path_1.default.join(os_1.default.homedir(), '.gemini', 'antigravity');
/** User data dir for the separately installed IDE (destination for copy). */
exports.IDE_NEW_DATA_DIR = path_1.default.join(os_1.default.homedir(), '.gemini', 'antigravity-ide');
/** User data dir for backup (destination for backup copy). */
exports.IDE_BACKUP_DATA_DIR = path_1.default.join(os_1.default.homedir(), '.gemini', 'antigravity-backup');
