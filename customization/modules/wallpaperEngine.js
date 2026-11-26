"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { handleExtrasRequest, buildExtrasClientJs } = require("./agyExtras");
const pathsMod = require("./paths");
const agyAccounts = require("./agyAccounts");
const agyShellViews = require("./agyShellViews");
const { app, session } = require("electron");
const {
    parseRgb,
    relativeLuminance,
    contrastRatio,
    blendRgbOver,
    rgbToHex,
    getAccessibleTextPalette,
    ensureReadableAccentOnSurface,
    normalizeAdaptiveAccent,
    getAdaptiveThemeTokens,
    getContrastBoost,
    computeSurfaceLayers,
    computeEffectiveScrimOpacity,
    ensureReadableSyntaxColor,
    buildUiDesignTokens,
    serializeContrastHelpers,
} = require("./agyUiContrast");

const DEFAULT_WALLPAPER_DIR = "C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960";
const VIDEO_EXTS = new Set([".mp4", ".webm", ".m4v", ".mov"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const FONT_EXTS = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const MAX_VIDEO_DURATION_SEC = 240;
const MAX_VIDEO_SIZE_BYTES = 1200 * 1024 * 1024;
const MAX_FONT_SIZE_BYTES = 25 * 1024 * 1024;
const NSFW_REGEX = /\b(18\+|nsfw|hentai|r-?18|ecchi|lewd|nude|naked|x-?ray|uncensored|erotic|porn|sex|boobs|ahegao|oppai|milf)\b/i;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FTYP_MAGIC = Buffer.from("ftyp");

const MIME_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".gif": "image/gif",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
};

const FONT_MIME_TYPES = {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

const FONT_FORMAT_HINTS = {
    ".ttf": "truetype",
    ".otf": "opentype",
    ".woff": "woff",
    ".woff2": "woff2",
};

const LIGHT_DEFAULT_TINT_RGB = "250, 251, 254";
const LIGHT_DEFAULT_BG_HEX = "#fafbfe";
const DARK_DEFAULT_BG_HEX = "#0c0e14";
const LIGHT_DEFAULT_TEXT_HEX = "#111827";
const DARK_DEFAULT_TEXT_HEX = "#f8fafc";
const LIGHT_DEFAULT_ACCENT_HEX = "#2563eb";
const DARK_DEFAULT_ACCENT_HEX = "#60a5fa";

const BASE_THEME = {
    label: "Antigravity",
    accentRgb: "96, 165, 250",
    tintRgb: "12, 14, 20",
    uiFont: "'Segoe UI Variable', 'Segoe UI', 'Ubuntu', 'Cantarell', 'Noto Sans', system-ui, sans-serif",
    monoFont: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'DejaVu Sans Mono', monospace",
    fontSize: "14px",
};

let cachedWallpapers = null;
let serverPort = 0;
let serverStarted = false;
const SERVER_TOKEN = crypto.randomBytes(32).toString("hex");
const SHELL_TOKEN = crypto.randomBytes(32).toString("hex");
const PROFILE_TOKEN_MAP = new Map();
const TOKEN_TO_PROFILE = new Map();
PROFILE_TOKEN_MAP.set("default", SERVER_TOKEN);
TOKEN_TO_PROFILE.set(SERVER_TOKEN, "default");

const sseClients = new Set();
let accountsSseWired = false;

function getProfileServerToken(profileId = "default") {
    const pid = String(profileId || "default").trim() || "default";
    if (PROFILE_TOKEN_MAP.has(pid)) return PROFILE_TOKEN_MAP.get(pid);
    const tok = crypto.randomBytes(32).toString("hex");
    PROFILE_TOKEN_MAP.set(pid, tok);
    TOKEN_TO_PROFILE.set(tok, pid);
    return tok;
}

function getProfileIdForToken(tok) {
    return TOKEN_TO_PROFILE.get(String(tok || "")) || null;
}

function getShellServerToken() {
    return SHELL_TOKEN;
}

function broadcastSseEvent(eventName, payload) {
    if (sseClients.size === 0) return;
    let msg = "";
    try {
        msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    } catch {
        return;
    }
    for (const res of [...sseClients]) {
        try {
            if (res.writableEnded || res.destroyed) {
                sseClients.delete(res);
                continue;
            }
            res.write(msg);
        } catch {
            sseClients.delete(res);
        }
    }
}

function getLocalServerPort() {
    return serverPort;
}

function getLocalServerToken() {
    return SERVER_TOKEN;
}

function safeEqualTokens(a, b) {
    const ba = Buffer.from(String(a || ""), "utf8");
    const bb = Buffer.from(String(b || ""), "utf8");
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isQueryTokenAllowedPath(pathname) {
    const p = String(pathname || "");
    if (p.startsWith("/fonts/")) {
        const sub = p.slice("/fonts/".length);
        return Boolean(
            sub &&
            !sub.includes("/") &&
            sub !== "list" &&
            sub !== "add" &&
            sub !== "upload" &&
            sub !== "open" &&
            sub !== "delete"
        );
    }
    return p === "/events" || p.startsWith("/stream/") || p === "/media/cover" || p.startsWith("/shell/");
}

function defaultIsAllowedOrigin(origin, port) {
    if (!origin) return true;
    if (port > 0 && origin === `http://127.0.0.1:${port}`) return true;
    try {
        const u = new URL(origin);
        if (u.protocol !== "https:" || u.hostname !== "127.0.0.1" || !u.port) return false;
        const lsMod = require("./languageServer");
        const running = typeof lsMod.getRunningProfiles === "function" ? lsMod.getRunningProfiles() : [];
        if (running.some((id) => String(lsMod.getProfileServerInfo?.(id)?.port || "") === u.port)) return true;
        if (typeof lsMod.getLsPort === "function" && String(lsMod.getLsPort() || "") === u.port) return true;
        return false;
    } catch {
        return false;
    }
}

function isShellOnlyPath(pathname) {
    const p = String(pathname || "");
    return (
        p.startsWith("/shell/") ||
        p === "/accounts/add" ||
        p === "/accounts/delete" ||
        p === "/accounts/grant-folder" ||
        p === "/accounts/repair-isolation" ||
        p === "/accounts/rename" ||
        p === "/accounts/stop-server" ||
        p === "/accounts/switch" ||
        p === "/tabs/close" ||
        p === "/tabs/bar-height"
    );
}

function validateLocalServerRequest(req, reqUrl, opts = {}) {
    const port = Number(opts.serverPort ?? serverPort);
    const token = String(opts.token ?? SERVER_TOKEN);
    const hasExplicitShellToken = typeof opts.shellToken === "string" && opts.shellToken.length > 0;
    const shellToken = hasExplicitShellToken ? opts.shellToken : "";
    const resolveProfileToken = typeof opts.resolveProfileToken === "function" ? opts.resolveProfileToken : null;
    const checkOrigin = typeof opts.isAllowedOrigin === "function"
        ? opts.isAllowedOrigin
        : (orig) => defaultIsAllowedOrigin(orig, port);

    const host = String(req?.headers?.host || "").toLowerCase();
    if (port > 0 && host !== `127.0.0.1:${port}`) {
        return { ok: false, status: 403, body: "Forbidden host", contentType: "text/plain; charset=utf-8" };
    }

    const origin = req?.headers?.origin ? String(req.headers.origin) : "";
    if (origin && !checkOrigin(origin)) {
        return { ok: false, status: 403, body: "Forbidden origin", contentType: "text/plain; charset=utf-8" };
    }

    if (req?.method === "OPTIONS") {
        return { ok: true, preflight: true, origin };
    }

    const pathname = String(reqUrl?.pathname || "");
    const headerTok = String(req?.headers?.["x-agy-token"] || "");
    const queryTok = reqUrl?.searchParams?.get("t") || "";
    const qAllowed = isQueryTokenAllowedPath(pathname);

    if (hasExplicitShellToken) {
        const isShellAuthed = safeEqualTokens(headerTok, shellToken) || (qAllowed && safeEqualTokens(queryTok, shellToken));
        if (isShellAuthed) {
            return { ok: true, preflight: false, origin, authRole: "shell", authProfile: null };
        }
    }

    const matchTabToken = (cand) => {
        if (!cand) return null;
        if (resolveProfileToken) {
            const p = resolveProfileToken(cand);
            if (p) return p;
        }
        if (safeEqualTokens(cand, token)) return "default";
        return null;
    };

    const matchedProfile = matchTabToken(headerTok) || (qAllowed ? matchTabToken(queryTok) : null);
    if (!matchedProfile) {
        return { ok: false, status: 401, body: '{"ok":false,"error":"unauthorized"}', contentType: "application/json; charset=utf-8" };
    }

    if (hasExplicitShellToken && isShellOnlyPath(pathname)) {
        return { ok: false, status: 403, body: '{"ok":false,"error":"shell_token_required"}', contentType: "application/json; charset=utf-8" };
    }

    return { ok: true, preflight: false, origin, authRole: "tab", authProfile: matchedProfile };
}

function getActiveProfile() {
    if (pathsMod && typeof pathsMod.getActiveProfileName === "function") {
        return pathsMod.getActiveProfileName() || "default";
    }
    return "default";
}

function getAppearanceConfigPath() {
    const dir = pathsMod && typeof pathsMod.getSharedConfigDir === "function"
        ? pathsMod.getSharedConfigDir()
        : app.getPath("userData");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return path.join(dir, "agy_appearance.json");
}

function findLinuxSteamWorkshopDir() {
    const home = os.homedir();
    const steamRoots = [
        path.join(home, ".local", "share", "Steam"),
        path.join(home, ".steam", "steam"),
        path.join(home, ".steam", "root"),
        path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
        path.join(home, ".var", "app", "com.valvesoftware.Steam", ".steam", "steam"),
        path.join(home, "snap", "steam", "common", ".local", "share", "Steam"),
    ];
    const libraries = [];
    for (const root of steamRoots) {
        if (!fs.existsSync(root)) continue;
        if (!libraries.includes(root)) libraries.push(root);
        try {
            const vdfPath = path.join(root, "steamapps", "libraryfolders.vdf");
            if (fs.existsSync(vdfPath)) {
                const content = fs.readFileSync(vdfPath, "utf8");
                const re = /"path"\s+"([^"]+)"/gi;
                let m;
                while ((m = re.exec(content)) !== null) {
                    const lib = m[1].replace(/\\\\/g, "/");
                    if (lib && fs.existsSync(lib) && !libraries.includes(lib)) {
                        libraries.push(lib);
                    }
                }
            }
        } catch {}
    }
    for (const lib of libraries) {
        const ws = path.join(lib, "steamapps", "workshop", "content", "431960");
        if (fs.existsSync(ws)) return ws;
    }
    return "";
}

function getWallpaperDir() {
    try {
        const sharedDir = pathsMod && typeof pathsMod.getSharedConfigDir === "function"
            ? pathsMod.getSharedConfigDir()
            : app.getPath("userData");
        const cfgPath = path.join(sharedDir, "wallpaper_config.json");
        if (fs.existsSync(cfgPath)) {
            const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            if (parsed.wallpaperDir && fs.existsSync(parsed.wallpaperDir)) {
                return parsed.wallpaperDir;
            }
        }
    } catch {}
    if (DEFAULT_WALLPAPER_DIR && fs.existsSync(DEFAULT_WALLPAPER_DIR)) {
        return DEFAULT_WALLPAPER_DIR;
    }
    if (process.platform === "linux") {
        const linuxWs = findLinuxSteamWorkshopDir();
        if (linuxWs) return linuxWs;
    }
    return DEFAULT_WALLPAPER_DIR;
}

function parseMp4Metadata(filePath, baseOffset = 0, byteLen = 0) {
    let fd;
    let duration = -1;
    let width = 0;
    let height = 0;
    try {
        fd = fs.openSync(filePath, "r");
        const statSize = byteLen || fs.fstatSync(fd).size;
        for (const chunkStart of [0, Math.max(0, statSize - 524288)]) {
            const readLen = Math.min(524288, statSize - chunkStart);
            if (readLen <= 32) continue;
            const buf = Buffer.alloc(readLen);
            fs.readSync(fd, buf, 0, readLen, baseOffset + chunkStart);

            if (duration < 0) {
                let idx = 0;
                while ((idx = buf.indexOf("mvhd", idx)) !== -1) {
                    if (idx >= 4 && idx + 28 <= buf.length) {
                        const version = buf[idx + 4];
                        if (version === 0) {
                            const ts = buf.readUInt32BE(idx + 16);
                            const dur = buf.readUInt32BE(idx + 20);
                            if (ts > 0 && dur > 0 && dur / ts < 86400) { duration = Math.round(dur / ts); break; }
                        } else if (version === 1 && idx + 36 <= buf.length) {
                            const ts = buf.readUInt32BE(idx + 24);
                            const dur = Number(buf.readBigUInt64BE(idx + 28));
                            if (ts > 0 && dur > 0 && dur / ts < 86400) { duration = Math.round(dur / ts); break; }
                        }
                    }
                    idx += 4;
                }
            }

            if (width === 0 || height === 0) {
                let idx = 0;
                while ((idx = buf.indexOf("tkhd", idx)) !== -1) {
                    if (idx >= 4 && idx + 88 <= buf.length) {
                        const version = buf[idx + 4];
                        const wOff = version === 1 ? idx + 92 : idx + 80;
                        const hOff = version === 1 ? idx + 96 : idx + 84;
                        if (hOff + 4 <= buf.length) {
                            const w = Math.round(buf.readUInt32BE(wOff) / 65536);
                            const h = Math.round(buf.readUInt32BE(hOff) / 65536);
                            if (w >= 160 && w <= 16384 && h >= 120 && h <= 16384) { width = w; height = h; break; }
                        }
                    }
                    idx += 4;
                }
            }
            if (duration >= 0 && width > 0 && height > 0) break;
        }
    } catch {} finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
    return { duration, width, height };
}

function parseImageDimensions(filePath, baseOffset = 0, byteLen = 0) {
    let fd;
    try {
        fd = fs.openSync(filePath, "r");
        const readLen = Math.min(65536, byteLen || fs.fstatSync(fd).size);
        if (readLen < 24) return { width: 0, height: 0 };
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, baseOffset);
        if (buf.subarray(0, 8).equals(PNG_MAGIC)) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let pos = 2;
            while (pos + 9 < buf.length) {
                if (buf[pos] !== 0xff) { pos++; continue; }
                const marker = buf[pos + 1];
                if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
                    return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
                }
                if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) pos += 2;
                else {
                    const segLen = buf.readUInt16BE(pos + 2);
                    if (segLen < 2) break;
                    pos += 2 + segLen;
                }
            }
        }
    } catch {} finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
    return { width: 0, height: 0 };
}

function classifyResolution(width, height) {
    if (!width || !height) return { resLabel: "", isLowRes: false };
    const isPortrait = height > width * 1.15;
    const isLowRes = width < 1280 || height < 720 || isPortrait;
    let resLabel = "";
    if (width >= 3800 || height >= 2100) resLabel = "4K";
    else if (width >= 2500 || height >= 1400) resLabel = "2K";
    else if (width >= 1900 || height >= 1050) resLabel = "1080p";
    else if (width >= 1260 || height >= 700) resLabel = "720p";
    else resLabel = Math.min(width, height) + "p";
    return { resLabel, isLowRes };
}

function getCustomWallpaperDir() {
    try {
        const sharedDir = pathsMod && typeof pathsMod.getSharedConfigDir === "function"
            ? pathsMod.getSharedConfigDir()
            : app.getPath("userData");
        const cfgPath = path.join(sharedDir, "wallpaper_config.json");
        if (fs.existsSync(cfgPath)) {
            const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            if (parsed && typeof parsed.customWallpaperDir === "string" && parsed.customWallpaperDir.trim()) {
                const customDir = parsed.customWallpaperDir.trim();
                try { fs.mkdirSync(customDir, { recursive: true }); } catch {}
                return customDir;
            }
        }
        const fallback = path.join(sharedDir, "custom_wallpapers");
        try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
        return fallback;
    } catch {}
    return "";
}

function getCustomFontsDir() {
    try {
        const customWpDir = getCustomWallpaperDir();
        if (customWpDir && path.basename(customWpDir).toLowerCase() === "custom_wallpapers") {
            const sibling = path.join(path.dirname(customWpDir), "custom_fonts");
            try { fs.mkdirSync(sibling, { recursive: true }); } catch {}
            return sibling;
        }
        const sharedDir = pathsMod && typeof pathsMod.getSharedConfigDir === "function"
            ? pathsMod.getSharedConfigDir()
            : app.getPath("userData");
        const fallback = path.join(sharedDir, "custom_fonts");
        try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
        return fallback;
    } catch {}
    return "";
}

function sanitizeFontFileName(rawName) {
    if (typeof rawName !== "string") return "";
    const trimmed = rawName.trim();
    if (!trimmed || trimmed.includes("\0")) return "";
    const base = path.basename(trimmed);
    if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) return "";
    const ext = path.extname(base).toLowerCase();
    if (!FONT_EXTS.has(ext)) return "";
    const rawStem = base.slice(0, base.length - ext.length);
    let stem = rawStem
        .replace(/[^\p{L}\p{N} _.-]/gu, "_")
        .replace(/^\.+/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    if (!stem) {
        stem = "font_" + crypto.createHash("sha256").update(base).digest("hex").slice(0, 8);
    }
    return stem + ext;
}

function deriveFontFamilyName(fileName) {
    const ext = path.extname(String(fileName || "")).toLowerCase();
    const stem = path.basename(String(fileName || ""), ext);
    let clean = stem
        .replace(/_/g, " ")
        .replace(/[^\p{L}\p{N} .-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
    if (!clean) {
        clean = "CustomFont " + crypto.createHash("sha256").update(String(fileName || "")).digest("hex").slice(0, 6);
    }
    return clean;
}

function scanCustomFonts(fontsDir = getCustomFontsDir()) {
    if (!fontsDir || !fs.existsSync(fontsDir)) return [];
    let entries = [];
    try { entries = fs.readdirSync(fontsDir, { withFileTypes: true }); } catch { return []; }
    const results = [];
    const usedFamilies = new Set();
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        if (e.isSymbolicLink && e.isSymbolicLink()) continue;
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!FONT_EXTS.has(ext)) continue;
        const fullPath = path.join(fontsDir, e.name);
        let size = 0;
        try {
            const st = fs.lstatSync(fullPath);
            if (!st.isFile() || st.isSymbolicLink()) continue;
            size = st.size;
        } catch { continue; }
        if (size <= 0 || size > MAX_FONT_SIZE_BYTES) continue;

        const baseFamily = deriveFontFamilyName(e.name);
        let family = baseFamily;
        let suffix = 2;
        while (usedFamilies.has(family.toLowerCase())) {
            family = `${baseFamily} ${suffix++}`;
        }
        usedFamilies.add(family.toLowerCase());

        results.push({
            id: "font_" + e.name,
            fileName: e.name,
            name: path.basename(e.name, ext),
            family,
            cssValue: `'${family}', 'Segoe UI', system-ui, sans-serif`,
            ext,
            format: FONT_FORMAT_HINTS[ext] || "truetype",
            mime: FONT_MIME_TYPES[ext] || "application/octet-stream",
            urlPath: "/fonts/" + encodeURIComponent(e.name),
            size,
        });
    }
    return results;
}

function resolveCustomFontFile(rawFileName, fontsDir = getCustomFontsDir()) {
    if (!fontsDir || typeof rawFileName !== "string") return null;
    let decoded = "";
    try { decoded = decodeURIComponent(rawFileName); } catch { return null; }
    if (!decoded || decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") {
        return null;
    }
    const ext = path.extname(decoded).toLowerCase();
    if (!FONT_EXTS.has(ext)) return null;
    const rootResolved = path.resolve(fontsDir);
    const fullPath = path.resolve(rootResolved, decoded);
    const rel = path.relative(rootResolved, fullPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
    try {
        const st = fs.lstatSync(fullPath);
        if (!st.isFile() || st.isSymbolicLink()) return null;
        if (st.size <= 0 || st.size > MAX_FONT_SIZE_BYTES) return null;
        return {
            filePath: fullPath,
            fileName: decoded,
            ext,
            mime: FONT_MIME_TYPES[ext] || "application/octet-stream",
            size: st.size,
        };
    } catch {
        return null;
    }
}

const RETRYABLE_FS_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

function atomicWriteFileRetrySync(dstPath, content, writeOpts = undefined) {
    const tmpPath = `${dstPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmpPath, content, writeOpts);
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(tmpPath, dstPath);
                return;
            } catch (err) {
                if (!RETRYABLE_FS_ERRORS.has(err?.code) || attempt >= 5) throw err;
                try {
                    const sab = new SharedArrayBuffer(4);
                    Atomics.wait(new Int32Array(sab), 0, 0, Math.min(80, 15 * (attempt + 1)));
                } catch {}
            }
        }
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    }
}

function isValidFontMagicBytes(buf, ext) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
    const e = String(ext || "").toLowerCase();
    const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
    if (e === ".ttf") {
        return (
            (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) ||
            (b0 === 0x74 && b1 === 0x72 && b2 === 0x75 && b3 === 0x65) || // "true"
            (b0 === 0x74 && b1 === 0x79 && b2 === 0x70 && b3 === 0x31) || // "typ1"
            (b0 === 0x74 && b1 === 0x74 && b2 === 0x63 && b3 === 0x66)    // "ttcf"
        );
    }
    if (e === ".otf") {
        return (
            (b0 === 0x4f && b1 === 0x54 && b2 === 0x54 && b3 === 0x4f) || // "OTTO"
            (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00)
        );
    }
    if (e === ".woff") {
        return b0 === 0x77 && b1 === 0x4f && b2 === 0x46 && b3 === 0x46; // "wOFF"
    }
    if (e === ".woff2") {
        return b0 === 0x77 && b1 === 0x4f && b2 === 0x46 && b3 === 0x32; // "wOF2"
    }
    return false;
}

function saveCustomFontBuffer(rawFileName, buf, fontsDir = getCustomFontsDir()) {
    if (!fontsDir || !Buffer.isBuffer(buf) || buf.length <= 0 || buf.length > MAX_FONT_SIZE_BYTES) {
        return null;
    }
    const cleanName = sanitizeFontFileName(rawFileName);
    if (!cleanName) return null;
    const ext = path.extname(cleanName).toLowerCase();
    if (!isValidFontMagicBytes(buf, ext)) return null;
    try { fs.mkdirSync(fontsDir, { recursive: true }); } catch {}
    const rootResolved = path.resolve(fontsDir);
    const dstPath = path.resolve(rootResolved, cleanName);
    const rel = path.relative(rootResolved, dstPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
    atomicWriteFileRetrySync(dstPath, buf);
    const fonts = scanCustomFonts(fontsDir);
    return fonts.find((f) => f.fileName === cleanName) || null;
}

function scanCustomWallpapers(customDir, results) {
    if (!customDir || !fs.existsSync(customDir)) return;
    const collect = (dir, depth) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink && e.isSymbolicLink()) continue;
            const fullPath = path.join(dir, e.name);
            if (e.isDirectory() && depth < 1) {
                collect(fullPath, depth + 1);
                continue;
            }
            if (!e.isFile()) continue;
            const ext = path.extname(e.name).toLowerCase();
            let size = 0;
            try { size = fs.statSync(fullPath).size; } catch { continue; }
            if (size <= 0) continue;

            if (IMAGE_EXTS.has(ext)) {
                results.push({
                    index: results.length,
                    id: "custom_" + e.name,
                    name: path.basename(e.name, ext),
                    folder: "custom",
                    source: "custom",
                    kind: "image",
                    duration: null,
                    width: 0,
                    height: 0,
                    resLabel: ext === ".gif" ? "GIF" : "IMG",
                    isLowRes: false,
                    isMature: NSFW_REGEX.test(e.name),
                    mime: MIME_TYPES[ext] || "image/jpeg",
                    filePath: fullPath,
                    offset: 0,
                    size,
                });
            } else if (VIDEO_EXTS.has(ext) && size <= MAX_VIDEO_SIZE_BYTES) {
                const meta = parseMp4Metadata(fullPath, 0, size);
                if (meta.duration > MAX_VIDEO_DURATION_SEC) continue;
                const { resLabel, isLowRes } = classifyResolution(meta.width, meta.height);
                results.push({
                    index: results.length,
                    id: "custom_" + e.name,
                    name: path.basename(e.name, ext),
                    folder: "custom",
                    source: "custom",
                    kind: "video",
                    duration: meta.duration > 0 ? meta.duration : null,
                    width: meta.width,
                    height: meta.height,
                    resLabel: resLabel || "VIDEO",
                    isLowRes,
                    isMature: NSFW_REGEX.test(e.name),
                    mime: MIME_TYPES[ext] || "video/mp4",
                    filePath: fullPath,
                    offset: 0,
                    size,
                });
            }
        }
    };
    collect(customDir, 0);
}

function scanWallpapers(force = false) {
    if (cachedWallpapers && !force) return cachedWallpapers;
    const results = [];
    // 1. Scan custom user wallpapers (photos & videos)
    scanCustomWallpapers(getCustomWallpaperDir(), results);

    // 2. Scan Steam Wallpaper Engine Workshop folder
    const rootDir = getWallpaperDir();
    if (!fs.existsSync(rootDir)) { cachedWallpapers = results; return results; }

    let workshopDirs = [];
    try { workshopDirs = fs.readdirSync(rootDir); } catch { cachedWallpapers = results; return results; }

    for (const d of workshopDirs) {
        const fullDir = path.join(rootDir, d);
        let st;
        try { st = fs.statSync(fullDir); } catch { continue; }
        if (!st.isDirectory()) continue;

        let title = "";
        let contentRating = "Everyone";
        let tags = [];
        const pjPath = path.join(fullDir, "project.json");
        if (fs.existsSync(pjPath)) {
            try {
                const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
                if (pj.title && typeof pj.title === "string") title = pj.title.trim();
                if (pj.contentrating && typeof pj.contentrating === "string") contentRating = pj.contentrating.trim();
                if (Array.isArray(pj.tags)) tags = pj.tags.map((t) => String(t));
            } catch {}
        }

        const ratingLower = contentRating.toLowerCase();
        const isMature = ratingLower === "mature" || NSFW_REGEX.test(title) || tags.some((t) => NSFW_REGEX.test(t));

        const findDirectVideos = (dir, depth = 0) => {
            const out = [];
            if (depth > 4) return out;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
            for (const e of entries) {
                if (e.isSymbolicLink && e.isSymbolicLink()) continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory() && depth < 4) out.push(...findDirectVideos(p, depth + 1));
                else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
            }
            return out;
        };

        const directVids = findDirectVideos(fullDir);
        if (directVids.length > 0) {
            for (const vPath of directVids) {
                let vSize = 0;
                try { vSize = fs.statSync(vPath).size; } catch { continue; }
                const ext = path.extname(vPath).toLowerCase();
                const meta = parseMp4Metadata(vPath, 0, vSize);
                if (meta.duration > MAX_VIDEO_DURATION_SEC || vSize > MAX_VIDEO_SIZE_BYTES) continue;
                const displayName = title || path.basename(vPath, ext);
                const { resLabel, isLowRes } = classifyResolution(meta.width, meta.height);
                results.push({
                    index: results.length,
                    id: d + "_" + path.basename(vPath),
                    name: displayName,
                    folder: d,
                    kind: "video",
                    duration: meta.duration > 0 ? meta.duration : null,
                    width: meta.width,
                    height: meta.height,
                    resLabel,
                    isLowRes,
                    isMature: isMature || NSFW_REGEX.test(displayName),
                    mime: MIME_TYPES[ext] || "video/mp4",
                    filePath: vPath,
                    offset: 0,
                    size: vSize,
                });
            }
            continue;
        }

        let addedFromPkg = false;
        for (const pkgName of ["scene.pkg", "gifscene.pkg"]) {
            const pkgPath = path.join(fullDir, pkgName);
            if (!fs.existsSync(pkgPath)) continue;
            let fd;
            try {
                fd = fs.openSync(pkgPath, "r");
                const hdr = Buffer.alloc(65536);
                const bytesRead = fs.readSync(fd, hdr, 0, 65536, 0);
                let pos = 0;
                const verLen = hdr.readUInt32LE(pos);
                pos += 4 + verLen;
                const count = hdr.readUInt32LE(pos);
                pos += 4;
                const items = [];
                for (let i = 0; i < count; i++) {
                    if (pos + 4 > bytesRead) break;
                    const nLen = hdr.readUInt32LE(pos);
                    pos += 4;
                    if (pos + nLen + 8 > bytesRead) break;
                    const name = hdr.toString("utf8", pos, pos + nLen);
                    pos += nLen;
                    const off = hdr.readUInt32LE(pos);
                    pos += 4;
                    const len = hdr.readUInt32LE(pos);
                    pos += 4;
                    items.push({ name, off, len });
                }
                const dataStart = pos;
                const mp4Texs = [];
                items.sort((a, b) => b.len - a.len);
                for (const it of items) {
                    if (!it.name.endsWith(".tex") || it.len < 800000) continue;
                    const absOff = dataStart + it.off;
                    const sample = Buffer.alloc(256);
                    fs.readSync(fd, sample, 0, 256, absOff);
                    const ftypIdx = sample.indexOf(FTYP_MAGIC);
                    if (ftypIdx >= 4) {
                        mp4Texs.push({ it, offset: absOff + ftypIdx - 4, size: it.len - (ftypIdx - 4) });
                    }
                }
                for (const m of mp4Texs) {
                    const meta = parseMp4Metadata(pkgPath, m.offset, m.size);
                    if (meta.duration > MAX_VIDEO_DURATION_SEC) continue;
                    const tag = mp4Texs.length > 1 ? " - " + path.basename(m.it.name, ".tex") : "";
                    const { resLabel, isLowRes } = classifyResolution(meta.width, meta.height);
                    results.push({
                        index: results.length,
                        id: d + "_" + path.basename(m.it.name),
                        name: (title || d) + tag,
                        folder: d,
                        kind: "video",
                        duration: meta.duration > 0 ? meta.duration : null,
                        width: meta.width,
                        height: meta.height,
                        resLabel,
                        isLowRes,
                        isMature,
                        mime: "video/mp4",
                        filePath: pkgPath,
                        offset: m.offset,
                        size: m.size,
                    });
                    addedFromPkg = true;
                }
            } catch {} finally {
                if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
            }
        }

        if (!addedFromPkg) {
            for (const fb of ["wallpaper.png", "wallpaper.jpg"]) {
                const fbPath = path.join(fullDir, fb);
                if (fs.existsSync(fbPath)) {
                    let fbSize = 0;
                    try { fbSize = fs.statSync(fbPath).size; } catch { continue; }
                    const dims = parseImageDimensions(fbPath, 0, fbSize);
                    const { resLabel, isLowRes } = classifyResolution(dims.width, dims.height);
                    const ext = path.extname(fb).toLowerCase();
                    results.push({
                        index: results.length,
                        id: d + "_" + fb,
                        name: title || d,
                        folder: d,
                        kind: "scene",
                        duration: null,
                        width: dims.width,
                        height: dims.height,
                        resLabel,
                        isLowRes,
                        isMature,
                        mime: MIME_TYPES[ext] || "image/png",
                        filePath: fbPath,
                        offset: 0,
                        size: fbSize,
                    });
                    break;
                }
            }
        }
    }

    cachedWallpapers = results;
    return results;
}

function sanitizeCssRgbTriplet(val) {
    if (typeof val !== "string") return undefined;
    const m = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/.exec(val);
    if (!m) return undefined;
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    if (r > 255 || g > 255 || b > 255) return undefined;
    return `${r}, ${g}, ${b}`;
}

function sanitizeUiFontChoice(val) {
    if (typeof val !== "string") return undefined;
    const s = val.trim();
    if (!s || s.length > 140) return undefined;
    // Block CSS injection tokens (semicolons, braces, parens, url(), expression(), colons, backslashes)
    if (/[;{}():\\<>@!]|url\s*\(|expression\s*\(/i.test(s)) return undefined;
    if (!/^[\p{L}\p{N} _.,'"-]+$/u.test(s)) return undefined;
    return s;
}

function sanitizeAppearanceConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    const numKeys = {
        timerMinutes: [1, 1440],
        dim: [0, 0.95],
        videoBlur: [0, 30],
        panelAlpha: [0, 1],
        panelBlurPx: [0, 32],
        lumaBoost: [0, 0.92],
        playbackRate: [0.25, 2.5],
        videoSat: [0.2, 2.5],
        videoContrast: [0.5, 2.0],
        fontSizePx: [11, 22],
        radiusPx: [0, 24],
        wallpaperVolume: [0, 1],
        currentIndex: [-1, 100000],
    };
    for (const [k, [min, max]] of Object.entries(numKeys)) {
        if (typeof raw[k] === "number" && Number.isFinite(raw[k])) {
            out[k] = Math.max(min, Math.min(max, raw[k]));
        }
    }
    const boolKeys = [
        "paused", "muted", "autoContrast", "adaptiveAccent", "privacyMode", "privacyHidePaths",
        "hideMature", "hideLowRes", "reduceBackdropBlur", "pauseVideoInModal",
        "pauseVideoOnBlur", "reduceMotion", "staticWallpaperMode", "wallpaperEnabled",
        "stopServerOnTabClose", "showTopTabBar", "useCustomBg", "useCustomText",
        "darkUseCustomBg", "darkUseCustomText", "lightUseCustomBg", "lightUseCustomText",
    ];
    for (const k of boolKeys) {
        if (typeof raw[k] === "boolean") out[k] = raw[k];
    }
    if (raw.themeMode === "dark" || raw.themeMode === "light" || raw.themeMode === "system") out.themeMode = raw.themeMode;
    if (raw.uiContrast === "default" || raw.uiContrast === "high") out.uiContrast = raw.uiContrast;
    if (raw.privacyRevealMode === "never" || raw.privacyRevealMode === "modifier" || raw.privacyRevealMode === "hover") {
        out.privacyRevealMode = raw.privacyRevealMode;
    }
    if (raw.privacyHideStyle === "blur" || raw.privacyHideStyle === "mask") {
        out.privacyHideStyle = raw.privacyHideStyle;
    }
    if (raw.playMode === "lock" || raw.playMode === "seq" || raw.playMode === "random") out.playMode = raw.playMode;
    if (raw.videoFit === "cover" || raw.videoFit === "contain") out.videoFit = raw.videoFit;
    if (raw.mediaFilter === "all" || raw.mediaFilter === "video" || raw.mediaFilter === "image") out.mediaFilter = raw.mediaFilter;
    if (raw.accountStartupMode === "picker" || raw.accountStartupMode === "primary" || raw.accountStartupMode === "last") {
        out.accountStartupMode = raw.accountStartupMode;
    }
    if (typeof raw.primaryAccountId === "string" && /^[a-z0-9_-]{1,64}$/i.test(raw.primaryAccountId.trim())) {
        out.primaryAccountId = raw.primaryAccountId.trim().toLowerCase();
    }
    if (raw.lang === "ru" || raw.lang === "en") out.lang = raw.lang;
    if (typeof raw.currentId === "string" && raw.currentId.length <= 256 && !/[\r\n\0]/.test(raw.currentId)) {
        out.currentId = raw.currentId;
    }
    if (Array.isArray(raw.hiddenIds)) {
        out.hiddenIds = raw.hiddenIds
            .filter((x) => typeof x === "string" && x.length <= 256 && !/[\r\n\0]/.test(x))
            .slice(0, 2000);
    }
    for (const hexKey of [
        "customAccentHex", "customBgHex", "customTextHex",
        "darkCustomAccentHex", "darkCustomBgHex", "darkCustomTextHex",
        "lightCustomAccentHex", "lightCustomBgHex", "lightCustomTextHex",
    ]) {
        if (typeof raw[hexKey] === "string" && /^#[0-9a-fA-F]{6}$/.test(raw[hexKey].trim())) {
            out[hexKey] = raw[hexKey].trim().toLowerCase();
        }
    }
    const cleanAccent = sanitizeCssRgbTriplet(raw.accentRgb);
    if (cleanAccent) out.accentRgb = cleanAccent;
    const cleanTint = sanitizeCssRgbTriplet(raw.tintRgb);
    if (cleanTint) out.tintRgb = cleanTint;
    const cleanFont = sanitizeUiFontChoice(raw.uiFontChoice);
    if (cleanFont) out.uiFontChoice = cleanFont;
    return out;
}

function buildShellCspHeader(port) {
    const origin = port > 0 ? `http://127.0.0.1:${port}` : "'self'";
    return [
        `default-src 'self' ${origin}`,
        `script-src 'self' 'unsafe-inline'`,
        `style-src 'self' 'unsafe-inline'`,
        `font-src 'self' ${origin} data: blob:`,
        `img-src 'self' ${origin} https: data: blob:`,
        `media-src 'self' ${origin} data: blob:`,
        `connect-src 'self' ${origin}`,
        `object-src 'none'`,
        `base-uri 'none'`,
        `frame-ancestors 'none'`,
    ].join("; ");
}

function readLimitedJsonBody(req, res, maxBytes, onJson) {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
        if (aborted) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8");
        totalBytes += buf.length;
        if (totalBytes > maxBytes) {
            aborted = true;
            if (!res.headersSent) {
                res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false,"error":"payload_too_large"}');
            }
            try { req.destroy(); } catch {}
        } else {
            chunks.push(buf);
        }
    });
    req.on("error", () => {
        if (aborted) return;
        aborted = true;
        if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end('{"ok":false,"error":"request_error"}');
        }
    });
    req.on("end", () => {
        if (aborted || res.headersSent) return;
        try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false,"error":"invalid_json_object"}');
                return;
            }
            onJson(parsed);
        } catch {
            if (!res.headersSent) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false,"error":"bad_json"}');
            }
        }
    });
}

function handleFontsRequest(reqUrl, req, res, opts = {}) {
    const pathname = String(reqUrl?.pathname || "");
    if (!pathname.startsWith("/fonts/")) return false;

    const fontsDir = typeof opts.getFontsDir === "function" ? opts.getFontsDir() : getCustomFontsDir();
    const broadcast = typeof opts.broadcast === "function" ? opts.broadcast : broadcastSseEvent;

    if (pathname === "/fonts/list" && req.method === "GET") {
        const fonts = scanCustomFonts(fontsDir);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, dir: fontsDir, fonts }));
        return true;
    }

    if (pathname === "/fonts/open" && req.method === "POST") {
        const safeDir = isSafeOpenDirectory(fontsDir);
        if (safeDir) {
            try { require("electron").shell.openPath(fontsDir); } catch {}
        }
        res.writeHead(safeDir ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: safeDir, dir: safeDir ? fontsDir : "" }));
        return true;
    }

    if (pathname === "/fonts/add" && req.method === "POST") {
        const { dialog } = require("electron");
        dialog.showOpenDialog({
            title: "Выберите файлы шрифтов (.ttf, .otf, .woff, .woff2)",
            properties: ["openFile", "multiSelections"],
            filters: [
                { name: "Шрифты (TTF, OTF, WOFF, WOFF2)", extensions: ["ttf", "otf", "woff", "woff2"] },
            ],
        }).then(async (pick) => {
            let added = 0;
            const addedNames = [];
            if (pick && !pick.canceled && Array.isArray(pick.filePaths) && fontsDir) {
                try { await fs.promises.mkdir(fontsDir, { recursive: true }); } catch {}
                for (const src of pick.filePaths) {
                    try {
                        const cleanName = sanitizeFontFileName(path.basename(src));
                        if (!cleanName) continue;
                        const st = await fs.promises.lstat(src);
                        if (!st.isFile() || st.size <= 0 || st.size > MAX_FONT_SIZE_BYTES) continue;
                        const dst = path.join(fontsDir, cleanName);
                        await fs.promises.copyFile(src, dst);
                        added++;
                        addedNames.push(cleanName);
                    } catch {}
                }
            }
            const fonts = scanCustomFonts(fontsDir);
            const addedFonts = fonts.filter((f) => addedNames.includes(f.fileName));
            if (added > 0) broadcast("fonts", { fonts });
            if (!res.headersSent) {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, added, addedFonts, dir: fontsDir, fonts }));
            }
        }).catch(() => {
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false}');
            }
        });
        return true;
    }

    if (pathname === "/fonts/upload" && req.method === "POST") {
        readLimitedJsonBody(req, res, 36 * 1024 * 1024, (parsed) => {
            const fileName = typeof parsed.fileName === "string" ? parsed.fileName : "";
            const dataBase64 = typeof parsed.dataBase64 === "string" ? parsed.dataBase64 : "";
            const cleanB64 = dataBase64.replace(/^data:[^;]+;base64,/i, "").trim();
            if (!fileName || !cleanB64) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false,"error":"invalid_payload"}');
                return;
            }
            const buf = Buffer.from(cleanB64, "base64");
            const saved = saveCustomFontBuffer(fileName, buf, fontsDir);
            if (!saved) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false,"error":"invalid_font"}');
                return;
            }
            const fonts = scanCustomFonts(fontsDir);
            broadcast("fonts", { fonts });
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, font: saved, fonts }));
        });
        return true;
    }

    if (pathname === "/fonts/delete" && req.method === "POST") {
        readLimitedJsonBody(req, res, 64 * 1024, (parsed) => {
            const resolved = resolveCustomFontFile(String(parsed.fileName || ""), fontsDir);
            if (!resolved) {
                res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
                res.end('{"ok":false,"error":"not_found"}');
                return;
            }
            fs.unlinkSync(resolved.filePath);
            const fonts = scanCustomFonts(fontsDir);
            broadcast("fonts", { fonts });
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, fonts }));
        });
        return true;
    }

    if (req.method === "GET" || req.method === "HEAD") {
        const rawFile = pathname.slice("/fonts/".length);
        const resolved = resolveCustomFontFile(rawFile, fontsDir);
        if (!resolved) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Font not found");
            return true;
        }
        res.writeHead(200, {
            "Content-Type": resolved.mime,
            "Content-Length": String(resolved.size),
            "Cache-Control": "public, max-age=31536000, immutable",
        });
        if (req.method === "HEAD") {
            res.end();
            return true;
        }
        const rs = fs.createReadStream(resolved.filePath);
        res.on("close", () => { try { rs.destroy(); } catch {} });
        rs.on("error", () => { try { res.end(); } catch {} });
        rs.pipe(res);
        return true;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end('{"ok":false,"error":"method_not_allowed"}');
    return true;
}

function isSafeOpenDirectory(dir) {
    if (typeof dir !== "string" || !dir.trim()) return false;
    const s = dir.trim();
    if (!path.isAbsolute(s) || s.startsWith("\\\\")) return false;
    try {
        return fs.statSync(s).isDirectory();
    } catch {
        return false;
    }
}

function ensureLocalServer() {
    if (serverStarted) return;
    serverStarted = true;
    if (!accountsSseWired && typeof agyAccounts.onAccountsChanged === "function") {
        accountsSseWired = true;
        agyAccounts.onAccountsChanged((snapshot) => {
            broadcastSseEvent("accounts", snapshot);
        });
    }

    const srv = http.createServer((req, res) => {
        try {
            const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
            const check = validateLocalServerRequest(req, reqUrl, {
                serverPort,
                token: SERVER_TOKEN,
                shellToken: SHELL_TOKEN,
                resolveProfileToken: getProfileIdForToken,
            });
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Referrer-Policy", "no-referrer");
            if (!check.ok) {
                res.writeHead(check.status, { "Content-Type": check.contentType || "text/plain; charset=utf-8" });
                res.end(check.body || "");
                return;
            }
            if (check.origin) {
                res.setHeader("Access-Control-Allow-Origin", check.origin);
                res.setHeader("Vary", "Origin");
            }
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, X-Agy-Token");
            res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
            if (check.preflight) { res.writeHead(204); res.end(); return; }

            if (reqUrl.pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache, no-store",
                    "Connection": "keep-alive",
                });
                res.write(": connected\n\n");
                sseClients.add(res);
                const ping = setInterval(() => {
                    if (res.writableEnded || res.destroyed) {
                        clearInterval(ping);
                        sseClients.delete(res);
                        return;
                    }
                    try { res.write(": ping\n\n"); } catch { clearInterval(ping); sseClients.delete(res); }
                }, 25000);
                if (typeof ping.unref === "function") ping.unref();
                const cleanupSse = () => {
                    clearInterval(ping);
                    sseClients.delete(res);
                };
                req.on("close", cleanupSse);
                res.on("close", cleanupSse);
                return;
            }

            if (reqUrl.pathname === "/shell/tabbar") {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": buildShellCspHeader(serverPort),
                });
                res.end(agyShellViews.renderTabBarHtml(serverPort, SHELL_TOKEN));
                return;
            }

            if (reqUrl.pathname === "/shell/picker") {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": buildShellCspHeader(serverPort),
                });
                res.end(agyShellViews.renderPickerHtml(serverPort, SHELL_TOKEN));
                return;
            }

            if (handleExtrasRequest(reqUrl, req, res, serverPort, broadcastSseEvent, { authRole: check.authRole, authProfile: check.authProfile })) return;
            if (handleFontsRequest(reqUrl, req, res)) return;

            if (reqUrl.pathname === "/config") {
                const cfgPath = getAppearanceConfigPath();
                if (req.method === "POST") {
                    readLimitedJsonBody(req, res, 1024 * 1024, (rawCfg) => {
                        const isReset = Boolean(rawCfg && rawCfg._reset === true);
                        const existing = isReset ? {} : sanitizeAppearanceConfig(readAppearanceConfig());
                        const parsed = sanitizeAppearanceConfig(rawCfg);
                        const nextCfg = Object.assign({}, existing, parsed);
                        let unchanged = !isReset;
                        if (unchanged) {
                            const exKeys = Object.keys(existing);
                            const nxKeys = Object.keys(nextCfg);
                            if (exKeys.length !== nxKeys.length) {
                                unchanged = false;
                            } else {
                                for (let i = 0; i < nxKeys.length; i++) {
                                    const k = nxKeys[i];
                                    const a = existing[k];
                                    const b = nextCfg[k];
                                    if (a !== b) {
                                        if (Array.isArray(a) && Array.isArray(b)) {
                                            if (a.length !== b.length || a.some((v, idx) => v !== b[idx])) { unchanged = false; break; }
                                        } else {
                                            unchanged = false; break;
                                        }
                                    }
                                }
                            }
                        }
                        if (!unchanged) {
                            atomicWriteFileRetrySync(cfgPath, JSON.stringify(nextCfg, null, 2), { encoding: "utf8", mode: 0o600 });
                            if (typeof parsed.showTopTabBar === "boolean") {
                                try {
                                    const tm = require("./agyTabManager");
                                    if (tm && typeof tm.setTabBarVisible === "function") tm.setTabBarVisible(parsed.showTopTabBar);
                                } catch {}
                            }
                            if (
                                typeof parsed.privacyMode === "boolean" ||
                                typeof parsed.privacyHidePaths === "boolean" ||
                                typeof parsed.privacyHideStyle === "string" ||
                                typeof parsed.primaryAccountId === "string" ||
                                isReset
                            ) {
                                try {
                                    const tm = require("./agyTabManager");
                                    if (tm && typeof tm.updateWindowTitle === "function") tm.updateWindowTitle();
                                } catch {}
                            }
                            if (typeof parsed.themeMode === "string" || isReset) {
                                try {
                                    const tm = require("./agyTabManager");
                                    if (tm && typeof tm.updateTitleBarOverlay === "function") tm.updateTitleBarOverlay();
                                } catch {}
                            }
                            broadcastSseEvent("config", nextCfg);
                        }
                        if (!res.headersSent) {
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(unchanged ? '{"ok":true,"unchanged":true}' : '{"ok":true}');
                        }
                    });
                    return;
                }
                let data = {};
                try { if (fs.existsSync(cfgPath)) data = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
                res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
                res.end(JSON.stringify(data));
                return;
            }

            if (reqUrl.pathname === "/accounts/list") {
                const snap = typeof agyAccounts.getAccountsSnapshot === "function"
                    ? agyAccounts.getAccountsSnapshot()
                    : { accounts: typeof agyAccounts.loadAccounts === "function" ? agyAccounts.loadAccounts() : [] };
                res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
                res.end(JSON.stringify(snap));
                return;
            }

            if (reqUrl.pathname === "/accounts/open-picker" && req.method === "POST") {
                try {
                    const tm = require("./agyTabManager");
                    if (tm && typeof tm.showPicker === "function") tm.showPicker();
                } catch {}
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"ok":true}');
                return;
            }

            if (reqUrl.pathname === "/custom-wallpapers/open" && req.method === "POST") {
                const dir = getCustomWallpaperDir();
                const safeDir = isSafeOpenDirectory(dir);
                if (safeDir) {
                    try { require("electron").shell.openPath(dir); } catch {}
                }
                res.writeHead(safeDir ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: safeDir, dir: safeDir ? dir : "" }));
                return;
            }

            if (reqUrl.pathname === "/custom-wallpapers/add" && req.method === "POST") {
                const dir = getCustomWallpaperDir();
                const { dialog } = require("electron");
                dialog.showOpenDialog({
                    title: "Выберите фото или видео для обоев",
                    properties: ["openFile", "multiSelections"],
                    filters: [
                        { name: "Обои (Фото и Видео)", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "mp4", "webm", "m4v", "mov"] },
                    ],
                }).then(async (pick) => {
                    let added = 0;
                    if (pick && !pick.canceled && Array.isArray(pick.filePaths) && dir) {
                        try { await fs.promises.mkdir(dir, { recursive: true }); } catch {}
                        for (const src of pick.filePaths) {
                            try {
                                const dst = path.join(dir, path.basename(src));
                                await fs.promises.copyFile(src, dst);
                                added++;
                            } catch {}
                        }
                    }
                    const videos = scanWallpapers(true).map((v) => ({
                        index: v.index, id: v.id, name: v.name, folder: v.folder,
                        source: v.source || "workshop", kind: v.kind, duration: v.duration,
                        width: v.width, height: v.height, resLabel: v.resLabel,
                        isLowRes: v.isLowRes, isMature: v.isMature,
                    }));
                    if (!res.headersSent) {
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ ok: true, added, dir, videos }));
                    }
                }).catch(() => {
                    if (!res.headersSent) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end('{"ok":false}');
                    }
                });
                return;
            }

            if (reqUrl.pathname === "/list") {
                const force = reqUrl.searchParams.get("refresh") === "1";
                const videos = scanWallpapers(force).map((v) => ({
                    index: v.index,
                    id: v.id,
                    name: v.name,
                    folder: v.folder,
                    source: v.source || "workshop",
                    kind: v.kind,
                    duration: v.duration,
                    width: v.width,
                    height: v.height,
                    resLabel: v.resLabel,
                    isLowRes: v.isLowRes,
                    isMature: v.isMature,
                }));
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                res.end(JSON.stringify({ profile: getActiveProfile(), theme: BASE_THEME, videos, customDir: getCustomWallpaperDir() }));
                return;
            }

            if (reqUrl.pathname.startsWith("/stream/")) {
                const idx = parseInt(reqUrl.pathname.slice("/stream/".length), 10);
                const items = scanWallpapers(false);
                const item = Number.isInteger(idx) && items[idx] ? items[idx] : null;
                if (!item || !fs.existsSync(item.filePath)) { res.writeHead(404); res.end("Not found"); return; }

                const baseOffset = item.offset || 0;
                const fileSize = item.size;
                const mime = item.mime || "video/mp4";
                const range = req.headers.range;

                if (range) {
                    const parsedRange = parseByteRangeHeader(range, fileSize);
                    if (!parsedRange.ok) {
                        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
                        res.end();
                        return;
                    }
                    const { start, end } = parsedRange;
                    res.writeHead(206, {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": String(end - start + 1),
                        "Content-Type": mime,
                    });
                    if (req.method === "HEAD") { res.end(); return; }
                    const rs = fs.createReadStream(item.filePath, { start: baseOffset + start, end: baseOffset + end });
                    res.on("close", () => { try { rs.destroy(); } catch {} });
                    rs.on("error", () => { try { res.end(); } catch {} });
                    rs.pipe(res);
                    return;
                }

                res.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": String(fileSize), "Content-Type": mime });
                if (req.method === "HEAD") { res.end(); return; }
                const rsFull = fs.createReadStream(item.filePath, { start: baseOffset, end: baseOffset + fileSize - 1 });
                res.on("close", () => { try { rsFull.destroy(); } catch {} });
                rsFull.on("error", () => { try { res.end(); } catch {} });
                rsFull.pipe(res);
                return;
            }

            res.writeHead(404);
            res.end("Not found");
        } catch (err) {
            console.error("[WallpaperEngine] HTTP error:", err);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    });

    srv.on("error", (err) => {
        console.error("[WallpaperEngine] Local HTTP server error:", err?.message || err);
        serverStarted = false;
        serverPort = 0;
    });
    if (app && typeof app.once === "function") {
        app.once("will-quit", () => {
            for (const client of [...sseClients]) {
                try { client.end(); } catch {}
            }
            sseClients.clear();
            try { srv.close(); } catch {}
        });
    }

    srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
            serverPort = addr.port;
        }
    });
}

function registerWallpaperScheme() {}

const cspHookedSessions = new WeakMap();

function parseByteRangeHeader(rangeHeader, fileSize) {
    const size = Number(fileSize);
    if (!Number.isFinite(size) || size <= 0) return { ok: false };
    const raw = String(rangeHeader || "").trim();
    const m = /^bytes=(\d*)-(\d*)$/i.exec(raw);
    if (!m || (!m[1] && !m[2])) return { ok: false };
    let start;
    let end;
    if (!m[1] && m[2]) {
        const suffixLen = Number(m[2]);
        if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) return { ok: false };
        start = Math.max(0, size - suffixLen);
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
            return { ok: false };
        }
    }
    return { ok: true, start, end };
}

function rewriteCspHeaderForWallpaper(headers) {
    const out = { ...(headers || {}) };
    const localOrigin = serverPort > 0 ? `http://127.0.0.1:${serverPort}` : "";
    if (!localOrigin) return out;
    for (const key of Object.keys(out)) {
        if (key.toLowerCase() === "content-security-policy" && Array.isArray(out[key])) {
            out[key] = out[key].map((csp) => {
                let updated = csp;
                if (/media-src\s+/i.test(updated)) {
                    if (!updated.includes(localOrigin)) updated = updated.replace(/media-src\s+/i, `media-src ${localOrigin} blob: data: `);
                } else {
                    updated += `; media-src 'self' ${localOrigin} blob: data:`;
                }
                if (/img-src\s+/i.test(updated)) {
                    if (!updated.includes(localOrigin)) updated = updated.replace(/img-src\s+/i, `img-src ${localOrigin} blob: data: `);
                } else {
                    updated += `; img-src 'self' ${localOrigin} https: blob: data:`;
                }
                if (/font-src\s+/i.test(updated)) {
                    if (!updated.includes(localOrigin)) updated = updated.replace(/font-src\s+/i, `font-src ${localOrigin} data: blob: `);
                } else {
                    updated += `; font-src 'self' ${localOrigin} data: blob:`;
                }
                if (/connect-src\s+/i.test(updated)) {
                    if (!updated.includes(localOrigin)) updated = updated.replace(/connect-src\s+/i, `connect-src ${localOrigin} `);
                } else {
                    updated += `; connect-src 'self' ${localOrigin}`;
                }
                return updated;
            });
        }
    }
    return out;
}

function attachWallpaperCspToSession(targetSession) {
    if (!targetSession?.webRequest || cspHookedSessions.has(targetSession)) return;
    const webRequest = targetSession.webRequest;
    const origOnHeadersReceived = typeof webRequest.onHeadersReceived === "function"
        ? webRequest.onHeadersReceived.bind(webRequest)
        : null;
    if (!origOnHeadersReceived) return;

    const hookState = { externalListener: null };
    cspHookedSessions.set(targetSession, hookState);

    const urlMatchesExternalFilter = (url, filter) => {
        if (!filter || !Array.isArray(filter.urls) || filter.urls.length === 0) return true;
        return filter.urls.some((pat) => {
            if (pat === "<all_urls>") return true;
            const prefix = pat.split("*")[0];
            return prefix ? String(url || "").startsWith(prefix) : true;
        });
    };

    try {
        webRequest.onHeadersReceived = function chainedOnHeadersReceived(filterOrListener, maybeListener) {
            if (filterOrListener === null) {
                hookState.externalListener = null;
                return;
            }
            if (typeof filterOrListener === "function") {
                hookState.externalListener = { filter: null, fn: filterOrListener };
            } else if (typeof maybeListener === "function") {
                hookState.externalListener = { filter: filterOrListener, fn: maybeListener };
            } else {
                hookState.externalListener = null;
            }
        };

        origOnHeadersReceived(
            { urls: ["<all_urls>"] },
            (details, callback) => {
                const isLocalUrl = /^https?:\/\/127\.0\.0\.1(?::|\/|$)/i.test(String(details?.url || ""));
                const finalize = (resultObj) => {
                    const base = resultObj && typeof resultObj === "object" ? resultObj : {};
                    if (base.cancel) {
                        callback(base);
                        return;
                    }
                    const headers = isLocalUrl
                        ? rewriteCspHeaderForWallpaper(base.responseHeaders || details?.responseHeaders || {})
                        : (base.responseHeaders || details?.responseHeaders);
                    callback({ ...base, responseHeaders: headers });
                };

                const ext = hookState.externalListener;
                if (ext && typeof ext.fn === "function" && urlMatchesExternalFilter(details?.url, ext.filter)) {
                    try {
                        ext.fn(details, finalize);
                        return;
                    } catch {}
                }
                finalize({ responseHeaders: details?.responseHeaders });
            }
        );
    } catch (err) {
        console.error("[WallpaperEngine] CSP hook error:", err);
    }
}

function registerWallpaperProtocol() {
    ensureLocalServer();
    attachWallpaperCspToSession(session.defaultSession);
}

function buildInjectedCss(theme) {
    return `
/* ===== 1. Clean Unified Design Tokens (Zero Neon, Unified Corner Radius, Consistent Transparency) ===== */
:root,
:host {
    --agy-accent-rgb: ${theme.accentRgb};
    --agy-tint-rgb: ${theme.tintRgb};
    --agy-ui-font: ${theme.uiFont};
    --agy-mono-font: ${theme.monoFont};
    --agy-base-font-size: ${theme.fontSize};

    --agy-fg: #f8fafc;
    --agy-fg-secondary: #e2e8f0;
    --agy-fg-muted: #b8c4d4;
    --agy-fg-subtle: #8b9bb0;
    --agy-border: rgba(255, 255, 255, 0.15);
    --agy-border-strong: rgba(255, 255, 255, 0.26);
    --agy-divider: rgba(255, 255, 255, 0.11);
    --agy-hover-bg: rgba(255, 255, 255, 0.08);
    --agy-subtle-bg: rgba(255, 255, 255, 0.06);
    --agy-subtle-bg-strong: rgba(255, 255, 255, 0.14);
    --agy-backdrop-bg: rgba(4, 6, 10, 0.56);
    --agy-nav-bg: rgba(255, 255, 255, 0.02);
    --agy-card-bg: rgba(255, 255, 255, 0.035);
    --agy-scrim-color: rgba(6, 8, 14, 0.88);
    --agy-scrollbar-thumb: rgba(255, 255, 255, 0.16);
    --agy-scrollbar-thumb-hover: rgba(255, 255, 255, 0.30);
    --agy-shadow-panel: 0 18px 46px rgba(0, 0, 0, 0.42);
    --agy-shadow-card: 0 10px 30px rgba(0, 0, 0, 0.36);
    --agy-shadow-card-focus: 0 12px 34px rgba(0, 0, 0, 0.44);

    --agy-radius: 10px;
    --agy-radius-sm: 7px;
    --agy-radius-lg: 10px;

    /* Override Tailwind v4 / native radius variables so the ENTIRE app shares one unified corner radius */
    --radius: var(--agy-radius);
    --radius-sm: var(--agy-radius-sm);
    --radius-md: var(--agy-radius-sm);
    --radius-lg: var(--agy-radius);
    --radius-xl: var(--agy-radius);
    --radius-2xl: var(--agy-radius);
    --radius-3xl: var(--agy-radius);
    --nux-radius-sm: var(--agy-radius-sm);
    --nux-radius-md: var(--agy-radius);
    --nux-radius-lg: var(--agy-radius);
    --nux-radius-xl: var(--agy-radius);

    --agy-wp-dim: 0.36;
    --agy-video-blur: 0px;
    --agy-video-blur-num: 0;
    --agy-panel-alpha: 0.68;
    --agy-surface-base-alpha: 0.380;
    --agy-surface-sidebar-alpha: 0.641;
    --agy-surface-card-alpha: 0.698;
    --agy-surface-composer-alpha: 0.732;
    --agy-surface-editor-alpha: 0.800;
    --agy-surface-modal-alpha: 0.773;
    --agy-effective-alpha: var(--agy-surface-sidebar-alpha);
    --agy-panel-blur: 20px;
    --agy-surface-base: rgba(var(--agy-tint-rgb), var(--agy-surface-base-alpha));
    --agy-surface-sidebar: rgba(var(--agy-tint-rgb), var(--agy-surface-sidebar-alpha));
    --agy-surface-card: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha));
    --agy-surface-composer: rgba(var(--agy-tint-rgb), var(--agy-surface-composer-alpha));
    --agy-surface-editor: rgba(var(--agy-tint-rgb), var(--agy-surface-editor-alpha));
    --agy-surface-modal: rgba(var(--agy-tint-rgb), var(--agy-surface-modal-alpha));
    --agy-surface-dialog: var(--agy-surface-modal);
    --agy-surface-popover: rgba(var(--agy-tint-rgb), 0.90);
    --agy-surface-sticky: var(--agy-surface-popover);
    --agy-luma-boost: 0;
    --agy-hc-scrim-lift: 0;
    --agy-scrim-opacity: 0.36;
    --agy-video-sat: 1.00;
    --agy-video-contrast: 1.00;
    --agy-video-fit: cover;

    --agy-danger-fg: #f87171;
    --agy-warn-fg: #fbbf24;
    --agy-ok-fg: #4ade80;
    --agy-code-fg: #e2e8f0;
    --code-foreground: var(--agy-code-fg) !important;
    --color-code: var(--agy-code-fg) !important;

    --agy-diff-add-bg: rgba(34, 197, 94, 0.16);
    --agy-diff-add-word-bg: rgba(34, 197, 94, 0.32);
    --agy-diff-add-border: rgba(74, 222, 128, 0.72);
    --agy-diff-add-fg: #86efac;
    --agy-diff-del-bg: rgba(239, 68, 68, 0.16);
    --agy-diff-del-word-bg: rgba(239, 68, 68, 0.32);
    --agy-diff-del-border: rgba(248, 113, 113, 0.72);
    --agy-diff-del-fg: #fca5a5;

    --agy-on-solid-accent: #000000;
    --agy-on-tinted-accent: #ffffff;
    --agy-accent-text: #93c5fd;

    --shell: transparent !important;
    --shell-canvas: transparent !important;
    color-scheme: dark;
}

html[data-agy-surface="light"] {
    --agy-fg: #111827;
    --agy-fg-secondary: #1f2937;
    --agy-fg-muted: #475569;
    --agy-fg-subtle: #64748b;
    --agy-border: rgba(15, 23, 42, 0.16);
    --agy-border-strong: rgba(15, 23, 42, 0.28);
    --agy-divider: rgba(15, 23, 42, 0.12);
    --agy-hover-bg: rgba(255, 255, 255, 0.54);
    --agy-subtle-bg: rgba(248, 250, 252, 0.56);
    --agy-subtle-bg-strong: rgba(241, 245, 249, 0.74);
    --agy-backdrop-bg: rgba(241, 245, 249, 0.20);
    --agy-nav-bg: rgba(255, 255, 255, 0.38);
    --agy-card-bg: rgba(255, 255, 255, 0.50);
    --agy-scrim-color: rgba(250, 251, 254, 0.92);
    --agy-scrollbar-thumb: rgba(15, 23, 42, 0.22);
    --agy-scrollbar-thumb-hover: rgba(15, 23, 42, 0.38);
    --agy-shadow-panel: 0 16px 40px rgba(15, 23, 42, 0.14);
    --agy-shadow-card: 0 8px 24px rgba(15, 23, 42, 0.10);
    --agy-shadow-card-focus: 0 10px 28px rgba(15, 23, 42, 0.16);
    --agy-danger-fg: #b91c1c;
    --agy-warn-fg: #b45309;
    --agy-ok-fg: #15803d;
    --agy-code-fg: #0f172a;
    --agy-diff-add-bg: rgba(22, 163, 74, 0.14);
    --agy-diff-add-word-bg: rgba(22, 163, 74, 0.28);
    --agy-diff-add-border: #16a34a;
    --agy-diff-add-fg: #14532d;
    --agy-diff-del-bg: rgba(220, 38, 38, 0.13);
    --agy-diff-del-word-bg: rgba(220, 38, 38, 0.26);
    --agy-diff-del-border: #dc2626;
    --agy-diff-del-fg: #7f1d1d;
    color-scheme: light;
}

html[data-agy-contrast="high"] {
    --agy-fg: #ffffff;
    --agy-fg-secondary: #f8fafc;
    --agy-fg-muted: #e2e8f0;
    --agy-fg-subtle: #cbd5e1;
    --agy-border: rgba(255, 255, 255, 0.42);
    --agy-border-strong: rgba(255, 255, 255, 0.68);
    --agy-divider: rgba(255, 255, 255, 0.32);
    --agy-hover-bg: rgba(255, 255, 255, 0.15);
    --agy-subtle-bg: rgba(255, 255, 255, 0.12);
    --agy-subtle-bg-strong: rgba(255, 255, 255, 0.25);
    --agy-nav-bg: rgba(255, 255, 255, 0.035);
    --agy-card-bg: rgba(255, 255, 255, 0.065);
    --agy-hc-scrim-lift: 0.12;
    --agy-danger-fg: #fca5a5;
    --agy-warn-fg: #fde047;
    --agy-ok-fg: #86efac;
    --agy-diff-add-bg: rgba(34, 197, 94, 0.22);
    --agy-diff-del-bg: rgba(239, 68, 68, 0.22);
}

html[data-agy-surface="light"][data-agy-contrast="high"] {
    --agy-fg: #000000;
    --agy-fg-secondary: #0f172a;
    --agy-fg-muted: #1e293b;
    --agy-fg-subtle: #334155;
    --agy-border: rgba(15, 23, 42, 0.44);
    --agy-border-strong: rgba(15, 23, 42, 0.68);
    --agy-divider: rgba(15, 23, 42, 0.34);
    --agy-hover-bg: rgba(255, 255, 255, 0.74);
    --agy-subtle-bg: rgba(241, 245, 249, 0.72);
    --agy-subtle-bg-strong: rgba(226, 232, 240, 0.86);
    --agy-nav-bg: rgba(248, 250, 252, 0.56);
    --agy-card-bg: rgba(255, 255, 255, 0.66);
    --agy-hc-scrim-lift: 0.12;
    --agy-danger-fg: #991b1b;
    --agy-warn-fg: #92400e;
    --agy-ok-fg: #14532d;
    --agy-diff-add-bg: rgba(22, 163, 74, 0.20);
    --agy-diff-del-bg: rgba(220, 38, 38, 0.19);
}

/* Hide visual blocks moved from Antigravity's native Appearance tab into Personalization */
[data-agy-hidden-native-appearance="1"] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
}

/* Prevent dropdown menus, top bar options, and buttons from wrapping awkwardly onto 2 lines at 18px font */
[data-testid="title-menu-bar-item"],
[data-testid="title-menu-bar-option"],
[data-testid="title-menu-bar-option"] > span,
[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"],
[data-testid="model-selector-item"],
[data-testid="model-selector-orchestrator"],
[data-testid="model-selector-effort-option"],
[data-slot="toggle-group"] > button,
.agy-select-trigger,
button.agy-button {
    white-space: nowrap !important;
}

[data-testid="title-menu-bar"] [data-browser-occluder="true"] {
    width: max-content !important;
    min-width: max(225px, max-content) !important;
    max-width: min(440px, 92vw) !important;
}

[role="menu"],
[role="listbox"],
[data-radix-menu-content] {
    min-width: max(210px, max-content) !important;
    max-width: min(460px, 92vw) !important;
}

[role="menu"] [role="menuitem"],
[role="menu"] [role="menuitemcheckbox"],
[role="menu"] [role="menuitemradio"],
[data-radix-menu-content] [role="menuitem"] {
    white-space: nowrap !important;
}

/* Keep multi-line helper descriptions inside menus/popovers readable without breaking single-line truncated rows */
[role="menu"] .text-muted-foreground:not(.truncate),
[role="listbox"] .text-muted-foreground:not(.truncate),
[role="dialog"] .text-muted-foreground:not(.truncate),
[role="tooltip"] {
    white-space: normal !important;
}

[data-split-root="true"] > div:has([data-testid="settings-sidebar"]) {
    width: clamp(240px, 15.5em, 300px) !important;
    min-width: clamp(240px, 15.5em, 300px) !important;
    flex: 0 0 clamp(240px, 15.5em, 300px) !important;
}

[data-split-root="true"] > div:has([data-testid="settings-sidebar"]) > div,
[data-testid="settings-sidebar"] {
    width: 100% !important;
    min-width: 0 !important;
}

[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"] {
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}

/* Fully neutralize native Antigravity theme classes/attributes (.light, .dark, data-theme, data-color-mode) */
:root,
html,
:root.light,
html.light,
html[data-theme="light"],
html[data-color-mode="light"],
body.light,
body[data-theme="light"],
body[data-color-mode="light"],
:root.dark,
html.dark,
html[data-theme="dark"],
html[data-color-mode="dark"],
body.dark,
body[data-theme="dark"],
body[data-color-mode="dark"],
html[data-agy-theme-mode] [data-theme],
html[data-agy-theme-mode] [data-color-mode] {
    --background: transparent !important;
    --color-background: transparent !important;
    --sidebar: var(--agy-surface-sidebar) !important;
    --color-sidebar: var(--agy-surface-sidebar) !important;
    --sidebar-secondary: rgba(var(--agy-accent-rgb), 0.20) !important;
    --color-sidebar-secondary: rgba(var(--agy-accent-rgb), 0.20) !important;

    --card: var(--agy-surface-card) !important;
    --color-card: var(--agy-surface-card) !important;
    --popover: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --color-popover: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --glass: var(--agy-surface-card) !important;
    --glass-border: var(--agy-border) !important;
    --glass-highlight: var(--agy-hover-bg) !important;

    --foreground: var(--agy-fg) !important;
    --color-foreground: var(--agy-fg) !important;
    --card-foreground: var(--agy-fg) !important;
    --color-card-foreground: var(--agy-fg) !important;
    --popover-foreground: var(--agy-fg) !important;
    --color-popover-foreground: var(--agy-fg) !important;
    --sidebar-foreground: var(--agy-fg) !important;
    --color-sidebar-foreground: var(--agy-fg) !important;
    --sidebar-muted: var(--agy-subtle-bg) !important;
    --color-sidebar-muted: var(--agy-subtle-bg) !important;
    --sidebar-border: var(--agy-divider) !important;
    --color-sidebar-border: var(--agy-divider) !important;
    --card-border: var(--agy-border) !important;
    --color-card-border: var(--agy-border) !important;
    --secondary: var(--agy-subtle-bg) !important;
    --color-secondary: var(--agy-subtle-bg) !important;
    --secondary-foreground: var(--agy-fg-secondary) !important;
    --color-secondary-foreground: var(--agy-fg-secondary) !important;
    --muted-foreground: var(--agy-fg-muted) !important;
    --color-muted-foreground: var(--agy-fg-muted) !important;
    --accent-foreground: var(--agy-on-solid-accent) !important;
    --color-accent-foreground: var(--agy-on-solid-accent) !important;
    --border: var(--agy-border) !important;
    --color-border: var(--agy-border) !important;
    --input: var(--agy-border) !important;
    --color-input: var(--agy-border) !important;
    --card-edge: var(--agy-divider) !important;

    --onyx-frame: var(--agy-surface-sidebar) !important;
    --onyx-raised: var(--agy-surface-card) !important;
    --onyx-selected: rgba(var(--agy-accent-rgb), 0.20) !important;
    --onyx-well: var(--agy-surface-sidebar) !important;
    --onyx-key: rgba(var(--agy-accent-rgb), 0.28) !important;

    --primary: rgb(var(--agy-accent-rgb)) !important;
    --color-primary: rgb(var(--agy-accent-rgb)) !important;
    --primary-foreground: var(--agy-on-solid-accent) !important;
    --color-primary-foreground: var(--agy-on-solid-accent) !important;
    --cta: rgb(var(--agy-accent-rgb)) !important;
    --cta-foreground: var(--agy-on-solid-accent) !important;
    --accent: rgb(var(--agy-accent-rgb)) !important;
    --link: var(--agy-accent-text) !important;
    --color-link: var(--agy-accent-text) !important;
    --home-glow: transparent !important;
    --code-foreground: color-mix(in srgb, var(--foreground, #f8fafc) 65%, rgb(var(--agy-accent-rgb))) !important;
    --color-code: color-mix(in srgb, var(--foreground, #f8fafc) 65%, rgb(var(--agy-accent-rgb))) !important;
    --ring: rgba(var(--agy-accent-rgb), 0.45) !important;
    --focus-ring-color: rgba(var(--agy-accent-rgb), 0.45) !important;
    --nux-focus-ring: rgba(var(--agy-accent-rgb), 0.50) !important;
    --muted: var(--agy-surface-sidebar) !important;
    --color-muted: var(--agy-surface-sidebar) !important;
    --sash-line: rgba(var(--agy-accent-rgb), 0.45) !important;
    --sash-glow: transparent !important;
    --editor-selection-background: rgba(var(--agy-accent-rgb), 0.30) !important;
    --editor-comment-selection-background: rgba(var(--agy-accent-rgb), 0.20) !important;

    --vscode-editor-background: transparent !important;
    --vscode-editor-foreground: var(--agy-fg) !important;
    --vscode-editorGutter-background: transparent !important;
    --vscode-editorLineNumber-foreground: var(--agy-fg-subtle) !important;
    --vscode-editorLineNumber-activeForeground: var(--agy-fg) !important;
    --vscode-editor-lineHighlightBackground: var(--agy-hover-bg) !important;
    --vscode-editor-selectionBackground: rgba(var(--agy-accent-rgb), 0.26) !important;
    --vscode-editorWidget-background: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-editorWidget-border: var(--agy-border) !important;
    --vscode-sideBar-background: var(--agy-surface-sidebar) !important;
    --vscode-sideBarSectionHeader-background: transparent !important;
    --vscode-panel-background: var(--agy-surface-sidebar) !important;
    --vscode-quickInput-background: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-quickInput-foreground: var(--agy-fg) !important;
    --vscode-quickInputList-focusBackground: var(--agy-hover-bg) !important;
    --vscode-menu-background: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-menu-foreground: var(--agy-fg) !important;
    --vscode-menu-selectionBackground: rgba(var(--agy-accent-rgb), 0.22) !important;
    --vscode-menu-separatorBackground: var(--agy-divider) !important;
    --vscode-editorHoverWidget-background: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-editorHoverWidget-border: var(--agy-border) !important;
    --vscode-editorSuggestWidget-background: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-editorSuggestWidget-border: var(--agy-border) !important;
    --vscode-input-background: var(--agy-subtle-bg) !important;
    --vscode-input-foreground: var(--agy-fg) !important;
    --vscode-input-border: var(--agy-border) !important;
    --vscode-dropdown-background: var(--agy-subtle-bg) !important;
    --vscode-dropdown-listBackground: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-dropdown-foreground: var(--agy-fg) !important;
    --vscode-dropdown-border: var(--agy-border) !important;
    --vscode-button-secondaryBackground: var(--agy-subtle-bg) !important;
    --vscode-button-secondaryHoverBackground: var(--agy-subtle-bg-strong) !important;
    --vscode-button-secondaryForeground: var(--agy-fg) !important;
    --vscode-notifications-background: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --vscode-notifications-foreground: var(--agy-fg) !important;
    --vscode-notifications-border: var(--agy-border) !important;
    --vscode-list-hoverBackground: var(--agy-hover-bg) !important;
    --vscode-list-activeSelectionBackground: rgba(var(--agy-accent-rgb), 0.22) !important;
    --vscode-list-inactiveSelectionBackground: var(--agy-subtle-bg-strong) !important;
    --vscode-editorStickyScroll-background: var(--agy-surface-sticky, var(--agy-surface-editor)) !important;
    --vscode-diffEditor-insertedLineBackground: var(--agy-diff-add-bg) !important;
    --vscode-diffEditor-insertedTextBackground: var(--agy-diff-add-word-bg) !important;
    --vscode-diffEditor-removedLineBackground: var(--agy-diff-del-bg) !important;
    --vscode-diffEditor-removedTextBackground: var(--agy-diff-del-word-bg) !important;
    --vscode-editorGutter-addedBackground: var(--agy-diff-add-border) !important;
    --vscode-editorGutter-deletedBackground: var(--agy-diff-del-border) !important;
    --vscode-badge-background: var(--agy-subtle-bg) !important;
    --vscode-badge-foreground: var(--agy-fg) !important;
    --vscode-breadcrumb-background: transparent !important;
    --surface: var(--agy-surface-card) !important;
    --color-surface: var(--agy-surface-card) !important;
    --surface-raised: var(--agy-surface-card) !important;
    --color-surface-raised: var(--agy-surface-card) !important;
    --surface-overlay: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --color-surface-overlay: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --surface-secondary: var(--agy-subtle-bg) !important;
    --color-surface-secondary: var(--agy-subtle-bg) !important;
    --panel: var(--agy-surface-sidebar) !important;
    --color-panel: var(--agy-surface-sidebar) !important;
    --header: var(--agy-surface-sticky, var(--agy-surface-popover)) !important;
    --color-header: var(--agy-surface-sticky, var(--agy-surface-popover)) !important;
    --modal: var(--agy-surface-dialog, var(--agy-surface-modal)) !important;
    --color-modal: var(--agy-surface-dialog, var(--agy-surface-modal)) !important;
    --ide-background: transparent !important;
    --ide-surface: var(--agy-surface-card) !important;
    --ide-panel: var(--agy-surface-sidebar) !important;
    --badge: var(--agy-subtle-bg) !important;
    --color-badge: var(--agy-subtle-bg) !important;
    --chip: var(--agy-subtle-bg) !important;
    --color-chip: var(--agy-subtle-bg) !important;
    --onyx-surface: var(--agy-surface-card) !important;
    --onyx-badge: var(--agy-subtle-bg) !important;
    --onyx-chip: var(--agy-subtle-bg) !important;
    --onyx-pill: var(--agy-subtle-bg) !important;

    --font-sans: var(--agy-ui-font) !important;
    --font-ui: var(--agy-ui-font) !important;

    --color-blue-300: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 70%, #ffffff) !important;
    --color-blue-400: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 85%, #ffffff) !important;
    --color-blue-500: rgb(var(--agy-accent-rgb)) !important;
    --color-blue-600: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 85%, #000000) !important;
    --color-blue-700: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 70%, #000000) !important;
    --color-blue-800: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 55%, #000000) !important;
}

/* ===== 2. Root, Typography & Hardware-Accelerated Wallpaper Layer ===== */
html, body {
    background-color: transparent !important;
    color: var(--agy-fg) !important;
    font-family: var(--agy-ui-font, 'Segoe UI Variable', system-ui, sans-serif);
    font-size: var(--agy-base-font-size, inherit);
    -webkit-font-smoothing: antialiased;
}

#root, #app {
    position: relative !important;
    z-index: 1 !important;
    background: transparent !important;
    color: var(--agy-fg) !important;
    font-family: var(--agy-ui-font) !important;
    font-size: var(--agy-base-font-size);
}

body[data-agy-theme] button,
body[data-agy-theme] input,
body[data-agy-theme] select,
body[data-agy-theme] textarea {
    font-family: var(--agy-ui-font);
}

code, pre, kbd, samp, .font-mono, [class*="monospace"] {
    font-family: var(--agy-mono-font) !important;
}

::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
::-webkit-scrollbar-track { background: transparent !important; }
::-webkit-scrollbar-thumb { background: var(--agy-scrollbar-thumb) !important; border-radius: 3px !important; }
::-webkit-scrollbar-thumb:hover { background: var(--agy-scrollbar-thumb-hover) !important; }

#agy-wallpaper-layer {
    position: fixed !important;
    inset: 0 !important;
    z-index: 0 !important;
    pointer-events: none !important;
    overflow: hidden !important;
    background: rgb(var(--agy-tint-rgb)) !important;
    contain: strict !important;
    transform: translateZ(0);
}

#agy-wallpaper-layer video,
#agy-wallpaper-layer img.agy-scene-bg {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: var(--agy-video-fit, cover) !important;
    transform: translateZ(0);
    transition: opacity 0.35s ease !important;
}

#agy-wallpaper-scrim {
    position: absolute !important;
    inset: 0 !important;
    background: var(--agy-scrim-color) !important;
    opacity: var(--agy-scrim-opacity, min(0.92, calc(var(--agy-wp-dim) + var(--agy-luma-boost) + var(--agy-hc-scrim-lift)))) !important;
    pointer-events: none !important;
}

html[data-agy-plain-bg="1"],
html[data-agy-plain-bg="1"] body[data-agy-theme],
html[data-agy-plain-bg="1"] #agy-wallpaper-layer {
    background: rgb(var(--agy-tint-rgb)) !important;
}
html[data-agy-plain-bg="1"] #agy-wallpaper-layer video,
html[data-agy-plain-bg="1"] #agy-wallpaper-layer img.agy-scene-bg,
html[data-agy-plain-bg="1"] #agy-wallpaper-scrim {
    display: none !important;
    opacity: 0 !important;
}

/* ===== 3. Layered Chat Canvas & Strict Pane Isolation (Zero :has() Overrides) ===== */
:root,
body,
.agy-shell,
.agy-sheet,
.agy-inset-shell,
.dark .agy-inset-shell,
.light .agy-inset-shell,
body[data-agy-theme] .agy-inset-shell {
    --shell: transparent !important;
    --shell-canvas: transparent !important;
    --background: transparent !important;
    --color-background: transparent !important;
    --body-background: transparent !important;
}

.agy-shell,
.agy-sheet,
body[data-agy-theme] .agy-shell,
body[data-agy-theme] .agy-sheet,
[data-tiling-pane],
[data-pane-id],
[data-split-panes] .agy-sheet[data-sheet-inset] [data-tiling-pane],
[data-split-panes] .agy-sheet[data-sheet-inset] [data-pane-id] {
    background-color: transparent !important;
    background-image: none !important;
}

/* Single translucent base layer over wallpaper for chat viewport (never double-stacked) */
html[data-agy-theme-mode] body[data-agy-theme] .agy-inset-shell,
html[data-agy-theme-mode] body[data-agy-theme] [data-main-content-body] {
    background-color: var(--agy-surface-base) !important;
    background-image: none !important;
}
html[data-agy-theme-mode] body[data-agy-theme] [data-main-content-body] {
    contain: style;
}

html[data-agy-theme-mode] body[data-agy-theme] .agy-inset-shell .agy-inset-shell,
html[data-agy-theme-mode] body[data-agy-theme] .agy-inset-shell [data-main-content-body],
html[data-agy-theme-mode] body[data-agy-theme] [role="dialog"] [data-main-content-body],
html[data-agy-theme-mode] body[data-agy-theme] .settings-modal-container [data-main-content-body] {
    background-color: transparent !important;
}

:is([data-main-content-body], .agy-shell, .agy-sheet, .agy-inset-shell, [data-tiling-pane], [data-pane-id], [data-split-root="true"], [role="dialog"], .settings-modal-container) :is(
    [class*="bg-gradient-to-"],
    [class*="from-background"],
    [class*="from-shell"],
    [class*="from-sidebar"],
    [class*="from-surface"],
    [class*="from-card"],
    [class*="from-popover"],
    [class*="from-onyx"],
    [class*="from-ide"],
    [class*="bg-radial"],
    [class*="vignette"],
    [class*="fade-top"],
    [class*="fade-bottom"],
    [class*="gradient-top"],
    [class*="gradient-bottom"],
    [style*="linear-gradient"].pointer-events-none
):not([data-testid="send-button"]):not(.agy-send-button):not([data-diff-type]) {
    background-image: none !important;
    background-color: transparent !important;
}

html[data-agy-surface="light"] body[data-agy-theme] :is(
    [class*="from-black"],
    [class*="from-zinc-"], [class*="from-neutral-"], [class*="from-slate-"], [class*="from-gray-"],
    [class*="from-[#0"], [class*="from-[#1"], [class*="from-[#2"]
):not(#agy-wallpaper-layer *):not(.monaco-editor *):not(.cm-editor *):not([data-diff-type]) {
    background-image: none !important;
    background-color: transparent !important;
}

/* ===== 4. Sidebar, Code Blocks, Editor & Diff Viewer (Targeted & Readable in Dark/Light) ===== */
[aria-label="Sidebar"] {
    background-color: var(--agy-surface-sidebar) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border-right: 1px solid var(--agy-divider) !important;
    contain: style;
}

[aria-label="Sidebar"],
[aria-label="Sidebar"] [data-testid="project-header"],
[aria-label="Sidebar"] [data-testid="section-header"],
body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) {
    color: var(--agy-fg) !important;
}

/* Targeted surface strictly on Editor / File Viewer / Review Diff containers & runtime-tagged [data-agy-editor-pane] (never leaks into chat panes) */
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-editor-pane="1"],
html[data-agy-theme-mode] body[data-agy-theme] [data-split-panes] [data-agy-editor-pane="1"],
html[data-agy-theme-mode] body[data-agy-theme] :is(.file-viewer-root, [data-testid="file-viewer"], .diff-view-mode-detail, .monaco-diff-editor, .monaco-editor, .cm-editor),
html[data-agy-theme-mode] body[data-agy-theme] :is(.breadcrumbs-below-tabs, .breadcrumbs-control, .monaco-breadcrumbs, .editor-group-container > .title, [data-testid*="review-panel"], [data-testid*="changes-panel"], [data-testid*="diff-viewer"], [class*="diff-viewer"]),
html[data-agy-theme-mode] body[data-agy-theme] [data-file-uri]:not([data-main-content-body] [data-file-uri]):not([data-agy-editor-pane="1"] [data-file-uri]) {
    background-color: var(--agy-surface-editor) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    color: var(--agy-fg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is([data-agy-editor-pane="1"], .file-viewer-root, [data-testid="file-viewer"], .diff-view-mode-detail) :is(.file-viewer-root, [data-testid="file-viewer"], .monaco-diff-editor, .monaco-editor, .cm-editor, .diff-view-mode-detail, [data-file-uri]:not([data-main-content-body] [data-file-uri]), .breadcrumbs-below-tabs, .breadcrumbs-control, .monaco-breadcrumbs, [data-pane-id]),
html[data-agy-theme-mode] body[data-agy-theme] .monaco-diff-editor .monaco-editor,
html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor, .cm-editor) :is(.monaco-editor-background, .margin, .minimap, .overflow-guard, .monaco-scrollable-element, .cm-scroller, .cm-gutters) {
    background-color: transparent !important;
    backdrop-filter: none !important;
}

/* Inline code blocks inside chat */
html[data-agy-theme-mode] body[data-agy-theme] :is(.code-block, .prose pre, [data-main-content-body] pre:not(.monaco-editor pre)) {
    background-color: var(--agy-surface-card) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border: 1px solid var(--agy-border) !important;
    border-radius: var(--agy-radius-sm) !important;
    color: var(--agy-fg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.code-block pre, .prose pre pre) {
    background-color: transparent !important;
    backdrop-filter: none !important;
    border: none !important;
}

/* Adapt Monaco token classes when native Monaco theme opposes our active Dark/Light mode (keep diff gutter overlays un-inverted!) */
html[data-agy-surface="light"] body[data-agy-theme] .monaco-editor:is(.vs-dark, .hc-black) :is(.view-lines, .line-numbers) {
    filter: invert(0.92) hue-rotate(180deg) saturate(1.30) contrast(1.12) !important;
}

html[data-agy-surface="light"][data-agy-contrast="high"] body[data-agy-theme] .monaco-editor:is(.vs-dark, .hc-black) :is(.view-lines, .line-numbers) {
    filter: invert(0.95) hue-rotate(180deg) saturate(1.36) contrast(1.22) !important;
}

html[data-agy-surface="dark"] body[data-agy-theme] .monaco-editor:is(.vs, .hc-light) :is(.view-lines, .line-numbers) {
    filter: invert(0.90) hue-rotate(180deg) saturate(1.25) contrast(1.10) !important;
}

html[data-agy-surface="dark"][data-agy-contrast="high"] body[data-agy-theme] .monaco-editor:is(.vs, .hc-light) :is(.view-lines, .line-numbers) {
    filter: invert(0.93) hue-rotate(180deg) saturate(1.32) contrast(1.18) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] .code-line {
    color: var(--agy-fg) !important;
}

/* Fallback only for unstyled class-based tokens; inline-styled tokens are adapted cleanly in HSL via ensureReadableSyntaxColor() */
html[data-agy-surface="light"] body[data-agy-theme] .code-line .token:not([data-agy-code-adapted="1"]):not([style*="color"]) {
    filter: brightness(0.50) contrast(1.28) saturate(1.24) !important;
}

/* Explicit Diff added/removed line, inline word, and gutter colors in both Dark & Light */
html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .line-insert, .monaco-diff-editor .cdr.line-insert, [data-diff-type="added"], [data-diff-type="insert"]) {
    background-color: var(--agy-diff-add-bg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .char-insert, .monaco-diff-editor .char-insert) {
    background-color: var(--agy-diff-add-word-bg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .line-delete, .monaco-diff-editor .cdr.line-delete, [data-diff-type="removed"], [data-diff-type="delete"]) {
    background-color: var(--agy-diff-del-bg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .char-delete, .monaco-diff-editor .char-delete) {
    background-color: var(--agy-diff-del-word-bg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .insert-sign, .monaco-diff-editor .insert-sign, [data-diff-type="added"], [data-diff-type="insert"]) {
    border-left: 2px solid var(--agy-diff-add-border) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .delete-sign, .monaco-diff-editor .delete-sign, [data-diff-type="removed"], [data-diff-type="delete"]) {
    border-left: 2px solid var(--agy-diff-del-border) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .insert-sign, .monaco-diff-editor .insert-sign) {
    color: var(--agy-diff-add-fg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is(.monaco-editor .delete-sign, .monaco-diff-editor .delete-sign) {
    color: var(--agy-diff-del-fg) !important;
}

html[data-agy-surface="light"] body[data-agy-theme] :is(.file-viewer-root, [data-testid="file-viewer"], .diff-view-mode-detail, [data-diff-type]) :is([class*="text-green-"], [class*="text-emerald-"]) {
    color: var(--agy-diff-add-fg) !important;
}

html[data-agy-surface="light"] body[data-agy-theme] :is(.file-viewer-root, [data-testid="file-viewer"], .diff-view-mode-detail, [data-diff-type]) :is([class*="text-red-"], [class*="text-rose-"]) {
    color: var(--agy-diff-del-fg) !important;
}

[aria-label="Sidebar"] [data-testid="conversation-list-sidebar"] .bg-sidebar,
[aria-label="Sidebar"] [data-testid="project-header"],
[aria-label="Sidebar"] [data-testid="section-header"],
[aria-label="Sidebar"] [data-testid="section-header"] > div {
    background-color: transparent !important;
}

[aria-label="Sidebar"] [data-testid="project-header"]:hover {
    background-color: var(--agy-hover-bg) !important;
    border-radius: var(--agy-radius-sm) !important;
}

[data-testid="conversation-list-sidebar"] > div > div[data-index="0"][style*="sticky"] {
    position: absolute !important;
    top: 0px !important;
    left: 0px !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) {
    border-radius: var(--agy-radius-sm) !important;
    border: 1px solid transparent !important;
    transition: background-color 0.14s ease, border-color 0.14s ease !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]):not([data-selected="true"]):hover {
    background-color: var(--agy-hover-bg) !important;
    box-shadow: none !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"])[data-selected="true"],
body[data-agy-theme].dark .agy-sidebar-row[data-selected="true"],
body[data-agy-theme].light .agy-sidebar-row[data-selected="true"] {
    background-color: rgba(var(--agy-accent-rgb), 0.20) !important;
    border-color: rgba(var(--agy-accent-rgb), 0.44) !important;
    color: var(--agy-on-tinted-accent) !important;
    box-shadow: none !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) :is(.agy-row-actions, .agy-row-shortcut-badge, .agy-status-overflow),
body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) :is(.agy-row-actions, .agy-row-shortcut-badge)::before {
    background: transparent !important;
    background-image: none !important;
    box-shadow: none !important;
    -webkit-mask-image: none !important;
    mask-image: none !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]):is(:hover, :focus-within, :has([data-state="open"]), :has([aria-expanded="true"])) > div:first-of-type {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 82px), transparent calc(100% - 58px)) !important;
    mask-image: linear-gradient(to right, #000 calc(100% - 82px), transparent calc(100% - 58px)) !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) .agy-row-actions button {
    background: transparent !important;
    border-radius: calc(var(--agy-radius-sm) * 0.75) !important;
    color: var(--agy-fg-muted) !important;
    box-shadow: none !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) .agy-row-actions button:hover {
    background: var(--agy-subtle-bg-strong) !important;
    color: var(--agy-fg) !important;
}

body[data-agy-theme].dark .agy-sidebar-raised,
body[data-agy-theme].light .agy-sidebar-raised,
body[data-agy-theme] .agy-sidebar-raised {
    border-radius: var(--agy-radius-sm) !important;
    background: rgba(var(--agy-accent-rgb), 0.20) !important;
    border: 1px solid rgba(var(--agy-accent-rgb), 0.44) !important;
    box-shadow: none !important;
    color: var(--agy-on-tinted-accent) !important;
}

body[data-agy-theme].dark .agy-sidebar-raised:hover,
body[data-agy-theme].light .agy-sidebar-raised:hover,
body[data-agy-theme] .agy-sidebar-raised:hover {
    background: rgba(var(--agy-accent-rgb), 0.28) !important;
    border-color: rgba(var(--agy-accent-rgb), 0.65) !important;
    box-shadow: none !important;
}

/* ===== 5. Composer, Voice Button, Send & Stop (Unified Radius, Zero Glow) ===== */
html[data-agy-theme-mode] body[data-agy-theme] .surface-composer,
body[data-agy-theme] .surface-composer,
body[data-agy-theme].dark .surface-composer,
body[data-agy-theme].light .surface-composer {
    border-radius: var(--agy-radius) !important;
    background-color: var(--agy-surface-composer) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border: 1px solid var(--agy-border) !important;
    box-shadow: var(--agy-shadow-card) !important;
    color: var(--agy-fg) !important;
    transition: border-color 0.16s ease !important;
}

html[data-agy-theme-mode] body[data-agy-theme] .surface-composer:focus-within,
body[data-agy-theme] .surface-composer:focus-within,
body[data-agy-theme].dark .surface-composer:focus-within,
body[data-agy-theme].light .surface-composer:focus-within {
    border-color: rgba(var(--agy-accent-rgb), 0.55) !important;
    box-shadow: var(--agy-shadow-card-focus) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] .surface-composer > .surface-composer-card,
body[data-agy-theme] .surface-composer > .surface-composer-card,
body[data-agy-theme].dark .surface-composer > .surface-composer-card,
body[data-agy-theme].light .surface-composer > .surface-composer-card {
    border-radius: var(--agy-radius) !important;
    background-color: transparent !important;
    color: var(--agy-fg) !important;
    box-shadow: none !important;
}

button[data-testid="send-button"],
.agy-send-button {
    border-radius: var(--agy-radius-sm) !important;
}

button[data-testid="send-button"]:not(:disabled),
.agy-send-button:not(:disabled) {
    border-radius: var(--agy-radius-sm) !important;
    background-color: rgb(var(--agy-accent-rgb)) !important;
    border: none !important;
    color: var(--agy-on-solid-accent) !important;
    box-shadow: none !important;
}

button[data-testid="send-button"]:not(:disabled) svg,
.agy-send-button:not(:disabled) svg {
    color: var(--agy-on-solid-accent) !important;
}

button[data-testid="send-button"]:not(:disabled):hover,
.agy-send-button:not(:disabled):hover {
    filter: brightness(1.06) !important;
}

[data-testid="voice-live-pill"]:not(.bg-red-600) {
    border-radius: var(--agy-radius-sm) !important;
    background: var(--agy-subtle-bg) !important;
    border: 1px solid var(--agy-border) !important;
    color: var(--agy-fg) !important;
    box-shadow: none !important;
}

[data-testid="voice-live-pill"]:not(.bg-red-600):hover {
    background: rgba(var(--agy-accent-rgb), 0.24) !important;
    border-color: rgba(var(--agy-accent-rgb), 0.55) !important;
}

[data-testid="voice-live-pill"]:not(.bg-red-600) svg,
[data-testid="voice-live-pill"]:not(.bg-red-600) svg * {
    color: var(--agy-fg) !important;
    fill: currentColor !important;
}

button[data-testid="input-cancel-button"] {
    border-radius: var(--agy-radius-sm) !important;
    background-color: var(--agy-surface-card) !important;
    border: 1px solid var(--agy-border-strong) !important;
    box-shadow: none !important;
}

button[data-testid="input-cancel-button"] > div {
    background-color: var(--agy-danger-fg, #ef4444) !important;
    width: 9px !important;
    height: 9px !important;
    border-radius: 2px !important;
    box-shadow: none !important;
}

html[data-agy-theme-mode] body[data-agy-theme] .agy-user-bubble,
body[data-agy-theme] .agy-user-bubble {
    border-radius: var(--agy-radius) !important;
    background-color: var(--agy-surface-card) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border: 1px solid var(--agy-border) !important;
    color: var(--agy-fg) !important;
    box-shadow: none !important;
}

/* ===== 6. Titlebar, Modals, Settings, Inputs (Consistent Transparency & Unified Radius) ===== */
[data-testid="title-menu-bar"],
.agy-titlebar:not([data-testid="title-menu-bar"] .agy-titlebar),
.tabs-and-actions-container:not([data-testid="title-menu-bar"] .tabs-and-actions-container) {
    position: relative !important;
    z-index: 8500 !important;
    background-color: var(--agy-surface-sidebar) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border-bottom: 1px solid var(--agy-divider) !important;
    color: var(--agy-fg) !important;
}
.agy-titlebar:has([data-testid="title-menu-bar"]),
[data-testid="title-menu-bar"] > div,
[data-testid="title-menu-bar"] .agy-titlebar,
[data-testid="title-menu-bar"] .tabs-and-actions-container,
.window-controls-container,
[class*="titlebar"]:not([data-testid="title-menu-bar"]):not(.agy-titlebar) {
    background-color: transparent !important;
    background-image: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}

/* Isolated glass backdrop layer via ::before on floating modal & dialog panels (prevents ancestor Chromium Backdrop Roots) */
html[data-agy-theme-mode] body[data-agy-theme] :is(
    .agy-dialog,
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-split-root="true"]:has([data-testid="settings-sidebar"]),
    [role="dialog"],
    [role="alertdialog"],
    [aria-modal="true"],
    [data-slot="dialog-content"],
    [data-slot="sheet-content"],
    [data-radix-dialog-content],
    [data-agy-surface-panel="modal"],
    [data-agy-surface-panel="drawer"],
    [data-testid*="drawer"]
) {
    --background: transparent !important;
    --color-background: transparent !important;
    --sidebar: var(--agy-nav-bg, var(--agy-subtle-bg)) !important;
    --color-sidebar: var(--agy-nav-bg, var(--agy-subtle-bg)) !important;
    --card: var(--agy-card-bg, var(--agy-subtle-bg)) !important;
    --color-card: var(--agy-card-bg, var(--agy-subtle-bg)) !important;
    --popover: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --color-popover: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --muted: var(--agy-subtle-bg) !important;
    --color-muted: var(--agy-subtle-bg) !important;
    --secondary: var(--agy-subtle-bg) !important;
    --color-secondary: var(--agy-subtle-bg) !important;
    --sidebar-secondary: rgba(var(--agy-accent-rgb), 0.22) !important;
    --color-sidebar-secondary: rgba(var(--agy-accent-rgb), 0.22) !important;
    --sidebar-muted: var(--agy-subtle-bg) !important;
    --color-sidebar-muted: var(--agy-subtle-bg) !important;
    background-color: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    isolation: isolate !important;
    border-color: var(--agy-border) !important;
    border-radius: var(--agy-radius) !important;
    box-shadow: var(--agy-shadow-panel) !important;
    color: var(--agy-fg) !important;
}
html[data-agy-theme-mode] body[data-agy-theme] :is(
    .agy-dialog,
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-split-root="true"]:has([data-testid="settings-sidebar"]),
    [role="dialog"],
    [role="alertdialog"],
    [aria-modal="true"],
    [data-slot="dialog-content"],
    [data-slot="sheet-content"],
    [data-radix-dialog-content],
    [data-agy-surface-panel="modal"],
    [data-agy-surface-panel="drawer"],
    [data-testid*="drawer"]
)::before {
    content: "" !important;
    position: absolute !important;
    inset: 0 !important;
    z-index: -1 !important;
    border-radius: inherit !important;
    pointer-events: none !important;
    background-color: var(--agy-surface-dialog, var(--agy-surface-modal)) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
}

/* Modal backdrop scrims must NOT create outer Chromium Backdrop Roots or apply dark blur over the whole app */
html[data-agy-theme-mode] body[data-agy-theme] :is(
    [data-slot="dialog-overlay"],
    [data-radix-dialog-overlay],
    [data-agy-modal-backdrop="1"]
) {
    background-color: var(--agy-backdrop-bg, rgba(4, 6, 10, 0.25)) !important;
    background-image: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    filter: none !important;
    opacity: 1 !important;
    border-color: transparent !important;
    border-radius: 0 !important;
    box-shadow: none !important;
}

/* Runtime-cleared Chromium Backdrop Roots & static->relative position helpers */
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-clear-bd-root="1"] {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    filter: none !important;
    opacity: 1 !important;
    clip-path: none !important;
    mask-image: none !important;
    -webkit-mask-image: none !important;
    mix-blend-mode: normal !important;
    will-change: auto !important;
}
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-pos-rel="1"] {
    position: relative !important;
}

/* Wrapper occluders / Radix positioners / outer blur utility divs that contain an inner frosted panel stay transparent with no Backdrop Root */
html[data-agy-theme-mode] body[data-agy-theme] [data-radix-popper-content-wrapper],
html[data-agy-theme-mode] body[data-agy-theme] [data-radix-portal],
html[data-agy-theme-mode] body[data-agy-theme] [data-browser-occluder="true"]:has([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-slot*="content"], [data-agy-surface-panel]) {
    background-color: transparent !important;
    background-image: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    filter: none !important;
    border-color: transparent !important;
    box-shadow: none !important;
}

/* Radix menus, submenus, hovercards, and popovers use isolated ::before glass so nested submenus/hovercards blur cleanly */
html[data-agy-theme-mode] body[data-agy-theme] :is(
    [role="menu"],
    [role="listbox"],
    [role="tooltip"],
    [data-radix-menu-content],
    [data-radix-popper-content-wrapper] > *,
    [data-slot="popover-content"],
    [data-slot="hover-card-content"],
    [data-slot="dropdown-menu-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="context-menu-content"],
    [data-slot="select-content"],
    [data-slot="tooltip-content"],
    [data-slot="combobox-content"],
    [data-radix-popover-content],
    [data-radix-hover-card-content],
    [data-radix-select-content],
    [data-agy-surface-panel="popover"],
    [data-agy-surface-panel="launcher"]
) {
    --background: transparent !important;
    --color-background: transparent !important;
    --popover: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --color-popover: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    --card: var(--agy-card-bg, var(--agy-subtle-bg)) !important;
    --color-card: var(--agy-card-bg, var(--agy-subtle-bg)) !important;
    --muted: var(--agy-subtle-bg) !important;
    --color-muted: var(--agy-subtle-bg) !important;
    --secondary: var(--agy-subtle-bg) !important;
    --color-secondary: var(--agy-subtle-bg) !important;
    background-color: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    isolation: isolate !important;
    border-color: var(--agy-border) !important;
    border-radius: var(--agy-radius) !important;
    box-shadow: var(--agy-shadow-card) !important;
    color: var(--agy-fg) !important;
}
html[data-agy-theme-mode] body[data-agy-theme] :is(
    [role="menu"],
    [role="listbox"],
    [role="tooltip"],
    [data-radix-menu-content],
    [data-radix-popper-content-wrapper] > *,
    [data-slot="popover-content"],
    [data-slot="hover-card-content"],
    [data-slot="dropdown-menu-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="context-menu-content"],
    [data-slot="select-content"],
    [data-slot="tooltip-content"],
    [data-slot="combobox-content"],
    [data-radix-popover-content],
    [data-radix-hover-card-content],
    [data-radix-select-content],
    [data-agy-surface-panel="popover"],
    [data-agy-surface-panel="launcher"]
)::before {
    content: "" !important;
    position: absolute !important;
    inset: 0 !important;
    z-index: -1 !important;
    border-radius: inherit !important;
    pointer-events: none !important;
    background-color: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
}

/* Standalone floating overlays, VS Code widgets, and non-nested glass/occluder popovers */
html[data-agy-theme-mode] body[data-agy-theme] :is(
    .surface-glass,
    .surface-opaque,
    .agy-overlay,
    .agy-takeover-card,
    .agy-selection-pill,
    [data-browser-occluder="true"],
    .bg-popover,
    .compact-tooltip,
    .agy-toast,
    .agy-tip-card,
    .monaco-hover,
    .suggest-widget,
    .monaco-menu,
    [cmdk-dialog],
    [cmdk-root],
    [data-slot="command"],
    .quick-input-widget
):not([role="dialog"]):not([role="alertdialog"]):not([aria-modal="true"]):not(.settings-modal-container):not([data-testid="settings-modal"]):not([role="menu"]):not([role="listbox"]):not([role="tooltip"]):not([data-radix-menu-content]):not([data-slot="popover-content"]):not([data-slot="hover-card-content"]):not([data-slot="dropdown-menu-content"]):not([data-slot="dropdown-menu-sub-content"]):not([data-slot="context-menu-content"]):not([data-slot="select-content"]):not([data-slot="tooltip-content"]):not([data-radix-popper-content-wrapper] > *):not([data-agy-surface-panel]) {
    background-color: var(--agy-surface-popover, var(--agy-surface-modal)) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

/* Quick-launcher framing & item legibility over bright wallpapers */
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-surface-panel="launcher"] {
    border: 1px solid var(--agy-border) !important;
    border-radius: var(--agy-radius) !important;
    box-shadow: var(--agy-shadow-panel) !important;
    padding: 10px !important;
}
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-surface-panel="launcher"] :is(button, a, [role="option"], [cmdk-item], span, div) {
    color: var(--agy-fg) !important;
}
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-surface-panel="launcher"] :is([aria-disabled="true"], [data-disabled="true"], .opacity-50, .opacity-40) {
    opacity: 0.78 !important;
    color: var(--agy-fg-muted) !important;
}

/* Single glass layer invariant: never double-stack inner backgrounds on wrappers while PRESERVING nested popovers/submenus/hovercards */
html[data-agy-theme-mode] body[data-agy-theme] :is(
    [role="dialog"],
    [role="alertdialog"],
    [aria-modal="true"],
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-slot="dialog-content"],
    [data-slot="sheet-content"],
    [data-radix-dialog-content],
    [data-radix-popper-content-wrapper] > *,
    [role="menu"],
    [role="listbox"],
    [data-agy-surface-panel]
) :is(
    .surface-glass,
    .surface-opaque,
    [data-browser-occluder="true"],
    [data-split-root="true"],
    [data-main-content-body],
    [class*="backdrop-blur"],
    .bg-background,
    .bg-popover
):not([role="menu"]):not([role="listbox"]):not([role="tooltip"]):not([role="dialog"]):not([role="alertdialog"]):not([aria-modal="true"]):not([data-slot="dropdown-menu-sub-content"]):not([data-slot="dropdown-menu-content"]):not([data-slot="hover-card-content"]):not([data-slot="popover-content"]):not([data-slot="select-content"]):not([data-slot="context-menu-content"]):not([data-slot="tooltip-content"]):not([data-slot="combobox-content"]):not([data-radix-menu-content]):not([data-radix-popover-content]):not([data-radix-hover-card-content]):not([data-radix-select-content]):not([data-agy-surface-panel]),
html[data-agy-theme-mode] body[data-agy-theme] :is(
    .settings-modal-container [role="dialog"],
    [role="dialog"] .settings-modal-container,
    [data-testid="settings-modal"] [role="dialog"],
    [role="dialog"] [data-testid="settings-modal"],
    [data-agy-surface-panel="modal"] :is([role="dialog"], [role="alertdialog"], .settings-modal-container, [data-testid="settings-modal"])
),
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-panel-inner-clear="1"] {
    background-color: transparent !important;
    background-image: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    box-shadow: none !important;
}
html[data-agy-theme-mode] body[data-agy-theme] :is(
    .settings-modal-container [role="dialog"],
    [role="dialog"] .settings-modal-container,
    [data-testid="settings-modal"] [role="dialog"],
    [role="dialog"] [data-testid="settings-modal"],
    [data-agy-surface-panel="modal"] :is([role="dialog"], [role="alertdialog"], .settings-modal-container, [data-testid="settings-modal"])
)::before {
    content: none !important;
    display: none !important;
}

/* Sticky panel headers ONLY when explicitly tagged on scrollable Settings headers (never split compact confirm dialog headers from body) */
html[data-agy-theme-mode] body[data-agy-theme] [data-agy-sticky-header="1"] {
    background-color: var(--agy-surface-sticky, var(--agy-surface-dialog, var(--agy-surface-modal))) !important;
    background-image: none !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border-bottom: 1px solid var(--agy-divider) !important;
    color: var(--agy-fg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] :is([role="dialog"], [role="alertdialog"], .settings-modal-container, [data-testid="settings-modal"], [data-agy-surface-panel="modal"]) :is(.bg-card, [data-agy-panel-card-clear="1"]) {
    background-color: var(--agy-card-bg, var(--agy-subtle-bg)) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border-color: var(--agy-border) !important;
    box-shadow: none !important;
}

[data-testid="settings-sidebar"] {
    background-color: var(--agy-surface-sidebar) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border-right: 1px solid var(--agy-divider) !important;
    color: var(--agy-fg) !important;
}

:is([role="dialog"], .settings-modal-container, [data-testid="settings-modal"], [data-agy-surface-panel="modal"]) [data-testid="settings-sidebar"] {
    background-color: var(--agy-nav-bg, var(--agy-subtle-bg)) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}

[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"]:not(.bg-sidebar-secondary):not([aria-selected="true"]):not([aria-current="page"]):not([data-active="true"]):not([data-state="active"]) {
    background-color: transparent !important;
    border-color: transparent !important;
    color: var(--agy-fg) !important;
}

[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"]:is(.bg-sidebar-secondary, [aria-selected="true"], [aria-current="page"], [data-active="true"], [data-state="active"]) {
    background-color: rgba(var(--agy-accent-rgb), 0.22) !important;
    border: 1px solid rgba(var(--agy-accent-rgb), 0.45) !important;
    border-radius: var(--agy-radius-sm) !important;
    box-shadow: none !important;
    color: var(--agy-on-tinted-accent) !important;
}

[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"]:not(.bg-sidebar-secondary):not([aria-selected="true"]):not([aria-current="page"]):not([data-active="true"]):not([data-state="active"]):hover {
    background-color: var(--agy-hover-bg) !important;
    border-radius: var(--agy-radius-sm) !important;
}

/* High-contrast borders & dividers reinforcement across panels, cards, settings, editors, and inputs */
html[data-agy-contrast="high"] body[data-agy-theme] :is(
    [aria-label="Sidebar"],
    [data-testid="settings-sidebar"],
    .surface-composer,
    .agy-user-bubble,
    .bg-card,
    .surface-glass,
    .surface-opaque,
    .file-viewer-root,
    [data-testid="file-viewer"],
    .diff-view-mode-detail,
    .monaco-editor,
    .monaco-diff-editor,
    .code-block,
    .prose pre,
    [role="dialog"],
    [role="menu"],
    [role="listbox"],
    [role="tooltip"],
    [data-slot="toggle-group"],
    .agy-button.bg-secondary,
    .agy-select-trigger,
    input.bg-background,
    textarea.bg-background,
    select.bg-background
) {
    border-color: var(--agy-border-strong) !important;
}

html[data-agy-contrast="high"] body[data-agy-theme] :is(hr, [role="separator"], .border-b, .border-t, .border-r, .border-l, .divide-y > *) {
    border-color: var(--agy-divider) !important;
}

html[data-agy-contrast="high"] body[data-agy-theme] :is(input, textarea)::placeholder {
    color: var(--agy-fg-muted) !important;
    opacity: 1 !important;
}

html[data-agy-contrast="high"] body[data-agy-theme] [role="switch"] {
    border: 1px solid var(--agy-border-strong) !important;
}

html[data-agy-contrast="high"] body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"])[data-selected="true"] {
    border-color: var(--agy-border-strong) !important;
}

html[data-agy-contrast="high"] body[data-agy-theme] :is(button, a, input, select, textarea, [tabindex], [role="button"], [role="switch"]):focus-visible {
    outline: 2px solid rgba(var(--agy-accent-rgb), 0.90) !important;
    outline-offset: 1px !important;
}

html[data-agy-contrast="high"] body[data-agy-theme] :disabled,
html[data-agy-contrast="high"] body[data-agy-theme] [aria-disabled="true"] {
    opacity: 0.65 !important;
}

/* Performance mode & opaque (>=96%) blur-skip: remove heavy GPU backdrop-filter over live video (panelAlpha continues to control all surfaces identically) */
html:is([data-agy-no-blur="1"], [data-agy-blur-skip="1"]) :is(
    [data-testid="title-menu-bar"],
    .agy-titlebar,
    .tabs-and-actions-container,
    [data-agy-editor-pane="1"],
    [data-testid="diff-gutter-strip"],
    [data-file-uri]:not([data-main-content-body] [data-file-uri]),
    [data-testid*="review-panel"],
    [data-testid*="changes-panel"],
    [data-testid*="diff-viewer"],
    [class*="diff-viewer"],
    .breadcrumbs-below-tabs,
    .breadcrumbs-control,
    .monaco-breadcrumbs,
    .editor-group-container > .title,
    [aria-label="Sidebar"],
    [data-testid="settings-sidebar"],
    .surface-composer,
    .agy-user-bubble,
    .code-block,
    .prose pre,
    .file-viewer-root,
    [data-testid="file-viewer"],
    .diff-view-mode-detail,
    .monaco-diff-editor,
    .monaco-editor,
    .cm-editor,
    .bg-card,
    .group\\/terminal-card,
    .group\\/run-command,
    .agy-select-trigger,
    [data-testid="tab-file-tree-sidebar"],
    [data-testid="terminals-and-tasks-sidebar"],
    [data-testid="subagent-tab-sidebar"],
    [data-testid="bottom-terminal-panel"],
    [data-testid="bottom-terminal-panel-sidebar"],
    [data-testid*="drawer"],
    [data-testid*="browser-toolbar"],
    [data-testid*="address-bar"],
    [data-testid*="url-bar"],
    .surface-glass,
    .surface-opaque,
    .agy-dialog,
    .settings-modal-container,
    .settings-modal-container :is(header, [data-agy-sticky-header="1"], [data-testid="settings-sidebar"], .bg-card),
    [data-testid="settings-modal"],
    .agy-overlay,
    .agy-takeover-card,
    .agy-selection-pill,
    .compact-tooltip,
    .agy-toast,
    .agy-tip-card,
    [data-browser-occluder="true"],
    [role="dialog"],
    [role="alertdialog"],
    [aria-modal="true"],
    [data-slot="dialog-content"],
    [data-slot="sheet-content"],
    [data-radix-dialog-content],
    [role="menu"],
    [role="listbox"],
    [role="tooltip"],
    #agy-ctx-pop,
    #agy-acc-side-popover,
    [data-radix-popper-content-wrapper] > *,
    [data-radix-menu-content],
    [data-slot="popover-content"],
    [data-slot="hover-card-content"],
    [data-slot="dropdown-menu-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="context-menu-content"],
    [data-slot="select-content"],
    [data-slot="tooltip-content"],
    [data-slot="combobox-content"],
    [data-radix-popover-content],
    [data-radix-hover-card-content],
    [data-radix-select-content],
    .bg-popover,
    .monaco-hover,
    .suggest-widget,
    .monaco-menu,
    [cmdk-dialog],
    [cmdk-root],
    [data-slot="command"],
    .quick-input-widget,
    [data-agy-surface-panel],
    [data-agy-sticky-header="1"],
    [class*="backdrop-blur"]
),
html:is([data-agy-no-blur="1"], [data-agy-blur-skip="1"]) body[data-agy-theme] :is(
    .agy-dialog,
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-split-root="true"]:has([data-testid="settings-sidebar"]),
    [role="dialog"],
    [role="alertdialog"],
    [aria-modal="true"],
    [data-slot="dialog-content"],
    [data-slot="sheet-content"],
    [data-radix-dialog-content],
    [data-agy-surface-panel],
    [data-testid*="drawer"],
    [role="menu"],
    [role="listbox"],
    [role="tooltip"],
    [data-radix-menu-content],
    [data-radix-popper-content-wrapper] > *,
    [data-slot="popover-content"],
    [data-slot="hover-card-content"],
    [data-slot="dropdown-menu-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="context-menu-content"],
    [data-slot="select-content"],
    [data-slot="tooltip-content"],
    [data-slot="combobox-content"],
    [data-radix-popover-content],
    [data-radix-hover-card-content],
    [data-radix-select-content]
)::before {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}

[data-testid^="mode-option-"] {
    border-radius: var(--agy-radius) !important;
}
[data-testid^="mode-option-"].border-primary {
    border-color: rgba(var(--agy-accent-rgb), 0.65) !important;
    background-color: rgba(var(--agy-accent-rgb), 0.16) !important;
    box-shadow: none !important;
}

body[data-agy-theme] [data-slot="toggle-group"],
body[data-agy-theme].dark [data-slot="toggle-group"],
body[data-agy-theme].light [data-slot="toggle-group"] {
    background-color: var(--agy-subtle-bg) !important;
    border: 1px solid var(--agy-border) !important;
    border-radius: var(--agy-radius-sm) !important;
    padding: 2px !important;
}

body[data-agy-theme] [data-slot="toggle-group"] > :is(button, [data-pressed])[data-pressed],
body[data-agy-theme].dark [data-slot="toggle-group"] > :is(button, [data-pressed])[data-pressed],
body[data-agy-theme].light [data-slot="toggle-group"] > :is(button, [data-pressed])[data-pressed],
body[data-agy-theme] [data-slot="toggle-group"] > button[aria-pressed="true"] {
    background-color: rgba(var(--agy-accent-rgb), 0.24) !important;
    border: 1px solid rgba(var(--agy-accent-rgb), 0.50) !important;
    border-radius: calc(var(--agy-radius-sm) * 0.8) !important;
    color: var(--agy-on-tinted-accent) !important;
    box-shadow: none !important;
}

body[data-agy-theme] .agy-button.bg-secondary {
    background-color: var(--agy-subtle-bg) !important;
    border: 1px solid var(--agy-border) !important;
    border-radius: var(--agy-radius-sm) !important;
    color: var(--agy-fg) !important;
}

body[data-agy-theme] .agy-button.bg-secondary:hover {
    background-color: var(--agy-subtle-bg-strong) !important;
    border-color: var(--agy-border-strong) !important;
}

body[data-agy-theme] [role="switch"][aria-checked="true"],
body[data-agy-theme] [role="switch"][data-checked] {
    background-color: rgb(var(--agy-accent-rgb)) !important;
    border-color: rgb(var(--agy-accent-rgb)) !important;
}

[data-testid="tab-file-tree-sidebar"],
[data-testid="terminals-and-tasks-sidebar"],
[data-testid="subagent-tab-sidebar"],
[data-testid="bottom-terminal-panel"],
[data-testid="bottom-terminal-panel-sidebar"],
[data-testid*="drawer"],
[data-testid*="browser-toolbar"],
[data-testid*="address-bar"],
[data-testid*="url-bar"] {
    background-color: var(--agy-surface-sidebar) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    color: var(--agy-fg) !important;
}

html[data-agy-theme-mode] body[data-agy-theme] .bg-card:not([role="dialog"] .bg-card):not(.settings-modal-container .bg-card):not([data-testid="settings-modal"] .bg-card):not([data-agy-surface-panel="modal"] .bg-card):not(.surface-composer .bg-card):not(.bg-card .bg-card) {
    background-color: var(--agy-surface-card) !important;
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

.group\\/terminal-card,
.group\\/run-command,
.agy-select-trigger {
    backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
    -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;
}

.group\\/terminal-card,
.group\\/run-command,
.agy-select-trigger,
input.bg-background,
textarea.bg-background,
select.bg-background {
    border-radius: var(--agy-radius-sm) !important;
    background-color: var(--agy-surface-card) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

/* Unified user border-radius across pill CTA buttons, open file tabs, dialog controls, menus, and tooltips */
body[data-agy-theme] :is(button, a, div, [role="tab"]).rounded-full:not([role="switch"]):not([class*="size-"]):not([class*="w-5"]):not([class*="w-6"]):not([class*="w-7"]):not([class*="w-8"]):not([class*="h-5"]):not([class*="h-6"]):not([class*="h-7"]):not([class*="animate-"]),
body[data-agy-theme] :is([role="tab"], .tab, [data-testid*="tab"]):not([role="switch"]),
body[data-agy-theme] [role="dialog"] button:not([role="switch"]):not([class*="size-"]),
body[data-agy-theme] [role="dialog"] input,
body[data-agy-theme] [role="tooltip"],
body[data-agy-theme] .agy-button {
    border-radius: var(--agy-radius-sm) !important;
}

/* Remove extra background pills behind breadcrumbs / chat path segments */
body[data-agy-theme] :is(.breadcrumbs-below-tabs, .breadcrumbs-control, .monaco-breadcrumbs, [data-testid*="breadcrumb"]) :is(a, button, span, div):not(:hover) {
    background-color: transparent !important;
    background-image: none !important;
    box-shadow: none !important;
}
body[data-agy-theme] :is(.breadcrumbs-below-tabs, .breadcrumbs-control, .monaco-breadcrumbs, [data-testid*="breadcrumb"]) :is(a, button):hover {
    background-color: var(--agy-hover-bg) !important;
}

/* Keep animated chat activity dots/spinners bright in dark theme and dark in light theme */
body[data-agy-theme] :is([class*="animate-pulse"], [class*="animate-bounce"], [class*="animate-ping"], [class*="animate-spin"]) {
    color: var(--agy-fg) !important;
}
body[data-agy-theme] :is([class*="animate-pulse"], [class*="animate-bounce"], [class*="animate-ping"]) :is(span, div)[class*="rounded-full"][class*="bg-"] {
    background-color: var(--agy-fg) !important;
}

body[data-agy-theme] [role="dialog"],
body[data-agy-theme] [role="menu"],
body[data-agy-theme] [data-radix-popper-content-wrapper] > div {
    border-radius: var(--agy-radius) !important;
}

/* Prevent CSS transform/opacity enter animations (e.g. Tailwind animate-in fade-in/zoom-in) from creating Chromium compositor Backdrop Roots on frame 0 */
html[data-agy-theme-mode] body[data-agy-theme] :is(
    [role="dialog"],
    [role="alertdialog"],
    [aria-modal="true"],
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-slot="dialog-content"],
    [data-slot="sheet-content"],
    [data-radix-dialog-content],
    [role="menu"],
    [role="listbox"],
    [role="tooltip"],
    [data-radix-menu-content],
    [data-radix-popper-content-wrapper],
    [data-radix-popper-content-wrapper] > *,
    [data-slot="popover-content"],
    [data-slot="hover-card-content"],
    [data-slot="dropdown-menu-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="context-menu-content"],
    [data-slot="select-content"],
    [data-slot="tooltip-content"],
    [data-agy-surface-panel]
) {
    animation: none !important;
}

/* Neutralize dark hardcoded Tailwind/badge/pill backgrounds when Light theme overrides Dark native Antigravity */
html[data-agy-surface="light"] body[data-agy-theme] :is(
    [class*="bg-black"],
    [class*="bg-[#0"], [class*="bg-[#1"], [class*="bg-[#2"], [class*="bg-[#3"],
    [class*="bg-[rgb"], [class*="bg-[hsl"], [class*="bg-[oklch"], [class*="bg-[color"],
    [class*="bg-ide-"], [class*="bg-onyx-"], [class*="bg-nux-"], [class*="bg-surface"],
    [class*="bg-panel"], [class*="bg-header"], [class*="bg-modal"], [class*="bg-vscode-"],
    [class*="bg-zinc-7"], [class*="bg-zinc-8"], [class*="bg-zinc-9"],
    [class*="bg-neutral-7"], [class*="bg-neutral-8"], [class*="bg-neutral-9"],
    [class*="bg-slate-7"], [class*="bg-slate-8"], [class*="bg-slate-9"],
    [class*="bg-gray-7"], [class*="bg-gray-8"], [class*="bg-gray-9"],
    [class*="bg-stone-7"], [class*="bg-stone-8"], [class*="bg-stone-9"],
    [class*="dark:bg-"]
):not([data-testid="send-button"]):not(.agy-send-button):not([role="switch"]):not([data-testid="voice-live-pill"]):not(.agy-sidebar-raised):not(.agy-user-bubble):not(.bg-red-600):not(.bg-primary):not([data-diff-type]):not([data-diff-type] *):not(.monaco-editor *):not(.cm-editor *):not(#agy-wallpaper-layer *) {
    background-color: var(--agy-surface-card) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

/* Neutralize hardcoded opaque light/white Tailwind fills inside Light Settings, modals, menus, cards so 0%..100% density works identically to Dark mode */
html[data-agy-surface="light"] body[data-agy-theme] :is(
    [role="dialog"],
    [role="alertdialog"],
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-agy-surface-panel="modal"],
    [role="menu"],
    [role="listbox"],
    [data-slot="hover-card-content"],
    [data-slot="popover-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="dropdown-menu-content"],
    [aria-label="Sidebar"],
    [data-agy-surface-panel="launcher"]
) :is(
    [class*="bg-white"],
    [class*="bg-slate-"],
    [class*="bg-zinc-"],
    [class*="bg-neutral-"],
    [class*="bg-gray-"],
    [class*="bg-stone-"],
    [class*="bg-[#fff"], [class*="bg-[#f"], [class*="bg-[#e"],
    [class*="light:bg-"]
):not([data-testid="send-button"]):not(.agy-send-button):not([role="switch"]):not(.bg-red-600):not(.bg-primary):not([data-diff-type]):not(.monaco-editor *):not(.cm-editor *):not(#agy-wallpaper-layer *):not([data-agy-panel-inner-clear="1"]):not([data-agy-sticky-header="1"]) {
    background-color: var(--agy-card-bg) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}
html[data-agy-surface="light"] body[data-agy-theme] :is(
    [role="dialog"],
    [role="alertdialog"],
    .settings-modal-container,
    [data-testid="settings-modal"],
    [data-agy-surface-panel="modal"]
) [data-agy-panel-inner-clear="1"] {
    background-color: transparent !important;
    background-image: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    box-shadow: none !important;
}

/* Neutralize inverted light/white Tailwind/badge/pill backgrounds in Dark theme */
html[data-agy-surface="dark"] body[data-agy-theme] :is(
    [class*="bg-white"],
    [class*="bg-zinc-50"], [class*="bg-zinc-1"], [class*="bg-zinc-2"], [class*="bg-zinc-3"],
    [class*="bg-neutral-50"], [class*="bg-neutral-1"], [class*="bg-neutral-2"], [class*="bg-neutral-3"],
    [class*="bg-slate-50"], [class*="bg-slate-1"], [class*="bg-slate-2"], [class*="bg-slate-3"],
    [class*="bg-gray-50"], [class*="bg-gray-1"], [class*="bg-gray-2"], [class*="bg-gray-3"],
    [class*="bg-stone-50"], [class*="bg-stone-1"], [class*="bg-stone-2"], [class*="bg-stone-3"]
):not([data-testid="send-button"]):not(.agy-send-button):not([role="switch"]):not([data-testid="voice-live-pill"]):not(.agy-sidebar-raised):not(.agy-user-bubble):not(.bg-red-600):not([class*="animate-"]):not([class*="animate-"] *):not([data-diff-type]):not([data-diff-type] *):not(.monaco-editor *):not(.cm-editor *):not(#agy-wallpaper-layer *) {
    background-color: var(--agy-surface-card) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

/* Shared Light+Dark neutralization for inverted foreground-alpha fills (deduplicated) */
html[data-agy-surface] body[data-agy-theme] :is(
    [class*="bg-foreground/"], [class*="bg-card-foreground"], [class*="bg-secondary-foreground"], [class*="bg-muted-foreground"], [class*="bg-popover-foreground"], [class*="bg-sidebar-foreground"], [class*="bg-primary-foreground"], [class*="bg-current"], [class*="bg-ide-foreground"], [class*="bg-ide-text"]
):not([data-testid="send-button"]):not(.agy-send-button):not([role="switch"]):not([data-testid="voice-live-pill"]):not(.agy-sidebar-raised):not(.agy-user-bubble):not(.bg-red-600):not([class*="animate-"]):not([class*="animate-"] *):not([data-diff-type]):not([data-diff-type] *):not(.monaco-editor *):not(.cm-editor *):not(#agy-wallpaper-layer *) {
    background-color: var(--agy-surface-card) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

html[data-agy-surface] body[data-agy-theme] :is(
    [class*="bg-black"], [class*="bg-white"], [class*="bg-foreground/"]
) > :is(span, div, button)[class*="bg-"]:not([data-testid="send-button"]):not(.agy-send-button):not([role="switch"]):not(.bg-red-600):not([data-diff-type]) {
    background-color: var(--agy-subtle-bg) !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

html:is([data-agy-surface="light"], [data-agy-surface="dark"]) body[data-agy-theme] [data-agy-light-fix="1"] {
    background-color: var(--agy-surface-card) !important;
    background-image: none !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

html:is([data-agy-surface="light"], [data-agy-surface="dark"]) body[data-agy-theme] [data-agy-light-fix="2"] {
    background-color: var(--agy-subtle-bg) !important;
    background-image: none !important;
    border-color: var(--agy-border) !important;
    color: var(--agy-fg) !important;
}

html:is([data-agy-surface="light"], [data-agy-surface="dark"]) body[data-agy-theme] :is([data-agy-light-fix="1"], [data-agy-light-fix="2"]) :is(span, div, p, svg, button):not([data-diff-type]):not([class*="text-green"]):not([class*="text-red"]):not([class*="text-emerald"]):not([class*="text-rose"]):not([class*="text-amber"]):not([class*="text-blue"]):not([class*="text-sky"]) {
    color: var(--agy-fg) !important;
}

/* Controlled spoiler privacy for personal data (emails, account identifiers, sensitive paths) */
html[data-agy-privacy="1"] [data-agy-spoiler="1"] {
    filter: blur(5px) !important;
    opacity: 0.82 !important;
    transition: filter 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease !important;
    user-select: none !important;
}

html[data-agy-privacy="1"][data-agy-privacy-style="mask"] [data-agy-spoiler="1"] {
    filter: none !important;
    opacity: 1 !important;
}

html[data-agy-privacy="1"][data-agy-privacy-style="mask"] [data-agy-privacy-masked="1"] {
    letter-spacing: 0.02em;
}

html[data-agy-privacy="1"][data-agy-privacy-reveal="never"] [data-agy-spoiler="1"] {
    cursor: default !important;
}

html[data-agy-privacy="1"][data-agy-privacy-reveal="modifier"] [data-agy-spoiler="1"] {
    cursor: help;
}

html[data-agy-privacy="1"][data-agy-privacy-reveal="modifier"][data-agy-mod-held="1"]:not([data-agy-privacy-style="mask"]) [data-agy-spoiler="1"]:hover,
html[data-agy-privacy="1"][data-agy-privacy-reveal="modifier"][data-agy-mod-held="1"]:not([data-agy-privacy-style="mask"]) [data-agy-spoiler="1"]:focus-visible {
    filter: none !important;
    opacity: 1 !important;
}

html[data-agy-privacy="1"][data-agy-privacy-reveal="hover"] [data-agy-spoiler="1"] {
    cursor: pointer;
}

html[data-agy-privacy="1"][data-agy-privacy-reveal="hover"]:not([data-agy-privacy-style="mask"]) [data-agy-spoiler="1"]:hover {
    filter: none !important;
    opacity: 1 !important;
}
`;
}

function buildInjectedJs(profile, theme, port, token = "") {
    const contrastHelpers = serializeContrastHelpers();

    const tokenQs = token ? `?t=${encodeURIComponent(token)}` : "";
    let initialMedia = null;
    let initialPrivacy = false;
    let initialPrivacyReveal = "modifier";
    let initialPrivacyStyle = "blur";
    let initialPrivacyPaths = true;
    let initialThemeMode = "dark";
    let initialUiContrast = "default";
    let initialNoBlur = true;
    let initialWallpaperEnabled = true;
    let initialCustomFonts = [];
    let initialConfig = {};
    try {
        const cfg = readAppearanceConfig();
        initialConfig = sanitizeAppearanceConfig(cfg);
        initialPrivacy = Boolean(initialConfig.privacyMode);
        if (initialConfig.privacyRevealMode) initialPrivacyReveal = initialConfig.privacyRevealMode;
        if (initialConfig.privacyHideStyle) initialPrivacyStyle = initialConfig.privacyHideStyle;
        if (typeof initialConfig.privacyHidePaths === "boolean") initialPrivacyPaths = initialConfig.privacyHidePaths;
        if (initialConfig.themeMode) initialThemeMode = initialConfig.themeMode;
        if (initialConfig.uiContrast) initialUiContrast = initialConfig.uiContrast;
        if (typeof initialConfig.reduceBackdropBlur === "boolean") initialNoBlur = initialConfig.reduceBackdropBlur;
        if (typeof initialConfig.wallpaperEnabled === "boolean") initialWallpaperEnabled = initialConfig.wallpaperEnabled;
        initialCustomFonts = scanCustomFonts();
        const items = initialWallpaperEnabled ? scanWallpapers(false) : [];
        if (Array.isArray(items) && items.length > 0) {
            let pick = cfg.currentId ? items.find((v) => v.id === cfg.currentId) : null;
            if (!pick && Number.isInteger(cfg.currentIndex) && items[cfg.currentIndex]) pick = items[cfg.currentIndex];
            if (!pick) pick = items[0];
            if (pick) {
                initialMedia = {
                    id: pick.id,
                    index: pick.index,
                    kind: pick.kind || "video",
                    src: `http://127.0.0.1:${Number(port)}/stream/${pick.index}${tokenQs}`,
                };
            }
        }
    } catch {}

    return `(() => {
    const INITIAL_PRIVACY = ${JSON.stringify(initialPrivacy)};
    const INITIAL_PRIVACY_REVEAL = ${JSON.stringify(initialPrivacyReveal)};
    const INITIAL_PRIVACY_STYLE = ${JSON.stringify(initialPrivacyStyle)};
    const INITIAL_PRIVACY_PATHS = ${JSON.stringify(initialPrivacyPaths)};
    const INITIAL_THEME_MODE = ${JSON.stringify(initialThemeMode)};
    const INITIAL_UI_CONTRAST = ${JSON.stringify(initialUiContrast)};
    const INITIAL_NO_BLUR = ${JSON.stringify(initialNoBlur)};
    const INITIAL_WALLPAPER_ENABLED = ${JSON.stringify(initialWallpaperEnabled)};
    const INITIAL_CUSTOM_FONTS = ${JSON.stringify(initialCustomFonts)};
    const INITIAL_CONFIG = ${JSON.stringify(initialConfig)};
    if (document.documentElement) {
        const initMode = INITIAL_THEME_MODE === "light" ? "light" : "dark";
        document.documentElement.dataset.agyPrivacy = INITIAL_PRIVACY ? "1" : "0";
        document.documentElement.dataset.agyPrivacyReveal = INITIAL_PRIVACY_REVEAL;
        document.documentElement.dataset.agyPrivacyStyle = INITIAL_PRIVACY_STYLE;
        document.documentElement.dataset.agyPrivacyPaths = INITIAL_PRIVACY_PATHS ? "1" : "0";
        document.documentElement.dataset.agyThemeMode = initMode;
        document.documentElement.dataset.agySurface = initMode;
        document.documentElement.dataset.agyContrast = INITIAL_UI_CONTRAST === "high" ? "high" : "default";
        if (INITIAL_NO_BLUR) document.documentElement.dataset.agyNoBlur = "1";
        if (!INITIAL_WALLPAPER_ENABLED) document.documentElement.dataset.agyPlainBg = "1";
    }
    if (window.__agyWallpaperInitialized) return;
    window.__agyWallpaperInitialized = true;

    const BASE_THEME = ${JSON.stringify(theme)};
    const INITIAL_MEDIA = ${JSON.stringify(initialMedia)};
    const LIGHT_DEFAULT_TINT_RGB = ${JSON.stringify(LIGHT_DEFAULT_TINT_RGB)};
    const LIGHT_DEFAULT_BG_HEX = ${JSON.stringify(LIGHT_DEFAULT_BG_HEX)};
    const DARK_DEFAULT_BG_HEX = ${JSON.stringify(DARK_DEFAULT_BG_HEX)};
    const LIGHT_DEFAULT_TEXT_HEX = ${JSON.stringify(LIGHT_DEFAULT_TEXT_HEX)};
    const DARK_DEFAULT_TEXT_HEX = ${JSON.stringify(DARK_DEFAULT_TEXT_HEX)};
    const LIGHT_DEFAULT_ACCENT_HEX = ${JSON.stringify(LIGHT_DEFAULT_ACCENT_HEX)};
    const DARK_DEFAULT_ACCENT_HEX = ${JSON.stringify(DARK_DEFAULT_ACCENT_HEX)};
    const BUILTIN_FONTS = [
        { label: "Segoe UI Variable", cssValue: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif", preview: "'Segoe UI Variable','Segoe UI',sans-serif" },
        { label: "Inter", cssValue: "'Inter', 'Segoe UI', system-ui, sans-serif", preview: "'Inter','Segoe UI',sans-serif" },
        { label: "JetBrains Mono", cssValue: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace", preview: "'JetBrains Mono',Consolas,monospace" },
        { label: "Cascadia Code", cssValue: "'Cascadia Code', Consolas, monospace", preview: "'Cascadia Code',Consolas,monospace" },
        { label: "Georgia", cssValue: "Georgia, 'Times New Roman', serif", preview: "Georgia,serif" },
    ];
    ${contrastHelpers}
    const BASE_URL = "http://127.0.0.1:" + ${Number(port)};
    const API_TOKEN = ${JSON.stringify(String(token || ""))};
    const apiFetch = (pathOrUrl, opts = {}) => {
        const url = String(pathOrUrl).startsWith("http") ? pathOrUrl : (BASE_URL + pathOrUrl);
        const headers = Object.assign({}, opts.headers || {});
        if (API_TOKEN) headers["X-Agy-Token"] = API_TOKEN;
        return fetch(url, Object.assign({}, opts, { headers }));
    };
    const withToken = (url) => {
        if (!API_TOKEN) return url;
        return url + (url.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(API_TOKEN);
    };
    const STORAGE_KEY = "agy_wp_v11";

    // Sensible, lag-free defaults: pinned wallpaper, no timer, muted until adjusted, neutral filters
    const DEFAULTS = {
        timerMinutes: 15,
        playMode: "lock", // "lock" | "seq" | "random"
        paused: false,
        muted: true,
        wallpaperVolume: 0.35,
        dim: 0.36,
        videoBlur: 0,
        panelAlpha: 0.68,
        panelBlurPx: 20,
        playbackRate: 1.0,
        videoSat: 1.00,
        videoContrast: 1.00,
        videoFit: "cover",
        themeMode: INITIAL_THEME_MODE, // "dark" | "light" | "system"
        uiContrast: INITIAL_UI_CONTRAST, // "default" | "high"
        useCustomBg: false,
        customBgHex: DARK_DEFAULT_BG_HEX,
        useCustomText: false,
        customTextHex: DARK_DEFAULT_TEXT_HEX,
        darkUseCustomBg: false,
        darkCustomBgHex: DARK_DEFAULT_BG_HEX,
        darkUseCustomText: false,
        darkCustomTextHex: DARK_DEFAULT_TEXT_HEX,
        darkCustomAccentHex: DARK_DEFAULT_ACCENT_HEX,
        lightUseCustomBg: false,
        lightCustomBgHex: LIGHT_DEFAULT_BG_HEX,
        lightUseCustomText: false,
        lightCustomTextHex: LIGHT_DEFAULT_TEXT_HEX,
        lightCustomAccentHex: LIGHT_DEFAULT_ACCENT_HEX,
        autoContrast: true,
        adaptiveAccent: true,
        privacyMode: INITIAL_PRIVACY,
        privacyRevealMode: INITIAL_PRIVACY_REVEAL, // "never" | "modifier" | "hover"
        privacyHideStyle: INITIAL_PRIVACY_STYLE, // "blur" | "mask"
        privacyHidePaths: INITIAL_PRIVACY_PATHS,
        customAccentHex: DARK_DEFAULT_ACCENT_HEX,
        uiFontChoice: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
        fontSizePx: 14,
        radiusPx: 10,
        mediaFilter: "all",
        hideMature: true,
        hideLowRes: true,
        reduceBackdropBlur: true,
        pauseVideoInModal: false,
        pauseVideoOnBlur: true,
        reduceMotion: false,
        staticWallpaperMode: false,
        wallpaperEnabled: INITIAL_WALLPAPER_ENABLED,
        accountStartupMode: "picker", // "picker" | "primary" | "last"
        primaryAccountId: "default",
        stopServerOnTabClose: true,
        showTopTabBar: true,
        lang: "ru",
        hiddenIds: [],
        currentId: "",
        currentIndex: -1,
    };

    const ACCENT_SWATCHES = ["#60a5fa", "#38bdf8", "#a855f7", "#10b981", "#f59e0b", "#f43f5e", "#cbd5e1", "#818cf8"];

    const SVG = {
        shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
        prev: '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>',
        next: '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>',
        pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
        play: '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
        volOff: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
        volOn: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
        list: '<svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        chevronDown: '<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>',
        reset: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
        close: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
        wallpaper: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
        palette: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><circle cx="12" cy="15" r="1"/></svg>',
        widgets: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
        perf: '<svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
        accounts: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    };

    const state = {
        allVideos: [],
        videos: [],
        customFonts: Array.isArray(INITIAL_CUSTOM_FONTS) ? INITIAL_CUSTOM_FONTS.slice() : [],
        shuffleBag: [],
        ...DEFAULTS,
        timerHandle: null,
        lumaBoost: 0,
        wallpaperBrightLuma: 0,
        wallpaperDarkLuma: 255,
        wallpaperSampled: false,
        activeTab: "wallpapers",
        colorEditMode: INITIAL_THEME_MODE === "light" ? "light" : "dark",
        activePickerTarget: "accent", // "bg" | "text" | "accent"
        playerVolume: 100,
        playerMuted: false,
    };

    function isHex6(v) {
        return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim());
    }

    function hexToRgbTriplet(hex, fallback) {
        if (!isHex6(hex)) return fallback;
        const h = hex.trim().slice(1);
        return parseInt(h.slice(0, 2), 16) + ", " + parseInt(h.slice(2, 4), 16) + ", " + parseInt(h.slice(4, 6), 16);
    }

    const sysDarkMq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    function resolveEffectiveThemeMode() {
        if (state.themeMode === "light") return "light";
        if (state.themeMode === "dark") return "dark";
        if (sysDarkMq && typeof sysDarkMq.matches === "boolean") {
            return sysDarkMq.matches ? "dark" : "light";
        }
        return "dark";
    }

    function getThemeColorProfile(mode) {
        const isLight = mode === "light";
        return {
            useBg: isLight ? !!state.lightUseCustomBg : !!state.darkUseCustomBg,
            bgHex: isLight ? (state.lightCustomBgHex || LIGHT_DEFAULT_BG_HEX) : (state.darkCustomBgHex || DARK_DEFAULT_BG_HEX),
            useText: isLight ? !!state.lightUseCustomText : !!state.darkUseCustomText,
            textHex: isLight ? (state.lightCustomTextHex || LIGHT_DEFAULT_TEXT_HEX) : (state.darkCustomTextHex || DARK_DEFAULT_TEXT_HEX),
            accentHex: isLight ? (state.lightCustomAccentHex || LIGHT_DEFAULT_ACCENT_HEX) : (state.darkCustomAccentHex || DARK_DEFAULT_ACCENT_HEX),
        };
    }

    function resolveEffectiveTintRgb() {
        const mode = resolveEffectiveThemeMode();
        const prof = getThemeColorProfile(mode);
        if (prof.useBg && isHex6(prof.bgHex)) {
            return hexToRgbTriplet(prof.bgHex, mode === "light" ? LIGHT_DEFAULT_TINT_RGB : (BASE_THEME.tintRgb || "12, 14, 20"));
        }
        return mode === "light"
            ? LIGHT_DEFAULT_TINT_RGB
            : (BASE_THEME.tintRgb || "12, 14, 20");
    }

    function resolveEffectiveAccentHex() {
        const mode = resolveEffectiveThemeMode();
        const prof = getThemeColorProfile(mode);
        return isHex6(prof.accentHex) ? prof.accentHex : (mode === "light" ? LIGHT_DEFAULT_ACCENT_HEX : DARK_DEFAULT_ACCENT_HEX);
    }

    function hydrateFromObject(src) {
        if (!src || typeof src !== "object") return;
        const prevThemeMode = state.themeMode;
        for (const k of ["timerMinutes", "dim", "videoBlur", "panelAlpha", "panelBlurPx", "playbackRate", "videoSat", "videoContrast", "currentIndex", "fontSizePx", "radiusPx", "wallpaperVolume"]) {
            if (typeof src[k] === "number" && !Number.isNaN(src[k])) state[k] = src[k];
        }
        state.panelBlurPx = Math.max(0, Math.min(32, Math.round(Number(state.panelBlurPx ?? 20))));
        for (const k of [
            "paused", "muted", "autoContrast", "adaptiveAccent", "hideMature", "hideLowRes",
            "reduceBackdropBlur", "pauseVideoInModal", "pauseVideoOnBlur", "reduceMotion",
            "staticWallpaperMode", "wallpaperEnabled", "stopServerOnTabClose", "showTopTabBar", "privacyMode", "privacyHidePaths",
            "darkUseCustomBg", "darkUseCustomText", "lightUseCustomBg", "lightUseCustomText",
        ]) {
            if (typeof src[k] === "boolean") state[k] = src[k];
        }
        if (src.themeMode === "dark" || src.themeMode === "light" || src.themeMode === "system") state.themeMode = src.themeMode;
        if (src.uiContrast === "default" || src.uiContrast === "high") state.uiContrast = src.uiContrast;
        if (src.privacyRevealMode === "never" || src.privacyRevealMode === "modifier" || src.privacyRevealMode === "hover") {
            state.privacyRevealMode = src.privacyRevealMode;
        }
        if (src.privacyHideStyle === "blur" || src.privacyHideStyle === "mask") {
            state.privacyHideStyle = src.privacyHideStyle;
        }
        for (const hexKey of [
            "darkCustomBgHex", "darkCustomTextHex", "darkCustomAccentHex",
            "lightCustomBgHex", "lightCustomTextHex", "lightCustomAccentHex",
        ]) {
            if (isHex6(src[hexKey])) state[hexKey] = src[hexKey].trim().toLowerCase();
        }
        // Backwards compatibility with legacy flat color keys (mapped to active mode if per-mode keys not explicitly supplied)
        const targetMode = resolveEffectiveThemeMode();
        if (typeof src.useCustomBg === "boolean" && typeof src.darkUseCustomBg !== "boolean" && typeof src.lightUseCustomBg !== "boolean") {
            if (targetMode === "light") state.lightUseCustomBg = src.useCustomBg;
            else state.darkUseCustomBg = src.useCustomBg;
        }
        if (isHex6(src.customBgHex) && !src.darkCustomBgHex && !src.lightCustomBgHex) {
            if (targetMode === "light") state.lightCustomBgHex = src.customBgHex.trim().toLowerCase();
            else state.darkCustomBgHex = src.customBgHex.trim().toLowerCase();
        }
        if (typeof src.useCustomText === "boolean" && typeof src.darkUseCustomText !== "boolean" && typeof src.lightUseCustomText !== "boolean") {
            if (targetMode === "light") state.lightUseCustomText = src.useCustomText;
            else state.darkUseCustomText = src.useCustomText;
        }
        if (isHex6(src.customTextHex) && !src.darkCustomTextHex && !src.lightCustomTextHex) {
            if (targetMode === "light") state.lightCustomTextHex = src.customTextHex.trim().toLowerCase();
            else state.darkCustomTextHex = src.customTextHex.trim().toLowerCase();
        }
        if (isHex6(src.customAccentHex) && !src.darkCustomAccentHex && !src.lightCustomAccentHex) {
            const cleanAcc = src.customAccentHex.trim().toLowerCase();
            state.customAccentHex = cleanAcc;
            if (targetMode === "light") state.lightCustomAccentHex = cleanAcc;
            else state.darkCustomAccentHex = cleanAcc;
        }
        if (typeof src.accentRgb === "string" && /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(src.accentRgb.trim()) && state.adaptiveAccent) {
            state.adaptiveRgb = src.accentRgb.trim();
        }
        if (!state._hydratedOnce || (src.themeMode && src.themeMode !== prevThemeMode)) {
            state.colorEditMode = resolveEffectiveThemeMode();
        }
        state._hydratedOnce = true;
        if (src.accountStartupMode === "picker" || src.accountStartupMode === "primary" || src.accountStartupMode === "last") {
            state.accountStartupMode = src.accountStartupMode;
        }
        if (typeof src.primaryAccountId === "string" && src.primaryAccountId.trim()) {
            state.primaryAccountId = src.primaryAccountId.trim();
        }
        if (src.playMode === "random" || src.playMode === "seq" || src.playMode === "lock") state.playMode = src.playMode;
        if (state.playMode !== "lock" && (!state.timerMinutes || state.timerMinutes <= 0)) state.timerMinutes = 15;
        state.wallpaperVolume = Math.max(0, Math.min(1, Number(state.wallpaperVolume) || 0));
        if (src.videoFit === "cover" || src.videoFit === "contain") state.videoFit = src.videoFit;
        if (typeof src.uiFontChoice === "string" && src.uiFontChoice.trim()) state.uiFontChoice = src.uiFontChoice;
        if (src.mediaFilter === "video" || src.mediaFilter === "image" || src.mediaFilter === "all") state.mediaFilter = src.mediaFilter;
        if (src.lang === "ru" || src.lang === "en") state.lang = src.lang;
        if (typeof src.currentId === "string") state.currentId = src.currentId;
        if (Array.isArray(src.hiddenIds)) state.hiddenIds = src.hiddenIds;
    }

    // Prefer shared disk config injected at startup to eliminate per-partition localStorage stale races
    if (INITIAL_CONFIG && typeof INITIAL_CONFIG === "object" && Object.keys(INITIAL_CONFIG).length > 0) {
        hydrateFromObject(INITIAL_CONFIG);
    } else {
        try { hydrateFromObject(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); } catch {}
    }

    let saveDebounce = null;
    let dragSaveTimer = null;
    let hasPendingDragSave = false;
    let lastSavedPayloadStr = "";
    function buildSavePayload(extraFlags = null) {
        const effMode = resolveEffectiveThemeMode();
        const effProf = getThemeColorProfile(effMode);
        const effTintRgb = resolveEffectiveTintRgb();
        const effAccHex = resolveEffectiveAccentHex();
        const payload = {
            timerMinutes: state.timerMinutes,
            playMode: state.playMode,
            paused: state.paused,
            muted: state.muted,
            wallpaperVolume: state.wallpaperVolume,
            dim: state.dim,
            videoBlur: state.videoBlur,
            panelAlpha: state.panelAlpha,
            panelBlurPx: state.panelBlurPx,
            lumaBoost: state.lumaBoost,
            playbackRate: state.playbackRate,
            videoSat: state.videoSat,
            videoContrast: state.videoContrast,
            videoFit: state.videoFit,
            themeMode: state.themeMode,
            uiContrast: state.uiContrast,
            useCustomBg: effProf.useBg,
            customBgHex: effProf.bgHex,
            useCustomText: effProf.useText,
            customTextHex: effProf.textHex,
            darkUseCustomBg: !!state.darkUseCustomBg,
            darkCustomBgHex: state.darkCustomBgHex,
            darkUseCustomText: !!state.darkUseCustomText,
            darkCustomTextHex: state.darkCustomTextHex,
            darkCustomAccentHex: state.darkCustomAccentHex,
            lightUseCustomBg: !!state.lightUseCustomBg,
            lightCustomBgHex: state.lightCustomBgHex,
            lightUseCustomText: !!state.lightUseCustomText,
            lightCustomTextHex: state.lightCustomTextHex,
            lightCustomAccentHex: state.lightCustomAccentHex,
            autoContrast: state.autoContrast,
            adaptiveAccent: state.adaptiveAccent,
            privacyMode: !!state.privacyMode,
            privacyRevealMode: state.privacyRevealMode,
            privacyHideStyle: state.privacyHideStyle,
            privacyHidePaths: state.privacyHidePaths !== false,
            customAccentHex: effAccHex,
            uiFontChoice: state.uiFontChoice,
            fontSizePx: state.fontSizePx,
            radiusPx: state.radiusPx,
            mediaFilter: state.mediaFilter,
            hideMature: state.hideMature,
            hideLowRes: state.hideLowRes,
            reduceBackdropBlur: state.reduceBackdropBlur,
            pauseVideoInModal: state.pauseVideoInModal,
            pauseVideoOnBlur: state.pauseVideoOnBlur,
            reduceMotion: state.reduceMotion,
            staticWallpaperMode: state.staticWallpaperMode,
            wallpaperEnabled: state.wallpaperEnabled !== false,
            accountStartupMode: state.accountStartupMode,
            primaryAccountId: state.primaryAccountId,
            stopServerOnTabClose: state.stopServerOnTabClose,
            showTopTabBar: state.showTopTabBar,
            lang: state.lang,
            hiddenIds: state.hiddenIds,
            currentId: state.currentId,
            currentIndex: state.currentIndex,
            accentRgb: state.adaptiveAccent ? (state.adaptiveRgb || BASE_THEME.accentRgb) : hexToRgbTriplet(effAccHex, BASE_THEME.accentRgb),
            tintRgb: effTintRgb,
        };
        if (extraFlags && extraFlags._reset === true) {
            payload._reset = true;
        }
        return payload;
    }

    function saveState(immediate = false, extraFlags = null) {
        const isDrag = immediate === "drag" || Boolean(extraFlags && extraFlags.drag === true);
        if (isDrag) {
            hasPendingDragSave = true;
            clearTimeout(saveDebounce);
            clearTimeout(dragSaveTimer);
            dragSaveTimer = setTimeout(() => {
                dragSaveTimer = null;
                if (hasPendingDragSave) {
                    hasPendingDragSave = false;
                    saveState(true);
                }
            }, 650);
            return;
        }
        clearTimeout(dragSaveTimer);
        dragSaveTimer = null;
        hasPendingDragSave = false;

        const payload = buildSavePayload(extraFlags);
        const payloadStr = JSON.stringify(payload);
        const isReset = Boolean(extraFlags && extraFlags._reset === true);
        if (!isReset && payloadStr === lastSavedPayloadStr) {
            return;
        }
        lastSavedPayloadStr = payloadStr;
        try { localStorage.setItem(STORAGE_KEY, payloadStr); } catch {}
        const flush = () => {
            window.__agyLastWpSaveTs = Date.now();
            try {
                apiFetch("/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: payloadStr,
                }).catch(() => {});
            } catch {}
        };
        if (immediate) { clearTimeout(saveDebounce); flush(); }
        else { clearTimeout(saveDebounce); saveDebounce = setTimeout(flush, 260); }
    }

    const isRu = () => state.lang !== "en";

    function resetShuffleBag() {
        state.shuffleBag = [];
    }

    function refillShuffleBag(excludeIdx) {
        const len = state.videos.length;
        const bag = [];
        for (let i = 0; i < len; i++) bag.push(i);
        // Fisher-Yates unbiased shuffle
        for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = bag[i];
            bag[i] = bag[j];
            bag[j] = tmp;
        }
        // Avoid repeating the current wallpaper immediately on bag refill
        if (len > 1 && bag[bag.length - 1] === excludeIdx) {
            const swapIdx = Math.floor(Math.random() * (len - 1));
            const tmp = bag[bag.length - 1];
            bag[bag.length - 1] = bag[swapIdx];
            bag[swapIdx] = tmp;
        }
        state.shuffleBag = bag;
    }

    function rebuildFilteredList() {
        const hiddenSet = new Set(state.hiddenIds || []);
        state.videos = state.allVideos.filter((v) => {
            if (hiddenSet.has(v.id)) return false;
            if (state.hideMature && v.isMature) return false;
            if (state.hideLowRes && v.isLowRes) return false;
            if (state.mediaFilter === "video" && v.kind !== "video") return false;
            if (state.mediaFilter === "image" && v.kind !== "image" && v.kind !== "scene") return false;
            return true;
        });
        resetShuffleBag();
    }

    let shadowHost = null;
    let lumaBadge = null;
    let lastAccentRgb = BASE_THEME.accentRgb;

    const rootVarCache = new Map();
    const hostVarCaches = new WeakMap();
    const hostDataCaches = new WeakMap();
    const rootDataCache = new Map();
    let lastColorScheme = "";
    let lastVisualSyncSig = "";

    function setRootVar(rootStyle, name, value, important = false) {
        const valStr = String(value);
        const cacheVal = important ? (valStr + "!important") : valStr;
        if (rootVarCache.get(name) === cacheVal) return false;
        rootVarCache.set(name, cacheVal);
        if (important) rootStyle.setProperty(name, valStr, "important");
        else rootStyle.setProperty(name, valStr);
        return true;
    }

    function setHostVar(el, name, value) {
        if (!el || !el.style) return false;
        let cache = hostVarCaches.get(el);
        if (!cache) {
            cache = new Map();
            hostVarCaches.set(el, cache);
        }
        const valStr = String(value);
        if (cache.get(name) === valStr) return false;
        cache.set(name, valStr);
        el.style.setProperty(name, valStr);
        return true;
    }

    function setRootFlag(docEl, prop, value) {
        if (!docEl || !docEl.dataset) return false;
        if (value === undefined || value === null) {
            if (rootDataCache.get(prop) === undefined && docEl.dataset[prop] === undefined) return false;
            rootDataCache.delete(prop);
            delete docEl.dataset[prop];
            return true;
        }
        const valStr = String(value);
        if (rootDataCache.get(prop) === valStr && docEl.dataset[prop] === valStr) return false;
        rootDataCache.set(prop, valStr);
        docEl.dataset[prop] = valStr;
        return true;
    }

    function setHostFlag(el, prop, value) {
        if (!el || !el.dataset) return false;
        let cache = hostDataCaches.get(el);
        if (!cache) {
            cache = new Map();
            hostDataCaches.set(el, cache);
        }
        const valStr = String(value);
        if (cache.get(prop) === valStr && el.dataset[prop] === valStr) return false;
        cache.set(prop, valStr);
        el.dataset[prop] = valStr;
        return true;
    }

    function setAccentRgbEverywhere(rgb, precomputedPal = null, precomputedOpts = null) {
        lastAccentRgb = rgb;
        let effMode;
        let resolvedTint;
        let tokens;
        if (precomputedPal) {
            effMode = precomputedPal.effectiveMode;
            resolvedTint = precomputedPal.tintRgb;
            tokens = precomputedPal;
        } else {
            effMode = resolveEffectiveThemeMode();
            const prof = getThemeColorProfile(effMode);
            const activeTint = resolveEffectiveTintRgb();
            resolvedTint = activeTint;
            tokens = buildUiDesignTokens({
                effectiveMode: effMode,
                tintRgb: activeTint,
                accentRgb: rgb,
                uiContrast: state.uiContrast,
                panelAlpha: state.panelAlpha,
                reduceBackdropBlur: !!state.reduceBackdropBlur,
                panelBlurPx: state.panelBlurPx,
                useCustomText: prof.useText,
                customTextHex: prof.textHex,
            });
        }
        const root = document.documentElement.style;
        setRootVar(root, "--agy-accent-rgb", rgb);
        setRootVar(root, "--primary", "rgb(" + rgb + ")");
        setRootVar(root, "--color-primary", "rgb(" + rgb + ")");
        setRootVar(root, "--primary-foreground", tokens.onSolidAccent);
        setRootVar(root, "--color-primary-foreground", tokens.onSolidAccent);
        setRootVar(root, "--accent-foreground", tokens.onTintedAccent);
        setRootVar(root, "--color-accent-foreground", tokens.onTintedAccent);
        setRootVar(root, "--cta-foreground", tokens.onSolidAccent);
        setRootVar(root, "--agy-on-solid-accent", tokens.onSolidAccent);
        setRootVar(root, "--agy-on-tinted-accent", tokens.onTintedAccent);
        setRootVar(root, "--agy-accent-text", tokens.accentText);
        setRootVar(root, "--link", tokens.accentText);
        setRootVar(root, "--color-link", tokens.accentText);

        const extrasHost = document.getElementById("agy-extras-shadow-host");
        for (const el of [shadowHost, extrasHost]) {
            if (!el) continue;
            setHostVar(el, "--agy-accent-rgb", rgb);
            setHostVar(el, "--agy-on-solid-accent", tokens.onSolidAccent);
            setHostVar(el, "--agy-on-tinted-accent", tokens.onTintedAccent);
            setHostVar(el, "--agy-accent-text", tokens.accentText);
        }
        const blurSkip = precomputedOpts && typeof precomputedOpts.blurSkip === "boolean"
            ? precomputedOpts.blurSkip
            : (!state.reduceBackdropBlur && (tokens.panelBlurPx <= 0 || Number(state.panelAlpha ?? 0.68) >= 0.96));
        const effectiveBlurPx = (state.reduceBackdropBlur || blurSkip) ? 0 : tokens.panelBlurPx;
        const modHeld = Boolean(state.privacyMode && state.privacyRevealMode === "modifier" && document.documentElement?.dataset?.agyModHeld === "1");
        const syncSig = [
            rgb,
            resolvedTint,
            effMode,
            tokens.isLightSurface ? "light" : "dark",
            state.uiContrast,
            state.panelAlpha,
            tokens.panelBlurPx,
            effectiveBlurPx,
            state.reduceBackdropBlur ? "1" : "0",
            blurSkip ? "1" : "0",
            tokens.fg,
            state.privacyMode ? "1" : "0",
            state.privacyRevealMode,
            state.privacyHideStyle,
            state.privacyHidePaths !== false ? "1" : "0",
            modHeld ? "1" : "0",
        ].join("|");
        if (syncSig === lastVisualSyncSig) return;
        lastVisualSyncSig = syncSig;
        window.dispatchEvent(new CustomEvent("agy-visual-sync", {
            detail: {
                accentRgb: rgb,
                tintRgb: resolvedTint,
                themeMode: effMode,
                surfaceMode: tokens.isLightSurface ? "light" : "dark",
                uiContrast: state.uiContrast,
                panelAlpha: state.panelAlpha,
                panelBlurPx: tokens.panelBlurPx,
                effectivePanelBlurPx: effectiveBlurPx,
                reduceBackdropBlur: !!state.reduceBackdropBlur,
                blurSkip,
                radiusPx: state.radiusPx,
                privacyMode: !!state.privacyMode,
                privacyRevealMode: state.privacyRevealMode,
                privacyHideStyle: state.privacyHideStyle,
                privacyHidePaths: state.privacyHidePaths !== false,
                modHeld,
                tokens,
            },
        }));
    }

    // ===== Hardware-Accelerated Zero-Lag Wallpaper Layer =====
    const layer = document.createElement("div");
    layer.id = "agy-wallpaper-layer";

    const bgVideo = document.createElement("video");
    bgVideo.crossOrigin = "anonymous";
    bgVideo.preload = "auto";
    bgVideo.autoplay = true;
    bgVideo.loop = true;
    bgVideo.muted = state.muted;
    bgVideo.volume = state.wallpaperVolume;
    bgVideo.playsInline = true;
    bgVideo.playbackRate = state.playbackRate;
    bgVideo.style.opacity = "1";
    layer.appendChild(bgVideo);

    const sceneImg = document.createElement("img");
    sceneImg.className = "agy-scene-bg";
    sceneImg.crossOrigin = "anonymous";
    sceneImg.style.opacity = "0";
    layer.appendChild(sceneImg);
    if (typeof bgVideo.addEventListener === "function") {
        bgVideo.addEventListener("loadeddata", () => { if (typeof analyzeCurrentWallpaperOnce === "function") setTimeout(analyzeCurrentWallpaperOnce, 100); });
        bgVideo.addEventListener("seeked", () => { if (typeof analyzeCurrentWallpaperOnce === "function") analyzeCurrentWallpaperOnce(); });
    }
    if (typeof sceneImg.addEventListener === "function") {
        sceneImg.addEventListener("load", () => { if (typeof analyzeCurrentWallpaperOnce === "function") setTimeout(analyzeCurrentWallpaperOnce, 60); });
    }

    let activeMediaEl = bgVideo;
    let currentStreamUrl = "";

    const scrim = document.createElement("div");
    scrim.id = "agy-wallpaper-scrim";
    layer.appendChild(scrim);

    let lastPlainBgMediaState = null;
    function applyWallpaperMediaState() {
        const plainBg = state.wallpaperEnabled === false;
        if (lastPlainBgMediaState === plainBg) return;
        lastPlainBgMediaState = plainBg;
        if (plainBg) {
            scrim.style.display = "none";
            bgVideo.style.display = "none";
            sceneImg.style.display = "none";
            bgVideo.style.opacity = "0";
            sceneImg.style.opacity = "0";
            try { bgVideo.pause(); bgVideo.removeAttribute("src"); bgVideo.load(); } catch {}
            try { sceneImg.removeAttribute("src"); } catch {}
            currentStreamUrl = "";
            if (typeof previewVideo !== "undefined" && previewVideo) {
                try { previewVideo.pause(); previewVideo.removeAttribute("src"); previewVideo.load(); } catch {}
            }
            if (typeof previewImg !== "undefined" && previewImg) {
                try { previewImg.removeAttribute("src"); previewImg.style.display = "none"; } catch {}
            }
        } else {
            scrim.style.display = "";
            bgVideo.style.display = "";
            sceneImg.style.display = "";
        }
    }

    const mountLayer = () => {
        if (document.body) {
            if (!document.body.hasAttribute("data-agy-theme")) {
                document.body.setAttribute("data-agy-theme", "");
            }
            if (!document.getElementById("agy-wallpaper-layer")) {
                document.body.prepend(layer);
                if (state.wallpaperEnabled !== false && bgVideo.src && bgVideo.paused && !state.paused && !state.staticWallpaperMode) {
                    bgVideo.play().catch(() => {});
                }
            }
        }
    };
    mountLayer();
    applyWallpaperMediaState();

    // Start playing the active wallpaper immediately on dom-ready without waiting for /config & /list
    if (state.wallpaperEnabled !== false && INITIAL_MEDIA && INITIAL_MEDIA.src) {
        currentStreamUrl = INITIAL_MEDIA.src;
        if (INITIAL_MEDIA.kind === "scene" || INITIAL_MEDIA.kind === "image") {
            sceneImg.src = INITIAL_MEDIA.src;
            sceneImg.style.opacity = "1";
            bgVideo.style.opacity = "0";
            activeMediaEl = sceneImg;
        } else {
            bgVideo.src = INITIAL_MEDIA.src;
            bgVideo.style.opacity = "1";
            sceneImg.style.opacity = "0";
            activeMediaEl = bgVideo;
            bgVideo.play().catch(() => {});
        }
    }

    let lastVideoFilterStr = "";
    let lastVideoScaleStr = "";
    function applyVideoFilterFast() {
        const needsFilter = state.videoBlur > 0 || Math.abs(state.videoSat - 1) > 0.01 || Math.abs(state.videoContrast - 1) > 0.01;
        const filterStr = needsFilter
            ? ("blur(" + state.videoBlur + "px) saturate(" + state.videoSat + ") contrast(" + state.videoContrast + ")")
            : "none";
        const scaleStr = state.videoBlur > 0 ? ("scale(" + (1 + state.videoBlur * 0.003).toFixed(3) + ") translateZ(0)") : "translateZ(0)";
        if (lastVideoFilterStr !== filterStr) {
            lastVideoFilterStr = filterStr;
            bgVideo.style.filter = filterStr;
            sceneImg.style.filter = filterStr;
        }
        if (lastVideoScaleStr !== scaleStr) {
            lastVideoScaleStr = scaleStr;
            bgVideo.style.transform = scaleStr;
            sceneImg.style.transform = scaleStr;
        }
    }

    let lastAudioKey = "";
    function applyVideoAudio() {
        const vol = Math.max(0, Math.min(1, Number(state.wallpaperVolume) || 0));
        const muted = state.muted || vol <= 0.001;
        const key = vol.toFixed(3) + "|" + (muted ? "1" : "0");
        if (key === lastAudioKey) return;
        lastAudioKey = key;
        bgVideo.volume = vol;
        bgVideo.muted = muted;
    }

    const loadedFontUrls = new Set();
    function buildFontFacesCss(fonts) {
        if (!Array.isArray(fonts) || !fonts.length) return "";
        return fonts.map((f) => {
            if (!f || !f.family || !f.urlPath) return "";
            const url = withToken(BASE_URL + f.urlPath);
            const safeFam = String(f.family).replace(/["\\\\]/g, "");
            const fmt = String(f.format || "truetype").replace(/[^a-z0-9-]/gi, "");
            return '@font-face{font-family:"' + safeFam + '";src:url("' + url + '") format("' + fmt + '");font-weight:100 900;font-style:normal;font-display:swap;}';
        }).filter(Boolean).join("\\n");
    }

    function registerCustomFonts(fonts) {
        const list = Array.isArray(fonts) ? fonts : [];
        state.customFonts = list;
        const cssText = buildFontFacesCss(list);
        let docStyle = document.getElementById("agy-custom-fonts-css");
        if (!docStyle) {
            docStyle = document.createElement("style");
            docStyle.id = "agy-custom-fonts-css";
            (document.head || document.documentElement).appendChild(docStyle);
        }
        docStyle.textContent = cssText;

        if (shadowHost && shadowHost.shadowRoot) {
            let shStyle = shadowHost.shadowRoot.getElementById("agy-shadow-custom-fonts-css");
            if (!shStyle) {
                shStyle = document.createElement("style");
                shStyle.id = "agy-shadow-custom-fonts-css";
                shadowHost.shadowRoot.prepend(shStyle);
            }
            shStyle.textContent = cssText;
        }

        if (typeof FontFace === "function" && document.fonts && typeof document.fonts.add === "function") {
            for (const f of list) {
                if (!f || !f.family || !f.urlPath) continue;
                const url = withToken(BASE_URL + f.urlPath);
                if (loadedFontUrls.has(url)) continue;
                loadedFontUrls.add(url);
                try {
                    const ff = new FontFace(f.family, 'url("' + url + '")', { display: "swap" });
                    document.fonts.add(ff);
                    if (typeof ff.load === "function") ff.load().catch(() => {});
                } catch {}
            }
        }
        try {
            window.dispatchEvent(new CustomEvent("agy-fonts-sync", { detail: { cssText, fonts: list } }));
        } catch {}
    }
    registerCustomFonts(state.customFonts);

    function computeResolvedPalette() {
        const effectiveMode = resolveEffectiveThemeMode();
        const prof = getThemeColorProfile(effectiveMode);
        const tintRgb = resolveEffectiveTintRgb();
        const activeAccRgb = !state.adaptiveAccent
            ? hexToRgbTriplet(resolveEffectiveAccentHex(), BASE_THEME.accentRgb)
            : (state.adaptiveRgb || lastAccentRgb || BASE_THEME.accentRgb);
        return buildUiDesignTokens({
            effectiveMode,
            tintRgb,
            accentRgb: activeAccRgb,
            uiContrast: state.uiContrast,
            panelAlpha: state.panelAlpha,
            reduceBackdropBlur: !!state.reduceBackdropBlur,
            panelBlurPx: state.panelBlurPx,
            useCustomText: prof.useText,
            customTextHex: prof.textHex,
        });
    }

    // ===== WCAG Syntax Highlighting Adapter for Code Blocks, File Viewer & Diff Viewer =====
    const CODE_SYNTAX_CONTAINER_SEL = '.code-line, .code-block, .prose pre, .file-viewer-root, [data-testid="file-viewer"], .diff-view-mode-detail, [data-file-uri]';
    let codeAdaptScheduled = false;
    function resolveCodeBoxSurfaceRgb(box, pal) {
        if (!box) return pal.tintRgb;
        try {
            if (box.closest && box.closest(".vs-dark, .hc-black, .monaco-editor.vs-dark, .monaco-editor.hc-black")) {
                return "18, 20, 26";
            }
            if (pal.isLightSurface && typeof getComputedStyle === "function") {
                const bgNodes = [box, box.closest ? box.closest(".monaco-editor, .cm-editor, .code-block, .file-viewer-root") : null].filter(Boolean);
                for (const node of bgNodes) {
                    const cs = getComputedStyle(node);
                    const bgStr = cs && (cs.backgroundColor || cs.background);
                    if (!bgStr || bgStr === "transparent" || bgStr === "rgba(0, 0, 0, 0)") continue;
                    const parsed = parseCssColorWithAlpha(bgStr, box.ownerDocument || document);
                    if (!parsed || !Number.isFinite(parsed.a) || parsed.a < 0.45) continue;
                    if (relativeLuminance(parsed.rgb) < 0.42) {
                        return blendRgbOver(parsed.rgb, parsed.a, parseRgb(pal.tintRgb, [250, 251, 254])).join(", ");
                    }
                }
            }
        } catch {}
        return pal.tintRgb;
    }

    function collectSyntaxContainers(docRef, roots) {
        if (!roots || roots.length === 0) {
            return docRef.querySelectorAll ? Array.from(docRef.querySelectorAll(CODE_SYNTAX_CONTAINER_SEL)) : [];
        }
        const out = [];
        const seenBoxes = new Set();
        for (const root of roots) {
            if (!root || root.nodeType !== 1) continue;
            if (root.isConnected === false) continue;
            if (typeof root.matches === "function" && root.matches(CODE_SYNTAX_CONTAINER_SEL)) {
                if (!seenBoxes.has(root)) { seenBoxes.add(root); out.push(root); }
            }
            if (typeof root.closest === "function") {
                const ancBox = root.closest(CODE_SYNTAX_CONTAINER_SEL);
                if (ancBox && !seenBoxes.has(ancBox)) { seenBoxes.add(ancBox); out.push(ancBox); }
            }
            if (typeof root.querySelectorAll === "function") {
                const nested = root.querySelectorAll(CODE_SYNTAX_CONTAINER_SEL);
                for (let i = 0; i < nested.length; i++) {
                    if (!seenBoxes.has(nested[i])) { seenBoxes.add(nested[i]); out.push(nested[i]); }
                }
            }
        }
        return out;
    }

    function adaptCodeSyntaxColors(docRef = document, roots = null, precomputedPal = null) {
        if (!docRef || !docRef.querySelectorAll) return 0;
        const containers = collectSyntaxContainers(docRef, roots);
        if (!containers || !containers.length) return 0;
        const pal = precomputedPal || computeResolvedPalette();
        const minRatio = pal.highContrast ? 5.5 : 4.8;
        let adaptedCount = 0;
        const seen = new Set();
        const writes = [];
        const boxSurfaceCache = new Map();
        for (let bIdx = 0; bIdx < containers.length; bIdx++) {
            const box = containers[bIdx];
            if (!box || !box.querySelectorAll) continue;
            if (box.id === "agy-wp-shadow-host" || box.id === "agy-extras-shadow-host") continue;
            let boxSurfaceRgb = boxSurfaceCache.get(box);
            if (boxSurfaceRgb === undefined) {
                boxSurfaceRgb = resolveCodeBoxSurfaceRgb(box, pal);
                boxSurfaceCache.set(box, boxSurfaceRgb);
            }
            const spans = box.querySelectorAll("span, [style*='color']");
            for (let sIdx = 0; sIdx < spans.length; sIdx++) {
                const el = spans[sIdx];
                if (!el || seen.has(el)) continue;
                seen.add(el);
                if (!el.style || typeof el.style.getPropertyValue !== "function") continue;
                if (el.closest && el.closest(".monaco-editor, .monaco-diff-editor")) {
                    if (el.getAttribute("data-agy-code-adapted") === "1") {
                        writes.push({ el, action: "revert", origCol: el.getAttribute("data-agy-orig-color") || "" });
                    }
                    continue;
                }
                if (el.closest && el.closest("button, [role='button'], [role='menuitem'], [role='tab'], [role='toolbar']") && !el.closest(".code-line, .code-block, .prose pre")) {
                    continue;
                }
                const isAdapted = el.getAttribute("data-agy-code-adapted") === "1";
                const inlineCol = (el.style.getPropertyValue("color") || el.style.color || "").trim();
                const origAttr = el.getAttribute("data-agy-orig-color");
                const prevAdaptedCol = (el.getAttribute("data-agy-adapted-color") || "").trim();
                let origCol = origAttr ? origAttr.trim() : "";
                let saveOrig = false;
                if (!isAdapted) {
                    if (!inlineCol) continue;
                    origCol = inlineCol;
                    saveOrig = true;
                } else if (inlineCol && prevAdaptedCol && inlineCol !== prevAdaptedCol) {
                    origCol = inlineCol;
                    saveOrig = true;
                } else if (!origCol) {
                    continue;
                }
                const fixed = ensureReadableSyntaxColor(origCol, boxSurfaceRgb, minRatio);
                if (fixed) {
                    adaptedCount++;
                    if (!isAdapted || prevAdaptedCol !== fixed || inlineCol !== fixed || saveOrig) {
                        writes.push({ el, action: "adapt", origCol, fixed, saveOrig });
                    }
                } else if (isAdapted) {
                    writes.push({ el, action: "revert", origCol });
                }
            }
        }
        for (let i = 0; i < writes.length; i++) {
            const w = writes[i];
            if (w.action === "adapt") {
                if (w.saveOrig) w.el.setAttribute("data-agy-orig-color", w.origCol);
                w.el.setAttribute("data-agy-adapted-color", w.fixed);
                w.el.style.setProperty("color", w.fixed, "important");
                w.el.setAttribute("data-agy-code-adapted", "1");
            } else {
                if (w.origCol) w.el.style.setProperty("color", w.origCol);
                w.el.removeAttribute("data-agy-code-adapted");
                w.el.removeAttribute("data-agy-adapted-color");
            }
        }
        return adaptedCount;
    }

    function syncEditorPaneTags(docRef = document) {
        if (!docRef || !docRef.querySelectorAll) return 0;
        const EDITOR_MARKER_SEL = '.file-viewer-root, [data-testid="file-viewer"], .diff-view-mode-detail, .monaco-diff-editor, .monaco-editor, .cm-editor, [data-diff-type], [data-testid="code-gutter-diff"], [data-testid="diff-gutter-strip"], [data-file-uri]';
        const nextPanes = new Set();
        const markers = docRef.querySelectorAll(EDITOR_MARKER_SEL);
        for (let i = 0; i < markers.length; i++) {
            const el = markers[i];
            if (!el || el.nodeType !== 1) continue;
            if (typeof el.closest === "function" && el.closest('[data-main-content-body], .surface-composer, [aria-label="Sidebar"], [data-testid="title-menu-bar"], #agy-wp-shadow-host, #agy-extras-shadow-host')) {
                continue;
            }
            let best = null;
            let cur = el;
            while (cur && cur.nodeType === 1 && cur !== docRef.body && cur !== docRef.documentElement && cur.id !== "root" && cur.id !== "app") {
                if (typeof cur.matches === "function" && cur.matches('[data-split-panes], [data-split-root="true"], [data-testid="title-menu-bar"], .agy-shell, .agy-inset-shell')) {
                    break;
                }
                if (typeof cur.querySelector === "function" && cur.querySelector('[data-main-content-body], [aria-label="Sidebar"], [data-testid="title-menu-bar"], .surface-composer')) {
                    break;
                }
                best = cur;
                cur = cur.parentElement;
            }
            if (best) nextPanes.add(best);
        }
        const prevTagged = docRef.querySelectorAll('[data-agy-editor-pane="1"]');
        for (let i = 0; i < prevTagged.length; i++) {
            const oldPane = prevTagged[i];
            if (!nextPanes.has(oldPane) && typeof oldPane.removeAttribute === "function") {
                oldPane.removeAttribute("data-agy-editor-pane");
            }
        }
        for (const pane of nextPanes) {
            if (pane.getAttribute("data-agy-editor-pane") !== "1") {
                pane.setAttribute("data-agy-editor-pane", "1");
            }
        }
        return nextPanes.size;
    }

    const cssColorParseCache = new Map();
    function parseCssColorWithAlpha(bg, docRef) {
        if (!bg || typeof bg !== "string") return null;
        if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent" || bg === "none") return null;
        const cached = cssColorParseCache.get(bg);
        if (cached !== undefined) return cached;
        const storeParsed = (val) => {
            if (cssColorParseCache.size >= 512) cssColorParseCache.clear();
            cssColorParseCache.set(bg, val);
            return val;
        };
        const s = bg.trim().toLowerCase();
        if (!s || s === "transparent" || s === "none" || s === "rgba(0, 0, 0, 0)") return storeParsed(null);
        const parseAlpha = (tok) => {
            if (tok === undefined || tok === null || tok === "") return 1;
            const t = String(tok).trim();
            if (t === "none") return 0;
            if (t.endsWith("%")) return Math.max(0, Math.min(1, parseFloat(t) / 100));
            return Math.max(0, Math.min(1, parseFloat(t)));
        };
        const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
        const parseRgbChan = (tok) => {
            const t = String(tok).trim();
            if (t === "none") return 0;
            if (t.endsWith("%")) return clamp255((parseFloat(t) / 100) * 255);
            return clamp255(parseFloat(t));
        };
        const parseUnit = (tok, pctScale = 1) => {
            const t = String(tok).trim();
            if (t === "none") return 0;
            if (t.endsWith("%")) return (parseFloat(t) / 100) * pctScale;
            return parseFloat(t);
        };
        const oklabToRgb = (L, oa, ob) => {
            const l_ = L + 0.3963377774 * oa + 0.2158037573 * ob;
            const m_ = L - 0.1055613458 * oa - 0.0638541728 * ob;
            const s_ = L - 0.0894841775 * oa - 1.2914855480 * ob;
            const l = l_ * l_ * l_, m = m_ * m_ * m_, sv = s_ * s_ * s_;
            const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sv;
            const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sv;
            const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * sv;
            const to255 = (c) => clamp255((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055) * 255);
            return [to255(lr), to255(lg), to255(lb)];
        };

        let m = /^rgba?\\(\\s*([^,\\s/]+)[,\\s]+([^,\\s/]+)[,\\s]+([^,\\s/)]+)(?:\\s*[,/]\\s*([^\\s)]+))?\\s*\\)$/.exec(s);
        if (m) {
            const rgb = [parseRgbChan(m[1]), parseRgbChan(m[2]), parseRgbChan(m[3])];
            const a = parseAlpha(m[4]);
            return storeParsed(rgb.every(Number.isFinite) && Number.isFinite(a) ? { rgb, a } : null);
        }
        m = /^color\\(\\s*(srgb-linear|srgb|display-p3|a98-rgb|prophoto-rgb|rec2020)\\s+([^\\s/]+)\\s+([^\\s/]+)\\s+([^\\s/)]+)(?:\\s*\\/\\s*([^\\s)]+))?\\s*\\)$/.exec(s);
        if (m) {
            const space = m[1];
            const toSrgb255 = (u) => space === "srgb-linear"
                ? clamp255((u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(Math.max(0, u), 1 / 2.4) - 0.055) * 255)
                : clamp255(u * 255);
            const rgb = [toSrgb255(parseUnit(m[2])), toSrgb255(parseUnit(m[3])), toSrgb255(parseUnit(m[4]))];
            const a = parseAlpha(m[5]);
            return storeParsed(rgb.every(Number.isFinite) && Number.isFinite(a) ? { rgb, a } : null);
        }
        m = /^oklab\\(\\s*([^\\s/]+)\\s+([^\\s/]+)\\s+([^\\s/)]+)(?:\\s*\\/\\s*([^\\s)]+))?\\s*\\)$/.exec(s);
        if (m) {
            const L = parseUnit(m[1], 1);
            const oa = parseUnit(m[2], 0.4);
            const ob = parseUnit(m[3], 0.4);
            const a = parseAlpha(m[4]);
            if (Number.isFinite(L) && Number.isFinite(oa) && Number.isFinite(ob) && Number.isFinite(a)) {
                return storeParsed({ rgb: oklabToRgb(L, oa, ob), a });
            }
        }
        m = /^oklch\\(\\s*([^\\s/]+)\\s+([^\\s/]+)\\s+([^\\s/)]+)(?:\\s*\\/\\s*([^\\s)]+))?\\s*\\)$/.exec(s);
        if (m) {
            const L = parseUnit(m[1], 1);
            const C = parseUnit(m[2], 0.4);
            const hRaw = m[3];
            let hRad = 0;
            if (hRaw !== "none") {
                hRad = parseFloat(hRaw) * (Math.PI / 180);
                if (hRaw.endsWith("rad")) hRad = parseFloat(hRaw);
                else if (hRaw.endsWith("turn")) hRad = parseFloat(hRaw) * Math.PI * 2;
                else if (hRaw.endsWith("grad")) hRad = parseFloat(hRaw) * (Math.PI / 200);
            }
            const a = parseAlpha(m[4]);
            if (Number.isFinite(L) && Number.isFinite(C) && Number.isFinite(hRad) && Number.isFinite(a)) {
                return storeParsed({ rgb: oklabToRgb(L, C * Math.cos(hRad), C * Math.sin(hRad)), a });
            }
        }
        m = /^#([0-9a-f]{3,8})$/.exec(s);
        if (m) {
            const h = m[1];
            if (h.length === 3 || h.length === 4) {
                const rgb = [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
                const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
                return storeParsed({ rgb, a });
            }
            if (h.length === 6 || h.length === 8) {
                const rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
                const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
                return storeParsed({ rgb, a });
            }
        }
        if (docRef && typeof docRef.createElement === "function") {
            try {
                const cvs = docRef._agyColorProbeCanvas || (docRef._agyColorProbeCanvas = docRef.createElement("canvas"));
                if (cvs && typeof cvs.getContext === "function") {
                    cvs.width = 1;
                    cvs.height = 1;
                    const ctx = cvs.getContext("2d", { willReadFrequently: true });
                    if (ctx) {
                        ctx.clearRect(0, 0, 1, 1);
                        ctx.fillStyle = "rgba(0,0,0,0)";
                        ctx.fillStyle = bg;
                        ctx.fillRect(0, 0, 1, 1);
                        const d = ctx.getImageData(0, 0, 1, 1).data;
                        return storeParsed({ rgb: [d[0], d[1], d[2]], a: d[3] / 255 });
                    }
                }
            } catch {}
        }
        return storeParsed(null);
    }

    let lastPillSurfaceKey = "";
    const PILL_TAG_SEL = "div, button, span, a, label, section, header, li";
    const PILL_SKIP_MATCH_SEL = '[data-main-content-body], [data-agy-editor-pane="1"], [aria-label="Sidebar"], [data-testid="title-menu-bar"], [role="switch"], [data-testid="send-button"], .agy-send-button, [data-testid="voice-live-pill"], .agy-sidebar-raised, .agy-user-bubble, .surface-composer, .bg-red-600, [data-diff-type], pre, code, svg, img, video, canvas';
    const PILL_SKIP_ANCESTOR_SEL = '#agy-wp-shadow-host, #agy-extras-shadow-host, #agy-wallpaper-layer, [aria-label="Sidebar"], [data-testid="title-menu-bar"], .monaco-editor, .cm-editor, .monaco-diff-editor, [data-diff-type], .code-line, [role="switch"], [data-testid="send-button"], .agy-send-button, [data-testid="voice-live-pill"], .agy-user-bubble, .surface-composer, pre, code';
    const PILL_REVIEW_OVERRIDE_SEL = '[data-agy-editor-pane="1"], .diff-view-mode-detail, .file-viewer-root, [data-testid*="review"], [data-testid*="changes"], [data-testid*="diff"], [data-testid*="turn"], [class*="diff-viewer"], [class*="review-panel"]';

    function syncLightDarkPills(docRef = document, pal = null, roots = null) {
        if (!docRef || !docRef.querySelectorAll) return 0;
        const activePal = pal || computeResolvedPalette();
        const isLight = Boolean(activePal.isLightSurface);
        const surfaceKey = isLight ? "light" : "dark";
        const surfaceChanged = lastPillSurfaceKey !== surfaceKey;
        lastPillSurfaceKey = surfaceKey;

        // Clear stale tags only when surface mode changed or full scan requested
        const staleRemovals = [];
        if (surfaceChanged || !roots || roots.length === 0) {
            const prevTagged = docRef.querySelectorAll("[data-agy-light-fix]");
            for (let i = 0; i < prevTagged.length; i++) {
                const el = prevTagged[i];
                if (typeof el.getAttribute === "function" && el.getAttribute("data-agy-pill-surface") !== surfaceKey) {
                    staleRemovals.push(el);
                }
            }
        }
        if (typeof getComputedStyle !== "function") {
            for (let i = 0; i < staleRemovals.length; i++) {
                if (typeof staleRemovals[i].removeAttribute === "function") {
                    staleRemovals[i].removeAttribute("data-agy-light-fix");
                    staleRemovals[i].removeAttribute("data-agy-pill-surface");
                }
            }
            return 0;
        }
        const accArr = parseRgb("rgb(" + (lastAccentRgb || BASE_THEME.accentRgb) + ")", [96, 165, 250]);

        // Build candidate list with O(1) subtree pruning (never descends into Sidebar, Monaco, or plain Chat turns!)
        const candidates = [];
        const seenCand = new Set();
        const PILL_TAG_SET = new Set(["DIV", "BUTTON", "SPAN", "A", "LABEL", "SECTION", "HEADER", "LI"]);
        const pushCand = (el) => {
            if (!el || el.nodeType !== 1 || seenCand.has(el)) return;
            seenCand.add(el);
            candidates.push(el);
        };
        const walkPruned = (node, insideReview = false) => {
            if (!node || node.nodeType !== 1) return;
            const nid = node.id || "";
            if (nid === "agy-wp-shadow-host" || nid === "agy-extras-shadow-host" || nid === "agy-wallpaper-layer") return;
            const hasMatches = typeof node.matches === "function";
            if (hasMatches && node.matches(PILL_SKIP_ANCESTOR_SEL)) return;
            if (!insideReview && hasMatches && node.matches("[data-main-content-body]")) {
                // Jump straight to embedded review/diff panels inside chat without touching thousands of chat spans!
                if (typeof node.querySelectorAll === "function") {
                    const reviews = node.querySelectorAll(PILL_REVIEW_OVERRIDE_SEL);
                    for (let r = 0; r < reviews.length; r++) walkPruned(reviews[r], true);
                }
                return;
            }
            if (PILL_TAG_SET.has(node.tagName)) pushCand(node);
            const ch = node.children;
            if (ch && ch.length) {
                for (let i = 0; i < ch.length; i++) walkPruned(ch[i], insideReview);
            }
        };
        if (roots && roots.length > 0 && !surfaceChanged) {
            for (let rIdx = 0; rIdx < roots.length; rIdx++) {
                const r = roots[rIdx];
                if (!r || r.nodeType !== 1 || r.isConnected === false) continue;
                if (typeof r.closest === "function" && r.closest(PILL_SKIP_ANCESTOR_SEL)) continue;
                const inChat = typeof r.closest === "function" ? r.closest("[data-main-content-body]") : null;
                const inRev = Boolean(inChat && typeof r.closest === "function" && r.closest(PILL_REVIEW_OVERRIDE_SEL));
                if (inChat && !inRev) {
                    if (typeof r.querySelectorAll === "function") {
                        const reviews = r.querySelectorAll(PILL_REVIEW_OVERRIDE_SEL);
                        for (let j = 0; j < reviews.length; j++) walkPruned(reviews[j], true);
                    }
                    continue;
                }
                walkPruned(r, inRev);
            }
        } else {
            const scanRoot = docRef.body && docRef.body.nodeType === 1 ? docRef.body : docRef;
            if (scanRoot && scanRoot.children && scanRoot.children.length > 0) {
                for (let i = 0; i < scanRoot.children.length; i++) walkPruned(scanRoot.children[i], false);
            } else if (scanRoot && typeof scanRoot.querySelectorAll === "function") {
                const list = scanRoot.querySelectorAll(PILL_TAG_SEL);
                for (let j = 0; j < list.length; j++) candidates.push(list[j]);
            }
        }

        // Phase 1 (Style Read ONLY — NO getBoundingClientRect!): filter out ~95%+ transparent / matching elements cheaply
        const sizeCandidates = [];
        for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (!el || el.nodeType !== 1) continue;
            if (el.id === "agy-wp-shadow-host" || el.id === "agy-extras-shadow-host" || el.id === "agy-wallpaper-layer" || el.id === "root" || el.id === "app") continue;
            if (typeof el.getAttribute === "function" && el.getAttribute("data-agy-light-fix") && el.getAttribute("data-agy-pill-surface") === surfaceKey) {
                continue;
            }
            if (typeof el.matches === "function" && el.matches(PILL_SKIP_MATCH_SEL)) continue;
            if (typeof el.closest === "function") {
                if (el.closest(PILL_SKIP_ANCESTOR_SEL)) continue;
                const chatEl = el.closest("[data-main-content-body]");
                if (chatEl) {
                    const reviewEl = el.closest(PILL_REVIEW_OVERRIDE_SEL);
                    const insideEmbeddedReview = Boolean(reviewEl && reviewEl !== chatEl && (typeof chatEl.contains !== "function" || chatEl.contains(reviewEl)));
                    if (!insideEmbeddedReview) continue;
                }
            }
            if (!el.textContent || !el.textContent.trim()) continue;
            try {
                const parsed = parseCssColorWithAlpha(getComputedStyle(el).backgroundColor, docRef);
                if (!parsed || !Number.isFinite(parsed.a) || parsed.a < 0.05) continue;
                const bgRgb = parsed.rgb;
                const chroma = Math.max(bgRgb[0], bgRgb[1], bgRgb[2]) - Math.min(bgRgb[0], bgRgb[1], bgRgb[2]);
                if (chroma > 55) continue;
                const accDist = Math.abs(bgRgb[0] - accArr[0]) + Math.abs(bgRgb[1] - accArr[1]) + Math.abs(bgRgb[2] - accArr[2]);
                if (accDist < 65 && parsed.a > 0.55) continue;
                const lum = relativeLuminance(bgRgb);
                const invertedInLight = isLight && lum < 0.30;
                const invertedInDark = !isLight && lum > 0.42;
                if (invertedInLight || invertedInDark) {
                    sizeCandidates.push(el);
                }
            } catch {}
        }

        // Phase 2 (Layout Read ONLY on the tiny inverted-background subset)
        const toTag = [];
        for (let i = 0; i < sizeCandidates.length; i++) {
            const el = sizeCandidates[i];
            try {
                if (typeof el.getBoundingClientRect === "function") {
                    const r = el.getBoundingClientRect();
                    const isStickyOrHdr = el.tagName === "HEADER" || (typeof el.getAttribute === "function" && el.getAttribute("data-agy-sticky-header") === "1");
                    const maxH = isStickyOrHdr ? 180 : 96;
                    if (r && (r.height > maxH || (r.height > 0 && r.height < 12) || (r.width > 0 && r.width < 12))) continue;
                }
                toTag.push(el);
            } catch {}
        }

        // Phase 3 (Batched Write Phase — ZERO interleaved reads!)
        for (let i = 0; i < staleRemovals.length; i++) {
            try {
                staleRemovals[i].removeAttribute("data-agy-light-fix");
                staleRemovals[i].removeAttribute("data-agy-pill-surface");
            } catch {}
        }
        let fixed = 0;
        const toTagSet = new Set(toTag);
        for (let i = 0; i < toTag.length; i++) {
            const el = toTag[i];
            try {
                let hasFixedAncestor = Boolean(typeof el.parentElement?.closest === "function" && el.parentElement.closest("[data-agy-light-fix]"));
                if (!hasFixedAncestor) {
                    let anc = el.parentElement;
                    while (anc && anc.nodeType === 1) {
                        if (toTagSet.has(anc)) { hasFixedAncestor = true; break; }
                        anc = anc.parentElement;
                    }
                }
                const nextFix = hasFixedAncestor ? "2" : "1";
                if (el.getAttribute("data-agy-light-fix") !== nextFix) el.setAttribute("data-agy-light-fix", nextFix);
                if (el.getAttribute("data-agy-pill-surface") !== surfaceKey) el.setAttribute("data-agy-pill-surface", surfaceKey);
                fixed++;
            } catch {}
        }
        return fixed;
    }

    function syncPanelSurfaces(docRef = document) {
        if (!docRef || !docRef.querySelectorAll) return 0;
        let tagged = 0;
        const nextModal = new Set();
        const nextBackdrop = new Set();
        const nextSticky = new Set();
        const nextLauncher = new Set();
        const nextClearBdRoot = new Set();
        const nextPosRel = new Set();
        const nextInnerClear = new Set();
        const nextCardClear = new Set();
        const vw = typeof window !== "undefined" && Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 1280;
        const vh = typeof window !== "undefined" && Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 800;

        const FLOATING_HOST_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .settings-modal-container, [data-testid="settings-modal"], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-radix-dialog-content], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-menu-content], [data-radix-popper-content-wrapper] > *, [data-slot="popover-content"], [data-slot="hover-card-content"], [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="context-menu-content"], [data-slot="select-content"], [data-slot="tooltip-content"], [data-slot="combobox-content"], [data-radix-popover-content], [data-radix-hover-card-content], [data-radix-select-content], [data-agy-surface-panel]';

        // === PHASE 1: ALL DOM / STYLE / LAYOUT READS (ZERO WRITES!) ===
        try {
            const sidebars = docRef.querySelectorAll('[data-testid="settings-sidebar"]');
            for (let i = 0; i < sidebars.length; i++) {
                const sb = sidebars[i];
                let cur = sb && sb.parentElement;
                let modalRoot = null;
                for (let d = 0; d < 5 && cur && cur.nodeType === 1; d++, cur = cur.parentElement) {
                    if (cur === docRef.body || cur === docRef.documentElement || cur.id === "root" || cur.id === "app") break;
                    if (typeof cur.matches === "function" && cur.matches('.agy-shell, .agy-inset-shell, [data-tiling-pane]')) break;
                    if (typeof cur.matches === "function" && cur.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .settings-modal-container, [data-testid="settings-modal"]')) {
                        modalRoot = cur;
                        break;
                    }
                    let isCompact = true;
                    if (typeof cur.getBoundingClientRect === "function") {
                        const r = cur.getBoundingClientRect();
                        if (r && r.width >= vw * 0.96 && r.height >= vh * 0.96) isCompact = false;
                    }
                    if (isCompact) modalRoot = cur;
                }
                if (modalRoot) {
                    if (typeof modalRoot.matches !== "function" || !modalRoot.matches('[role="dialog"], .settings-modal-container, [data-testid="settings-modal"]')) {
                        nextModal.add(modalRoot);
                    }
                }
            }
        } catch {}

        const dialogNodes = [];
        try {
            const rawDialogs = docRef.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .settings-modal-container, [data-testid="settings-modal"], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-radix-dialog-content]');
            for (let i = 0; i < rawDialogs.length; i++) {
                const dlg = rawDialogs[i];
                if (!dlg || dlg.nodeType !== 1) continue;
                if (typeof dlg.closest === "function" && dlg.closest("#agy-wp-shadow-host, #agy-extras-shadow-host")) continue;
                dialogNodes.push(dlg);
                let cur = dlg.parentElement;
                for (let d = 0; d < 3 && cur && cur.nodeType === 1; d++, cur = cur.parentElement) {
                    if (cur === docRef.body || cur === docRef.documentElement || cur.id === "root" || cur.id === "app") break;
                    if (typeof cur.matches === "function" && cur.matches('[data-slot="dialog-overlay"], [data-radix-dialog-overlay]')) {
                        nextBackdrop.add(cur);
                        continue;
                    }
                    if (typeof cur.getBoundingClientRect === "function") {
                        const pr = cur.getBoundingClientRect();
                        if (pr && pr.width >= vw * 0.88 && pr.height >= vh * 0.88) {
                            nextBackdrop.add(cur);
                        }
                    }
                }
                const ovs = (dlg.parentElement || docRef).querySelectorAll('[data-slot="dialog-overlay"], [data-radix-dialog-overlay]');
                for (let j = 0; j < ovs.length; j++) nextBackdrop.add(ovs[j]);
            }
            for (const m of nextModal) {
                const p = m.parentElement;
                if (p && p.nodeType === 1 && p !== docRef.body && p !== docRef.documentElement && p.id !== "root" && p.id !== "app" && typeof p.getBoundingClientRect === "function") {
                    const pr = p.getBoundingClientRect();
                    if (pr && pr.width >= vw * 0.88 && pr.height >= vh * 0.88) nextBackdrop.add(p);
                }
            }
        } catch {}

        try {
            const modalCandidates = new Set(dialogNodes);
            for (const m of nextModal) modalCandidates.add(m);
            for (const m of modalCandidates) {
                if (!m || typeof m.querySelectorAll !== "function") continue;
                const hasSettingsSel = (typeof m.matches === "function" && m.matches('.settings-modal-container, [data-testid="settings-modal"]'))
                    || Boolean(m.querySelector('[data-testid="settings-sidebar"], [data-main-content-body]'));
                let isSettingsModal = hasSettingsSel;
                if (!isSettingsModal && m.querySelector('.sticky, [class*="sticky"], [class*="overflow-y-auto"]')) {
                    const mRect = typeof m.getBoundingClientRect === "function" ? m.getBoundingClientRect() : null;
                    if (mRect && mRect.height >= 320) isSettingsModal = true;
                }
                if (isSettingsModal) {
                    const hdrs = m.querySelectorAll('.sticky, [class*="sticky"]');
                    for (let j = 0; j < hdrs.length; j++) {
                        if (hdrs[j] && hdrs[j].nodeType === 1) nextSticky.add(hdrs[j]);
                    }
                    const topHdr = m.querySelector('header');
                    if (topHdr && topHdr.nodeType === 1 && m.querySelector('[data-testid="settings-sidebar"]')) {
                        nextSticky.add(topHdr);
                    }
                }
            }
        } catch {}

        try {
            const inputs = docRef.querySelectorAll("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='range'])");
            for (let i = 0; i < inputs.length; i++) {
                const inp = inputs[i];
                if (!inp || inp.nodeType !== 1) continue;
                if (typeof inp.closest === "function" && inp.closest('[data-main-content-body], .surface-composer, [role="dialog"], [role="alertdialog"], .settings-modal-container, [data-testid="settings-modal"], [aria-label="Sidebar"], [data-testid="title-menu-bar"], #agy-wp-shadow-host, #agy-extras-shadow-host, .monaco-editor, .cm-editor, [cmdk-dialog], [cmdk-root], .quick-input-widget')) {
                    continue;
                }
                let cur = inp.parentElement;
                let best = null;
                for (let d = 0; d < 6 && cur && cur.nodeType === 1; d++, cur = cur.parentElement) {
                    if (cur === docRef.body || cur === docRef.documentElement || cur.id === "root" || cur.id === "app") break;
                    if (typeof cur.matches === "function" && cur.matches('[data-tiling-pane], [data-pane-id], [data-main-content-body], .agy-shell, .agy-sheet, .agy-inset-shell')) break;
                    if (typeof cur.querySelectorAll === "function") {
                        const items = cur.querySelectorAll('button, a, [role="option"], [role="menuitem"], [cmdk-item]');
                        if (items && items.length >= 2) {
                            if (typeof cur.getBoundingClientRect === "function") {
                                const r = cur.getBoundingClientRect();
                                if (r && r.width > 0 && r.height > 0 && (r.width >= vw * 0.82 || r.height >= vh * 0.85)) break;
                            }
                            best = cur;
                            break;
                        }
                    }
                }
                if (best) nextLauncher.add(best);
            }
        } catch {}

        try {
            if (typeof getComputedStyle === "function") {
                const panelSet = new Set(docRef.querySelectorAll(FLOATING_HOST_SEL));
                for (const m of nextModal) panelSet.add(m);
                for (const l of nextLauncher) panelSet.add(l);
                const checkedAncestors = new Set();
                for (const panel of panelSet) {
                    if (!panel || panel.nodeType !== 1) continue;
                    if (typeof panel.closest === "function" && panel.closest("#agy-wp-shadow-host, #agy-extras-shadow-host, #agy-wallpaper-layer")) continue;
                    const pcs = getComputedStyle(panel);
                    if (pcs && pcs.position === "static") {
                        nextPosRel.add(panel);
                    }
                    let anc = panel.parentElement;
                    while (anc && anc.nodeType === 1 && anc !== docRef.body && anc !== docRef.documentElement) {
                        if (anc.id === "agy-wp-shadow-host" || anc.id === "agy-extras-shadow-host" || anc.id === "agy-wallpaper-layer") break;
                        if (!checkedAncestors.has(anc)) {
                            checkedAncestors.add(anc);
                            if (typeof anc.matches !== "function" || !anc.matches(FLOATING_HOST_SEL)) {
                                const acs = getComputedStyle(anc);
                                if (acs) {
                                    const hasBd = (acs.backdropFilter && acs.backdropFilter !== "none") || (acs.webkitBackdropFilter && acs.webkitBackdropFilter !== "none");
                                    const hasOp = acs.opacity && parseFloat(acs.opacity) < 0.999 && !anc.classList?.contains?.("animate-pulse");
                                    const hasFlt = acs.filter && acs.filter !== "none";
                                    const hasClip = (acs.clipPath && acs.clipPath !== "none") || (acs.maskImage && acs.maskImage !== "none");
                                    const hasBlend = acs.mixBlendMode && acs.mixBlendMode !== "normal";
                                    if (hasBd || hasOp || hasFlt || hasClip || hasBlend) {
                                        nextClearBdRoot.add(anc);
                                    }
                                }
                            }
                        }
                        anc = anc.parentElement;
                    }
                }

                const hostContainers = new Set(docRef.querySelectorAll('[role="dialog"], [role="alertdialog"], .settings-modal-container, [data-testid="settings-modal"], [data-agy-surface-panel="modal"], [role="menu"], [data-slot="hover-card-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="popover-content"]'));
                for (const m of nextModal) hostContainers.add(m);
                const INNER_SKIP_SEL = FLOATING_HOST_SEL + ', [data-testid="settings-sidebar"], button, a, input, select, textarea, [role="switch"], [role="button"], .bg-card, [data-diff-type], .monaco-editor, .cm-editor';
                for (const hc of hostContainers) {
                    if (!hc || typeof hc.querySelectorAll !== "function") continue;
                    if (typeof hc.closest === "function" && hc.closest("#agy-wp-shadow-host, #agy-extras-shadow-host")) continue;
                    const inners = hc.querySelectorAll("div, section, main, aside, header, footer");
                    for (let j = 0; j < inners.length; j++) {
                        const el = inners[j];
                        if (!el || el.nodeType !== 1) continue;
                        if (nextSticky.has(el)) continue;
                        if (!el.children || el.children.length === 0) continue;
                        if (typeof el.matches === "function" && el.matches(INNER_SKIP_SEL)) continue;
                        if (typeof el.closest === "function" && el.closest('button, [role="switch"], [data-diff-type], .monaco-editor, .cm-editor')) continue;
                        const cs = getComputedStyle(el);
                        const parsed = cs ? parseCssColorWithAlpha(cs.backgroundColor, docRef) : null;
                        if (!parsed || !Number.isFinite(parsed.a) || parsed.a < 0.35) continue;
                        const rgb = parsed.rgb;
                        const chroma = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
                        if (chroma > 45) continue;
                        const lum = relativeLuminance(rgb);
                        if (lum > 0.72 || lum < 0.14) {
                            const hasBorder = cs && (parseFloat(cs.borderTopWidth || "0") > 0 || parseFloat(cs.borderLeftWidth || "0") > 0);
                            if (hasBorder && el.parentElement !== hc) {
                                nextCardClear.add(el);
                            } else {
                                nextInnerClear.add(el);
                            }
                        }
                    }
                }
            }
        } catch {}

        // === PHASE 2: ALL DOM WRITES BATCHED & DIFF-CHECKED (ZERO REFLOW THRASH!) ===
        const setAttrIfDiff = (el, attr, val) => {
            if (el.getAttribute(attr) !== val) el.setAttribute(attr, val);
        };
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-surface-panel]'))) {
            const curVal = el.getAttribute("data-agy-surface-panel");
            if ((curVal === "modal" && !nextModal.has(el)) || (curVal === "launcher" && !nextLauncher.has(el))) {
                el.removeAttribute("data-agy-surface-panel");
            }
        }
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-modal-backdrop="1"]'))) {
            if (!nextBackdrop.has(el)) el.removeAttribute("data-agy-modal-backdrop");
        }
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-sticky-header="1"]'))) {
            if (!nextSticky.has(el)) el.removeAttribute("data-agy-sticky-header");
        }
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-clear-bd-root="1"]'))) {
            if (!nextClearBdRoot.has(el)) el.removeAttribute("data-agy-clear-bd-root");
        }
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-pos-rel="1"]'))) {
            if (!nextPosRel.has(el)) el.removeAttribute("data-agy-pos-rel");
        }
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-panel-inner-clear="1"]'))) {
            if (!nextInnerClear.has(el)) el.removeAttribute("data-agy-panel-inner-clear");
        }
        for (const el of Array.from(docRef.querySelectorAll('[data-agy-panel-card-clear="1"]'))) {
            if (!nextCardClear.has(el)) el.removeAttribute("data-agy-panel-card-clear");
        }

        for (const el of nextModal) { setAttrIfDiff(el, "data-agy-surface-panel", "modal"); tagged++; }
        for (const el of nextBackdrop) { setAttrIfDiff(el, "data-agy-modal-backdrop", "1"); tagged++; }
        for (const el of nextSticky) { setAttrIfDiff(el, "data-agy-sticky-header", "1"); tagged++; }
        for (const el of nextLauncher) { setAttrIfDiff(el, "data-agy-surface-panel", "launcher"); tagged++; }
        for (const el of nextClearBdRoot) { setAttrIfDiff(el, "data-agy-clear-bd-root", "1"); tagged++; }
        for (const el of nextPosRel) { setAttrIfDiff(el, "data-agy-pos-rel", "1"); tagged++; }
        for (const el of nextInnerClear) { setAttrIfDiff(el, "data-agy-panel-inner-clear", "1"); tagged++; }
        for (const el of nextCardClear) { setAttrIfDiff(el, "data-agy-panel-card-clear", "1"); tagged++; }
        return tagged;
    }

    function inspectBackdropChain(targetOrSelector) {
        const el = typeof targetOrSelector === "string"
            ? document.querySelector(targetOrSelector)
            : targetOrSelector;
        if (!el || typeof getComputedStyle !== "function") return [];
        const chain = [];
        let cur = el;
        while (cur && cur.nodeType === 1) {
            const cs = getComputedStyle(cur);
            const bf = cs.backdropFilter || cs.webkitBackdropFilter || "none";
            const op = parseFloat(cs.opacity || "1");
            const flt = cs.filter || "none";
            const clip = cs.clipPath || "none";
            const mask = cs.maskImage || "none";
            const blend = cs.mixBlendMode || "normal";
            const blocks = cur !== el && (
                bf !== "none" || op < 0.999 || flt !== "none" || clip !== "none" || mask !== "none" || blend !== "normal"
            );
            chain.push({
                tag: cur.tagName.toLowerCase(),
                id: cur.id || "",
                role: cur.getAttribute("role") || "",
                slot: cur.getAttribute("data-slot") || "",
                className: typeof cur.className === "string" ? cur.className.slice(0, 80) : "",
                styles: {
                    backgroundColor: cs.backgroundColor,
                    backdropFilter: bf,
                    opacity: cs.opacity,
                    transform: cs.transform,
                    filter: flt,
                    isolation: cs.isolation,
                    contain: cs.contain,
                    overflow: cs.overflow,
                    clipPath: clip,
                    maskImage: mask,
                    willChange: cs.willChange,
                    position: cs.position,
                    zIndex: cs.zIndex,
                },
                blocksBackdropFilter: blocks,
            });
            cur = cur.parentElement;
        }
        return chain;
    }

    let dirtySyntaxRoots = new Set();
    let dirtyPillRoots = new Set();
    let dirtyFullSyntax = false;
    let dirtyFullPills = false;
    let dirtyEditorScan = false;
    let dirtySurfaceScan = false;

    function scheduleCodeSyntaxAdapt(opts = null) {
        const full = !opts || opts.full === true;
        if (full) {
            dirtyFullSyntax = true;
            dirtyFullPills = true;
            dirtyEditorScan = true;
            dirtySurfaceScan = true;
            dirtySyntaxRoots.clear();
            dirtyPillRoots.clear();
        } else {
            if (opts.editor) dirtyEditorScan = true;
            if (opts.surfaces) dirtySurfaceScan = true;
            if (opts.syntaxRoot) dirtySyntaxRoots.add(opts.syntaxRoot);
            if (opts.pillRoot) dirtyPillRoots.add(opts.pillRoot);
            if (opts.fullSyntax) dirtyFullSyntax = true;
            if (opts.fullPills) dirtyFullPills = true;
        }
        if (codeAdaptScheduled) return;
        codeAdaptScheduled = true;
        const run = () => {
            codeAdaptScheduled = false;
            const doEditor = dirtyEditorScan;
            const doSurface = dirtySurfaceScan;
            const doFullSyntax = dirtyFullSyntax;
            const doFullPills = dirtyFullPills;
            const syntaxRoots = doFullSyntax ? null : (dirtySyntaxRoots.size > 0 ? Array.from(dirtySyntaxRoots) : null);
            const pillRoots = doFullPills ? null : (dirtyPillRoots.size > 0 ? Array.from(dirtyPillRoots) : null);
            dirtyEditorScan = false;
            dirtySurfaceScan = false;
            dirtyFullSyntax = false;
            dirtyFullPills = false;
            dirtySyntaxRoots.clear();
            dirtyPillRoots.clear();
            try {
                if (doEditor) syncEditorPaneTags(document);
                if (doSurface) syncPanelSurfaces(document);
                if (doFullSyntax || syntaxRoots || doFullPills || pillRoots) {
                    const pal = computeResolvedPalette();
                    if (doFullSyntax || syntaxRoots) adaptCodeSyntaxColors(document, doFullSyntax ? null : syntaxRoots, pal);
                    if (doFullPills || pillRoots) syncLightDarkPills(document, pal, doFullPills ? null : pillRoots);
                }
            } catch {}
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 16);
    }

    let lastPrivacySyncSig = "";
    let lastSurfaceSyntaxSig = "";
    let pendingDeferredDomSync = false;

    function computeWallpaperBoostAndScrim(isLightSurface, highContrast) {
        const plainBg = state.wallpaperEnabled === false;
        const safeDarkLuma = Number.isFinite(Number(state.wallpaperDarkLuma)) ? Number(state.wallpaperDarkLuma) : 255;
        const safeBrightLuma = Number.isFinite(Number(state.wallpaperBrightLuma)) ? Number(state.wallpaperBrightLuma) : 0;
        const rawBoost = (!plainBg && state.autoContrast)
            ? (isLightSurface
                ? getContrastBoost(255 - safeDarkLuma, state.dim)
                : getContrastBoost(safeBrightLuma, state.dim))
            : 0;
        const boost = (!plainBg && state.autoContrast && isLightSurface && !state.wallpaperSampled)
            ? Math.max(rawBoost, Math.max(0, 0.42 - state.dim))
            : rawBoost;
        state.lumaBoost = boost;
        const effScrimOpacity = plainBg ? 0 : computeEffectiveScrimOpacity(state.dim, boost, highContrast);
        return { plainBg, boost, effScrimOpacity };
    }

    function applyWallpaperLayerVarsFast(skipRootVars = false) {
        const docEl = document.documentElement;
        const root = docEl.style;
        const isLightSurface = docEl.dataset?.agySurface === "light";
        const highContrast = state.uiContrast === "high";
        const { boost, effScrimOpacity } = computeWallpaperBoostAndScrim(isLightSurface, highContrast);
        const scrimOpStr = effScrimOpacity.toFixed(3);
        // Apply directly to isolated #agy-wallpaper-layer (contain: strict) so slider drags incur ZERO full-document Style Recalc!
        if (scrim && scrim.style && scrim.style.opacity !== scrimOpStr) {
            scrim.style.setProperty("opacity", scrimOpStr, "important");
        }
        if (!skipRootVars) {
            setRootVar(root, "--agy-wp-dim", String(state.dim));
            setRootVar(root, "--agy-video-blur", state.videoBlur + "px");
            setRootVar(root, "--agy-video-blur-num", String(state.videoBlur));
            setRootVar(root, "--agy-scrim-opacity", scrimOpStr);
            setRootVar(root, "--agy-luma-boost", boost.toFixed(3));
            setRootVar(root, "--agy-video-sat", String(state.videoSat));
            setRootVar(root, "--agy-video-contrast", String(state.videoContrast));
            setRootVar(root, "--agy-video-fit", state.videoFit);
        }
        applyVideoFilterFast();
        applyVideoAudio();
        if (typeof updateLumaBadge === "function") updateLumaBadge(isLightSurface);
    }

    let visualUpdateRaf = 0;
    const visualDirty = {
        wallpaperOnly: false,
        wallpaperDrag: false,
        tokens: false,
        deferDomSync: false,
        forceDomSync: false,
        forcePrivacy: false,
    };

    function flushScheduledVisualUpdate() {
        visualUpdateRaf = 0;
        const doTokens = visualDirty.tokens || visualDirty.forceDomSync || visualDirty.forcePrivacy;
        const doWp = visualDirty.wallpaperOnly;
        const wpDrag = visualDirty.wallpaperDrag;
        const deferDomSync = visualDirty.deferDomSync && !visualDirty.forceDomSync;
        const forceDomSync = visualDirty.forceDomSync;
        const forcePrivacy = visualDirty.forcePrivacy;
        visualDirty.wallpaperOnly = false;
        visualDirty.wallpaperDrag = false;
        visualDirty.tokens = false;
        visualDirty.deferDomSync = false;
        visualDirty.forceDomSync = false;
        visualDirty.forcePrivacy = false;

        if (doTokens) {
            applyVisualVars({ deferDomSync, forceDomSync, forcePrivacy });
        } else if (doWp) {
            applyWallpaperLayerVarsFast(wpDrag);
        }
    }

    function scheduleVisualUpdate(flags = {}) {
        if (flags.wallpaperOnly) visualDirty.wallpaperOnly = true;
        if (flags.wallpaperDrag) visualDirty.wallpaperDrag = true;
        if (flags.tokens) visualDirty.tokens = true;
        if (flags.deferDomSync) visualDirty.deferDomSync = true;
        if (flags.forceDomSync) {
            visualDirty.forceDomSync = true;
            visualDirty.deferDomSync = false;
        }
        if (flags.forcePrivacy) visualDirty.forcePrivacy = true;
        if (visualUpdateRaf) return;
        if (typeof requestAnimationFrame === "function") {
            visualUpdateRaf = requestAnimationFrame(flushScheduledVisualUpdate);
        } else {
            flushScheduledVisualUpdate();
        }
    }

    function applyVisualVars(opts = null) {
        const docEl = document.documentElement;
        const root = docEl.style;
        const pal = computeResolvedPalette();
        const surfaceName = pal.isLightSurface ? "light" : "dark";
        const contrastName = pal.highContrast ? "high" : "default";

        setRootFlag(docEl, "agyThemeMode", pal.effectiveMode);
        setRootFlag(docEl, "agySurface", surfaceName);
        setRootFlag(docEl, "agyContrast", contrastName);
        if (lastColorScheme !== surfaceName) {
            lastColorScheme = surfaceName;
            root.colorScheme = surfaceName;
        }

        setRootVar(root, "--agy-tint-rgb", pal.tintRgb);
        setRootVar(root, "--agy-fg", pal.fg);
        setRootVar(root, "--agy-fg-secondary", pal.fgSecondary);
        setRootVar(root, "--agy-fg-muted", pal.fgMuted);
        setRootVar(root, "--agy-fg-subtle", pal.fgSubtle);
        setRootVar(root, "--agy-border", pal.border);
        setRootVar(root, "--agy-border-strong", pal.borderStrong);
        setRootVar(root, "--agy-divider", pal.divider);
        setRootVar(root, "--agy-hover-bg", pal.hoverBg);
        setRootVar(root, "--agy-subtle-bg", pal.subtleBg);
        setRootVar(root, "--agy-subtle-bg-strong", pal.subtleBgStrong);
        setRootVar(root, "--agy-backdrop-bg", pal.backdropBg);
        setRootVar(root, "--agy-nav-bg", pal.navBg);
        setRootVar(root, "--agy-card-bg", pal.cardBg);
        setRootVar(root, "--agy-scrim-color", pal.scrimColor);
        setRootVar(root, "--agy-scrollbar-thumb", pal.scrollbarThumb);
        setRootVar(root, "--agy-scrollbar-thumb-hover", pal.scrollbarThumbHover);
        setRootVar(root, "--agy-shadow-panel", pal.shadowPanel);
        setRootVar(root, "--agy-shadow-card", pal.shadowCard);
        setRootVar(root, "--agy-shadow-card-focus", pal.shadowCardFocus);
        setRootVar(root, "--agy-danger-fg", pal.dangerFg);
        setRootVar(root, "--agy-warn-fg", pal.warnFg);
        setRootVar(root, "--agy-ok-fg", pal.okFg);
        setRootVar(root, "--agy-code-fg", pal.codeFg);
        setRootVar(root, "--agy-diff-add-bg", pal.diffAddBg);
        setRootVar(root, "--agy-diff-add-word-bg", pal.diffAddWordBg);
        setRootVar(root, "--agy-diff-add-border", pal.diffAddBorder);
        setRootVar(root, "--agy-diff-add-fg", pal.diffAddFg);
        setRootVar(root, "--agy-diff-del-bg", pal.diffDelBg);
        setRootVar(root, "--agy-diff-del-word-bg", pal.diffDelWordBg);
        setRootVar(root, "--agy-diff-del-border", pal.diffDelBorder);
        setRootVar(root, "--agy-diff-del-fg", pal.diffDelFg);

        setRootVar(root, "--foreground", pal.fg, true);
        setRootVar(root, "--color-foreground", pal.fg, true);
        setRootVar(root, "--card-foreground", pal.fg, true);
        setRootVar(root, "--color-card-foreground", pal.fg, true);
        setRootVar(root, "--popover-foreground", pal.fg, true);
        setRootVar(root, "--color-popover-foreground", pal.fg, true);
        setRootVar(root, "--sidebar-foreground", pal.fg, true);
        setRootVar(root, "--color-sidebar-foreground", pal.fg, true);
        setRootVar(root, "--secondary-foreground", pal.fgSecondary, true);
        setRootVar(root, "--color-secondary-foreground", pal.fgSecondary, true);
        setRootVar(root, "--muted-foreground", pal.fgMuted, true);
        setRootVar(root, "--color-muted-foreground", pal.fgMuted, true);
        setRootVar(root, "--border", pal.border, true);
        setRootVar(root, "--color-border", pal.border, true);
        setRootVar(root, "--input", pal.border, true);
        setRootVar(root, "--color-input", pal.border, true);
        setRootVar(root, "--card-border", pal.border, true);
        setRootVar(root, "--color-card-border", pal.border, true);
        setRootVar(root, "--card-edge", pal.divider, true);
        setRootVar(root, "--sidebar-border", pal.divider, true);
        setRootVar(root, "--color-sidebar-border", pal.divider, true);
        setRootVar(root, "--secondary", pal.subtleBg, true);
        setRootVar(root, "--color-secondary", pal.subtleBg, true);
        setRootVar(root, "--sidebar-muted", pal.subtleBg, true);
        setRootVar(root, "--color-sidebar-muted", pal.subtleBg, true);
        setRootVar(root, "--glass-border", pal.border, true);
        setRootVar(root, "--glass-highlight", pal.hoverBg, true);

        const { plainBg, boost, effScrimOpacity } = computeWallpaperBoostAndScrim(pal.isLightSurface, pal.highContrast);

        // Keep Panel Opacity directly responsive to the user's slider across ALL surface layers (never clamped by autoContrast or reduceBackdropBlur)
        const layers = pal.layers || computeSurfaceLayers(state.panelAlpha, pal.highContrast);
        const effAlpha = Math.min(1, layers.panelAlpha + (pal.highContrast ? 0.04 * (1 - layers.panelAlpha) : 0));
        const blurSkip = !state.reduceBackdropBlur && (pal.panelBlurPx <= 0 || layers.panelAlpha >= 0.96);
        const effectiveBlurPx = (state.reduceBackdropBlur || blurSkip) ? 0 : pal.panelBlurPx;
        const baseAlphaStr = layers.baseAlpha.toFixed(3);
        const sidebarAlphaStr = layers.sidebarAlpha.toFixed(3);
        const cardAlphaStr = layers.cardAlpha.toFixed(3);
        const composerAlphaStr = layers.composerAlpha.toFixed(3);
        const editorAlphaStr = layers.editorAlpha.toFixed(3);
        const modalAlphaStr = layers.modalAlpha.toFixed(3);
        const surfBase = "rgba(" + pal.tintRgb + ", " + baseAlphaStr + ")";
        const surfSidebar = "rgba(" + pal.tintRgb + ", " + sidebarAlphaStr + ")";
        const surfCard = "rgba(" + pal.tintRgb + ", " + cardAlphaStr + ")";
        const surfComposer = "rgba(" + pal.tintRgb + ", " + composerAlphaStr + ")";
        const surfEditor = "rgba(" + pal.tintRgb + ", " + editorAlphaStr + ")";
        const surfModal = "rgba(" + pal.tintRgb + ", " + modalAlphaStr + ")";

        setRootVar(root, "--background", "transparent", true);
        setRootVar(root, "--color-background", "transparent", true);
        setRootVar(root, "--shell", "transparent", true);
        setRootVar(root, "--shell-canvas", "transparent", true);
        setRootVar(root, "--body-background", "transparent", true);
        setRootVar(root, "--agy-wp-dim", String(state.dim));
        setRootVar(root, "--agy-video-blur", state.videoBlur + "px");
        setRootVar(root, "--agy-video-blur-num", String(state.videoBlur));
        setRootVar(root, "--agy-panel-alpha", String(layers.panelAlpha));
        setRootVar(root, "--agy-panel-blur", effectiveBlurPx + "px");
        setRootVar(root, "--agy-effective-alpha", effAlpha.toFixed(3));
        setRootVar(root, "--agy-surface-base-alpha", baseAlphaStr);
        setRootVar(root, "--agy-surface-sidebar-alpha", sidebarAlphaStr);
        setRootVar(root, "--agy-surface-card-alpha", cardAlphaStr);
        setRootVar(root, "--agy-surface-composer-alpha", composerAlphaStr);
        setRootVar(root, "--agy-surface-editor-alpha", editorAlphaStr);
        setRootVar(root, "--agy-surface-modal-alpha", modalAlphaStr);
        setRootVar(root, "--agy-surface-base", surfBase);
        setRootVar(root, "--agy-surface-sidebar", surfSidebar);
        setRootVar(root, "--agy-surface-card", surfCard);
        setRootVar(root, "--agy-surface-composer", surfComposer);
        setRootVar(root, "--agy-surface-editor", surfEditor);
        setRootVar(root, "--agy-surface-modal", pal.surfaceDialog || surfModal);
        setRootVar(root, "--agy-surface-dialog", pal.surfaceDialog || surfModal);
        setRootVar(root, "--agy-surface-popover", pal.surfacePopover);
        setRootVar(root, "--agy-surface-sticky", pal.surfaceSticky || pal.surfacePopover);
        setRootVar(root, "--agy-hc-scrim-lift", String(layers.hcScrimLift));
        const scrimOpStr = effScrimOpacity.toFixed(3);
        setRootVar(root, "--agy-scrim-opacity", scrimOpStr);
        if (scrim && scrim.style && scrim.style.opacity !== scrimOpStr) {
            scrim.style.setProperty("opacity", scrimOpStr, "important");
        }
        setRootVar(root, "--agy-luma-boost", boost.toFixed(3));
        setRootVar(root, "--agy-video-sat", String(state.videoSat));
        setRootVar(root, "--agy-video-contrast", String(state.videoContrast));
        setRootVar(root, "--agy-video-fit", state.videoFit);

        if (state.uiFontChoice) {
            setRootVar(root, "--agy-ui-font", state.uiFontChoice);
            setRootVar(root, "--font-sans", state.uiFontChoice, true);
            setRootVar(root, "--font-ui", state.uiFontChoice, true);
        }
        const fSize = Math.max(12, Math.min(18, Number(state.fontSizePx) || 14));
        const fontScale = (fSize / 14).toFixed(4);
        setRootVar(root, "--agy-base-font-size", fSize + "px");
        setRootVar(root, "--agy-font-scale", fontScale);

        const parsedRad = Number(state.radiusPx);
        const r = Number.isFinite(parsedRad) ? Math.max(0, Math.min(18, Math.round(parsedRad))) : DEFAULTS.radiusPx;
        const rSm = Math.max(0, Math.round(r * 0.72));
        setRootVar(root, "--agy-radius", r + "px");
        setRootVar(root, "--agy-radius-sm", rSm + "px");
        setRootVar(root, "--agy-radius-lg", r + "px");
        setRootVar(root, "--radius", r + "px", true);
        setRootVar(root, "--radius-sm", rSm + "px", true);
        setRootVar(root, "--radius-md", rSm + "px", true);
        setRootVar(root, "--radius-lg", r + "px", true);
        setRootVar(root, "--radius-xl", r + "px", true);
        setRootVar(root, "--radius-2xl", r + "px", true);
        setRootVar(root, "--radius-3xl", r + "px", true);
        setRootVar(root, "--nux-radius-sm", rSm + "px", true);
        setRootVar(root, "--nux-radius-md", r + "px", true);
        setRootVar(root, "--nux-radius-lg", r + "px", true);
        setRootVar(root, "--nux-radius-xl", r + "px", true);

        const privFlag = state.privacyMode ? "1" : "0";
        const privReveal = state.privacyRevealMode || "modifier";
        const privStyle = state.privacyHideStyle || "blur";
        const privPaths = state.privacyHidePaths !== false ? "1" : "0";

        const extrasHost = document.getElementById("agy-extras-shadow-host");
        for (const el of [shadowHost, extrasHost]) {
            if (!el) continue;
            setHostVar(el, "--agy-tint-rgb", pal.tintRgb);
            setHostVar(el, "--agy-ui-font", state.uiFontChoice || BASE_THEME.uiFont);
            setHostVar(el, "--agy-radius", r + "px");
            setHostVar(el, "--agy-radius-sm", rSm + "px");
            setHostVar(el, "--agy-base-font-size", fSize + "px");
            setHostVar(el, "--agy-font-scale", fontScale);
            setHostVar(el, "--agy-surface-base-alpha", baseAlphaStr);
            setHostVar(el, "--agy-surface-sidebar-alpha", sidebarAlphaStr);
            setHostVar(el, "--agy-surface-card-alpha", cardAlphaStr);
            setHostVar(el, "--agy-surface-composer-alpha", composerAlphaStr);
            setHostVar(el, "--agy-surface-editor-alpha", editorAlphaStr);
            setHostVar(el, "--agy-surface-modal-alpha", modalAlphaStr);
            setHostVar(el, "--agy-surface-base", surfBase);
            setHostVar(el, "--agy-surface-sidebar", surfSidebar);
            setHostVar(el, "--agy-surface-card", surfCard);
            setHostVar(el, "--agy-surface-composer", surfComposer);
            setHostVar(el, "--agy-surface-editor", surfEditor);
            setHostVar(el, "--agy-surface-modal", surfModal);
            setHostVar(el, "--agy-effective-alpha", effAlpha.toFixed(3));
            setHostVar(el, "--m-fg", pal.fg);
            setHostVar(el, "--m-fg-sec", pal.fgSecondary);
            setHostVar(el, "--m-fg-muted", pal.fgMuted);
            setHostVar(el, "--m-fg-subtle", pal.fgSubtle);
            setHostVar(el, "--m-border", pal.border);
            setHostVar(el, "--m-border-strong", pal.borderStrong);
            setHostVar(el, "--m-divider", pal.divider);
            setHostVar(el, "--m-hover", pal.hoverBg);
            setHostVar(el, "--m-subtle", pal.subtleBg);
            setHostVar(el, "--m-subtle-strong", pal.subtleBgStrong);
            setHostVar(el, "--m-card-bg", pal.cardBg);
            setHostVar(el, "--m-nav-bg", pal.navBg);
            setHostVar(el, "--m-listbox-bg", pal.listBoxBg);
            setHostVar(el, "--m-shadow", pal.shadowPanel);
            setHostVar(el, "--m-backdrop", pal.backdropBg);
            setHostVar(el, "--m-backdrop-noblur", pal.backdropNoBlurBg);
            setHostVar(el, "--m-scroll-thumb", pal.scrollbarThumb);
            setHostVar(el, "--m-popover-bg", pal.surfacePopover);
            setHostVar(el, "--m-panel-bg", pal.surfaceDialog || pal.surfaceModal);
            setHostVar(el, "--m-panel-blur", effectiveBlurPx + "px");
            setHostVar(el, "--m-danger-fg", pal.dangerFg);
            setHostVar(el, "--m-warn-fg", pal.warnFg);
            setHostVar(el, "--m-ok-fg", pal.okFg);
            setHostVar(el, "--m-slider-thumb-bg", pal.sliderThumbBg);
            setHostVar(el, "--m-slider-thumb-shadow", pal.sliderThumbShadow);
            setHostFlag(el, "agyContrast", contrastName);
            setHostFlag(el, "agySurface", surfaceName);
            setHostFlag(el, "agyNoBlur", state.reduceBackdropBlur ? "1" : "0");
            setHostFlag(el, "agyBlurSkip", blurSkip ? "1" : "0");
            setHostFlag(el, "agyPrivacy", privFlag);
            setHostFlag(el, "agyPrivacyReveal", privReveal);
            setHostFlag(el, "agyPrivacyStyle", privStyle);
            setHostFlag(el, "agyPrivacyPaths", privPaths);
        }

        applyVideoFilterFast();
        applyVideoAudio();

        setRootFlag(docEl, "agyNoBlur", state.reduceBackdropBlur ? "1" : null);
        setRootFlag(docEl, "agyBlurSkip", blurSkip ? "1" : null);
        setRootFlag(docEl, "agyPlainBg", plainBg ? "1" : null);
        if (shadowHost) setHostFlag(shadowHost, "agyPlainBg", plainBg ? "1" : "0");
        setRootFlag(docEl, "agyReduceMotion", state.reduceMotion ? "1" : null);
        window.__agyShowTopTabBar = state.showTopTabBar !== false;
        setRootFlag(docEl, "agyNoTopbar", !window.__agyShowTopTabBar ? "1" : null);
        setRootFlag(docEl, "agyPrivacy", privFlag);
        setRootFlag(docEl, "agyPrivacyReveal", privReveal);
        setRootFlag(docEl, "agyPrivacyStyle", privStyle);
        setRootFlag(docEl, "agyPrivacyPaths", privPaths);
        if (!state.privacyMode || state.privacyRevealMode !== "modifier") {
            setRootFlag(docEl, "agyModHeld", null);
        }
        const sideAccBtn = document.getElementById("agy-accounts-side-btn");
        if (sideAccBtn) {
            const nextDisp = window.__agyShowTopTabBar ? "none" : "flex";
            if (sideAccBtn.style.display !== nextDisp) sideAccBtn.style.display = nextDisp;
        }

        const nextPrivacySig = privFlag + "|" + privReveal + "|" + privStyle + "|" + privPaths;
        if (nextPrivacySig !== lastPrivacySyncSig || (opts && opts.forcePrivacy)) {
            lastPrivacySyncSig = nextPrivacySig;
            window.dispatchEvent(new CustomEvent("agy-privacy-sync", {
                detail: {
                    privacyMode: !!state.privacyMode,
                    privacyRevealMode: privReveal,
                    privacyHideStyle: privStyle,
                    privacyHidePaths: state.privacyHidePaths !== false,
                },
            }));
        }

        const modalBackdropEl = shadowHost?.shadowRoot?.getElementById("backdrop");
        if (modalBackdropEl) {
            modalBackdropEl.classList.toggle("no-blur", !!state.reduceBackdropBlur);
        }
        applyWallpaperMediaState();
        if (typeof updateLumaBadge === "function") updateLumaBadge(pal.isLightSurface);
        if (typeof updatePanelBlurHint === "function") updatePanelBlurHint();

        const targetAccRgb = (plainBg || !state.adaptiveAccent)
            ? hexToRgbTriplet(resolveEffectiveAccentHex(), BASE_THEME.accentRgb)
            : (state.adaptiveRgb || lastAccentRgb || BASE_THEME.accentRgb);
        setAccentRgbEverywhere(targetAccRgb, pal, { blurSkip });

        const nextSurfaceSyntaxSig = pal.effectiveMode + "|" + surfaceName + "|" + contrastName + "|" + pal.tintRgb + "|" + pal.fg;
        const surfaceSyntaxChanged = nextSurfaceSyntaxSig !== lastSurfaceSyntaxSig;
        if (surfaceSyntaxChanged || (opts && opts.forceDomSync)) {
            lastSurfaceSyntaxSig = nextSurfaceSyntaxSig;
            if (opts && opts.deferDomSync) {
                pendingDeferredDomSync = true;
            } else {
                pendingDeferredDomSync = false;
                if (typeof scheduleCodeSyntaxAdapt === "function") scheduleCodeSyntaxAdapt({ full: true });
            }
        }
        return { ...pal, layers };
    }
    applyVisualVars();

    const syncPrivacyModifierHeld = (held) => {
        const allow = Boolean(held) && Boolean(state.privacyMode) && state.privacyRevealMode === "modifier";
        const cur = document.documentElement?.dataset?.agyModHeld === "1";
        if (allow === cur) return;
        if (document.documentElement) {
            if (allow) document.documentElement.dataset.agyModHeld = "1";
            else delete document.documentElement.dataset.agyModHeld;
        }
        for (const hostNode of [shadowHost, document.getElementById("agy-extras-shadow-host")]) {
            if (hostNode && hostNode.dataset) hostNode.dataset.agyModHeld = allow ? "1" : "0";
        }
    };
    window.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.key === "Alt" || e.key === "Control") syncPrivacyModifierHeld(true);
    }, true);
    window.addEventListener("keyup", (e) => {
        if (!e.altKey && !e.ctrlKey) syncPrivacyModifierHeld(false);
    }, true);
    window.addEventListener("blur", () => syncPrivacyModifierHeld(false));
    document.addEventListener("visibilitychange", () => { if (document.hidden) syncPrivacyModifierHeld(false); });

    // Live OS prefers-color-scheme listener for System theme mode (completely decoupled from native Antigravity classes)
    if (sysDarkMq) {
        const onSystemThemeChange = () => {
            if (state.themeMode === "system") {
                applyVisualVars();
                if (typeof syncControlsFromState === "function") syncControlsFromState();
            }
        };
        if (typeof sysDarkMq.addEventListener === "function") sysDarkMq.addEventListener("change", onSystemThemeChange);
        else if (typeof sysDarkMq.addListener === "function") sysDarkMq.addListener(onSystemThemeChange);
    }

    // ===== Hide Moved Visual Blocks in Native Antigravity "Appearance" Settings Tab =====
    const NATIVE_HIDDEN_TITLES = new Set([
        "appearance", "внешний вид",
        "light theme", "светлая тема",
        "dark theme", "тёмная тема", "темная тема",
    ]);
    const NATIVE_PRESERVED_TITLES = new Set([
        "chat", "чат",
        "chat layout", "макет чата",
        "accessibility", "спецвозможности",
    ]);
    const NATIVE_PRESERVED_RE = /\\b(conversation steps|conversation width|screen reader mode|screen reader|chat layout|accessibility)\\b|шаги диалога|ширина диалога|режим экранного диктора|экранного диктора|экранный диктор|макет чата|спецвозможности/i;
    const NATIVE_VISUAL_RE = /\\b(light theme|dark theme|code preview|reset to preset|font size|font family|color theme|default dark|default light)\\b|светлая тема|тёмная тема|темная тема|предпросмотр кода|сбросить пресет|размер шрифта|цветовая тема|тёмная по умолчанию|светлая по умолчанию|настройка темы и параметров отображения|configure the agent'?s visual theme/i;
    const NATIVE_VISUAL_CONTROL_RE = /\\b(theme|contrast|preset|background|foreground|accent|font|code preview)\\b|(?:^|[^a-zA-Zа-яА-ЯёЁ0-9_])(тема|темы|контрастность|пресет|фон|текст|акцент|шрифт|предпросмотр кода)(?=$|[^a-zA-Zа-яА-ЯёЁ0-9_])/i;

    function normalizeHeadingText(s) {
        return String(s || "").trim().replace(/\\s+/g, " ").toLowerCase();
    }

    function isProtectedUiNode(el) {
        if (!el) return false;
        if (el.matches && el.matches('.surface-composer, [data-testid="send-button"], [data-testid="input-cancel-button"], [data-testid="conversation-list-sidebar"], [data-testid="settings-sidebar"], textarea, [contenteditable="true"]')) {
            return true;
        }
        if (typeof el.querySelector === "function") {
            if (el.querySelector('.surface-composer, [data-testid="send-button"], [data-testid="input-cancel-button"], [data-testid="conversation-list-sidebar"], [data-testid="settings-sidebar"], textarea, [contenteditable="true"]')) {
                return true;
            }
        }
        return false;
    }

    function containsPreservedSettings(el) {
        if (!el) return false;
        if (isProtectedUiNode(el)) return true;
        const txt = String(el.textContent || "");
        if (NATIVE_PRESERVED_RE.test(txt)) return true;
        if (typeof el.querySelectorAll === "function") {
            const heads = el.querySelectorAll("h1, h2, h3, h4, h5, legend, [role='heading']");
            for (const h of heads) {
                if (NATIVE_PRESERVED_TITLES.has(normalizeHeadingText(h.textContent))) return true;
            }
        }
        return false;
    }

    function findSettingsContentPanes(docRef, sidebar) {
        const panes = [];
        if (!sidebar) return panes;
        const addPane = (el) => {
            if (!el || el.nodeType !== 1) return;
            if (el.id === "agy-wp-shadow-host" || el.id === "agy-extras-shadow-host") return;
            if (el === sidebar || (el.contains && el.contains(sidebar))) return;
            if (el.querySelector && el.querySelector('.surface-composer, [data-testid="conversation-list-sidebar"]')) return;
            if (!panes.includes(el)) panes.push(el);
        };
        const splitRoot = sidebar.closest ? sidebar.closest('[data-split-root="true"]') : null;
        if (splitRoot && splitRoot.children) {
            for (const child of Array.from(splitRoot.children)) {
                addPane(child);
            }
        }
        if (!panes.length) {
            const modal = sidebar.closest ? sidebar.closest('.settings-modal-container, [role="dialog"]') : null;
            if (modal && modal.children) {
                for (const child of Array.from(modal.children)) {
                    addPane(child);
                }
            }
        }
        return panes;
    }

    function scanNativeAppearanceBlocks(docRef = document) {
        const toHide = new Set();
        if (!docRef || !docRef.querySelectorAll) return 0;

        // STRICT GUARD: ONLY act when Antigravity's Settings view ([data-testid="settings-sidebar"]) is actually mounted!
        // Never touch regular chat viewports or prompt composers.
        const sidebar = docRef.querySelector ? docRef.querySelector('[data-testid="settings-sidebar"]') : null;
        const appNav = docRef.querySelector ? docRef.querySelector('[data-testid="settings-nav-item-appearance"]') : null;
        const appNavActive = Boolean(
            appNav && (
                appNav.classList?.contains("bg-sidebar-secondary") ||
                appNav.getAttribute?.("aria-current") === "page" ||
                appNav.getAttribute?.("aria-selected") === "true" ||
                appNav.getAttribute?.("data-active") === "true" ||
                appNav.getAttribute?.("data-selected") === "true"
            )
        );

        const panes = sidebar ? findSettingsContentPanes(docRef, sidebar) : [];
        for (const pane of panes) {
            if (appNav && !appNavActive) continue;
            const paneText = String(pane.textContent || "");
            const isAppearancePane = appNavActive || (
                NATIVE_VISUAL_RE.test(paneText) &&
                (NATIVE_PRESERVED_RE.test(paneText) || /light theme|dark theme|светлая тема|тёмная тема|темная тема/i.test(paneText))
            );
            if (!isAppearancePane) continue;

            const nodes = pane.querySelectorAll("h1, h2, h3, h4, h5, legend, [role='heading'], div, p, span, section");
            for (const el of Array.from(nodes)) {
                if (sidebar && sidebar.contains && sidebar.contains(el)) continue;
                if (isProtectedUiNode(el)) continue;
                const tag = String(el.tagName || "").toUpperCase();
                const isHeadingTag = /^H[1-5]$/.test(tag) || tag === "LEGEND" || el.getAttribute?.("role") === "heading";
                const childCount = el.children ? el.children.length : 0;
                if (!isHeadingTag && childCount > 1) continue;
                const norm = normalizeHeadingText(el.textContent);
                if (!NATIVE_HIDDEN_TITLES.has(norm)) continue;

                // Walk up to the highest wrapper inside pane that does NOT contain any preserved setting (Chat / Chat Layout / Accessibility)
                let best = el;
                let cur = el.parentElement;
                while (cur && cur !== pane && cur !== docRef.body && cur !== docRef.documentElement) {
                    if (sidebar && (cur === sidebar || (cur.contains && cur.contains(sidebar)))) break;
                    if (containsPreservedSettings(cur)) break;
                    best = cur;
                    cur = cur.parentElement;
                }
                if (!containsPreservedSettings(best)) {
                    toHide.add(best);
                    // Handle flat sibling layout: <h2>Light Theme</h2> followed by <div class="card">...</div>
                    let sib = best.nextElementSibling;
                    while (sib) {
                        if (containsPreservedSettings(sib)) break;
                        const sibNorm = normalizeHeadingText(sib.textContent);
                        if (NATIVE_PRESERVED_TITLES.has(sibNorm)) break;
                        const sibTag = String(sib.tagName || "").toUpperCase();
                        const isSep = sibTag === "HR" || sib.getAttribute?.("role") === "separator";
                        const sibText = String(sib.textContent || "");
                        if (isSep || NATIVE_VISUAL_RE.test(sibText) || NATIVE_VISUAL_CONTROL_RE.test(sibText)) {
                            toHide.add(sib);
                            sib = sib.nextElementSibling;
                        } else {
                            break;
                        }
                    }
                }
            }

            // Fallback: hide any direct child section/card inside pane containing only moved visual theme controls
            if (pane.children) {
                for (const child of Array.from(pane.children)) {
                    if (sidebar && (child === sidebar || (child.contains && child.contains(sidebar)))) continue;
                    if (containsPreservedSettings(child)) continue;
                    const txt = String(child.textContent || "");
                    if (NATIVE_VISUAL_RE.test(txt)) {
                        toHide.add(child);
                    }
                }
            }
        }

        // Remove stale attributes if React reused DOM nodes on another tab
        for (const prev of Array.from(docRef.querySelectorAll('[data-agy-hidden-native-appearance="1"]'))) {
            if (!toHide.has(prev)) {
                prev.removeAttribute("data-agy-hidden-native-appearance");
                if (prev.getAttribute("data-agy-prev-aria-hidden") === null) {
                    prev.removeAttribute("aria-hidden");
                }
            }
        }
        for (const el of toHide) {
            if (el.getAttribute("data-agy-hidden-native-appearance") !== "1") {
                el.setAttribute("data-agy-hidden-native-appearance", "1");
                el.setAttribute("aria-hidden", "true");
            }
        }
        return toHide.size;
    }

    let appearanceScanScheduled = false;
    function scheduleNativeAppearanceScan() {
        if (appearanceScanScheduled) return;
        appearanceScanScheduled = true;
        const run = () => {
            appearanceScanScheduled = false;
            try { scanNativeAppearanceBlocks(document); } catch {}
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 16);
    }

    try {
        scanNativeAppearanceBlocks(document);
        const SETTINGS_TRIGGER_SEL = '[data-testid="settings-sidebar"], [data-testid="settings-modal"], .settings-modal-container, [role="dialog"]';
        const nativeAppearanceObserver = new MutationObserver((mutations) => {
            const hasSidebarNow = Boolean(document.querySelector('[data-testid="settings-sidebar"]'));
            for (let mIdx = 0; mIdx < mutations.length; mIdx++) {
                const m = mutations[mIdx];
                const t = m.target;
                if (!t || t.id === "agy-wp-shadow-host" || t.id === "agy-extras-shadow-host" || t.id === "agy-wallpaper-layer") continue;
                if (hasSidebarNow) {
                    if (t.nodeType === 1 && typeof t.closest === "function" && t.closest('[data-testid="settings-modal"], .settings-modal-container, [data-split-root="true"], [role="dialog"]')) {
                        scheduleNativeAppearanceScan();
                        return;
                    }
                }
                const added = m.addedNodes;
                if (added && added.length) {
                    for (let i = 0; i < added.length; i++) {
                        const n = added[i];
                        if (!n || n.nodeType !== 1) continue;
                        if (n.id === "agy-wp-shadow-host" || n.id === "agy-extras-shadow-host" || n.id === "agy-wallpaper-layer") continue;
                        if ((n.matches && n.matches(SETTINGS_TRIGGER_SEL)) || (n.querySelector && n.querySelector(SETTINGS_TRIGGER_SEL))) {
                            scheduleNativeAppearanceScan();
                            return;
                        }
                    }
                }
            }
        });
        if (document.body) {
            nativeAppearanceObserver.observe(document.body, { childList: true, subtree: true });
        }
        window.addEventListener("agy-set-lang", scheduleNativeAppearanceScan);
    } catch {}

    try {
        scheduleCodeSyntaxAdapt({ full: true });
        let pillSyncTimer = null;
        const pendingPillRoots = new Set();
        let pendingFullPillSync = false;
        let pendingSurfaceOnTimer = false;
        let pendingEditorOnTimer = false;
        const schedulePillSync = (opts = null) => {
            if (!opts || opts.full) {
                pendingFullPillSync = true;
                pendingSurfaceOnTimer = true;
                pendingEditorOnTimer = true;
                pendingPillRoots.clear();
            } else {
                if (opts.root) pendingPillRoots.add(opts.root);
                if (opts.surfaces) pendingSurfaceOnTimer = true;
                if (opts.editor) pendingEditorOnTimer = true;
            }
            if (pillSyncTimer) return;
            pillSyncTimer = setTimeout(() => {
                pillSyncTimer = null;
                const doFull = pendingFullPillSync;
                const doSurf = pendingSurfaceOnTimer;
                const doEdit = pendingEditorOnTimer;
                const rootsArr = doFull ? null : (pendingPillRoots.size > 0 ? Array.from(pendingPillRoots) : null);
                pendingFullPillSync = false;
                pendingSurfaceOnTimer = false;
                pendingEditorOnTimer = false;
                pendingPillRoots.clear();
                try {
                    if (doEdit) syncEditorPaneTags(document);
                    if (doSurf) syncPanelSurfaces(document);
                    if (doFull || (rootsArr && rootsArr.length > 0)) {
                        syncLightDarkPills(document, computeResolvedPalette(), rootsArr);
                    }
                } catch {}
            }, 80);
        };
        setTimeout(() => schedulePillSync({ full: true }), 350);
        setTimeout(() => schedulePillSync({ full: true }), 1400);
        const PANE_OBSERVER_SEL = CODE_SYNTAX_CONTAINER_SEL + ', .monaco-editor, .monaco-diff-editor, .cm-editor, [data-diff-type], [data-testid="code-gutter-diff"], [data-testid="diff-gutter-strip"], [data-tiling-pane], [data-pane-id], [data-split-panes], [data-split-root="true"], .agy-inset-shell, [role="tabpanel"], [data-agy-editor-pane="1"]';
        const POPUP_OBSERVER_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper], [data-radix-menu-content], [data-slot*="content"], [data-slot="dialog-overlay"], .settings-modal-container, [data-testid="settings-modal"]';
        const BG_CLASS_HINT_RE = /\\b(?:bg-|dark:bg-|light:bg-|surface-|backdrop-blur)/;
        const isPlainChatStreamingNode = (node) => {
            if (!node || node.nodeType !== 1) return false;
            const chatEl = node.closest ? node.closest("[data-main-content-body]") : null;
            if (!chatEl) return false;
            if (node.closest && node.closest(PILL_REVIEW_OVERRIDE_SEL)) return false;
            if (node.matches && (node.matches(CODE_SYNTAX_CONTAINER_SEL) || node.matches(POPUP_OBSERVER_SEL))) return false;
            if (node.children && node.children.length === 0) return true;
            if (node.querySelector && (node.querySelector(CODE_SYNTAX_CONTAINER_SEL) || node.querySelector(POPUP_OBSERVER_SEL) || node.querySelector(PILL_REVIEW_OVERRIDE_SEL))) return false;
            return true;
        };
        const codeSyntaxObserver = new MutationObserver((mutations) => {
            for (let mIdx = 0; mIdx < mutations.length; mIdx++) {
                const m = mutations[mIdx];
                const t = m.target;
                if (!t || t.id === "agy-wp-shadow-host" || t.id === "agy-extras-shadow-host" || t.id === "agy-wallpaper-layer") continue;
                if (typeof t.closest === "function" && t.closest("#agy-wp-shadow-host, #agy-extras-shadow-host, #agy-wallpaper-layer")) continue;
                if (m.type === "attributes" && t.nodeType === 1) {
                    if (m.attributeName === "style") {
                        const adaptedCol = (t.getAttribute("data-agy-adapted-color") || "").trim();
                        const curCol = (t.style?.getPropertyValue("color") || t.style?.color || "").trim();
                        if (adaptedCol && curCol === adaptedCol) continue;
                    }
                    if (t.closest && t.closest(CODE_SYNTAX_CONTAINER_SEL)) {
                        scheduleCodeSyntaxAdapt({ full: false, syntaxRoot: t });
                        continue;
                    }
                    if (t.closest && t.closest(POPUP_OBSERVER_SEL)) {
                        schedulePillSync({ full: false, surfaces: true, root: t });
                        continue;
                    }
                    if (m.attributeName === "class") {
                        const cls = typeof t.className === "string" ? t.className : "";
                        if (!BG_CLASS_HINT_RE.test(cls)) continue;
                    }
                    if (isPlainChatStreamingNode(t)) continue;
                    schedulePillSync({ full: false, root: t });
                    continue;
                }
                if (m.type === "childList" && m.addedNodes && m.addedNodes.length > 0) {
                    for (let i = 0; i < m.addedNodes.length; i++) {
                        const n = m.addedNodes[i];
                        if (!n || n.nodeType !== 1) continue;
                        if (n.id === "agy-wp-shadow-host" || n.id === "agy-extras-shadow-host" || n.id === "agy-wallpaper-layer") continue;
                        if (isPlainChatStreamingNode(n)) continue;
                        const isPopup = Boolean((n.matches && n.matches(POPUP_OBSERVER_SEL)) || (n.querySelector && n.querySelector(POPUP_OBSERVER_SEL)));
                        const isSyntax = Boolean((n.matches && n.matches(CODE_SYNTAX_CONTAINER_SEL)) || (n.closest && n.closest(CODE_SYNTAX_CONTAINER_SEL)) || (n.querySelector && n.querySelector(CODE_SYNTAX_CONTAINER_SEL)));
                        const isPane = Boolean((n.matches && n.matches(PANE_OBSERVER_SEL)) || (n.querySelector && n.querySelector(PANE_OBSERVER_SEL)));
                        if (isPopup || isSyntax || isPane) {
                            scheduleCodeSyntaxAdapt({
                                full: false,
                                editor: isPane,
                                surfaces: isPopup || isPane,
                                syntaxRoot: isSyntax ? n : null,
                                pillRoot: (isPopup || isPane) ? n : null,
                            });
                        } else {
                            schedulePillSync({ full: false, root: n });
                        }
                    }
                }
            }
        });
        if (document.body) {
            codeSyntaxObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
        }
    } catch {}

    window.__agyAppearanceSanitizer = { scan: scanNativeAppearanceBlocks };
    window.__agyThemeApi = {
        resolveEffectiveThemeMode,
        resolveEffectiveTintRgb,
        computeResolvedPalette,
        applyVisualVars,
        adaptCodeSyntax: adaptCodeSyntaxColors,
        syncEditorPaneTags,
        syncPanelSurfaces,
        inspectBackdropChain,
        syncLightDarkPills,
        registerCustomFonts,
        buildFontFacesCss,
        getState: () => ({ ...state }),
        setState: (patch) => {
            hydrateFromObject(patch);
            const pal = applyVisualVars();
            if (typeof syncControlsFromState === "function") syncControlsFromState();
            return pal;
        },
    };

    // ===== Native-Style Centered Appearance Settings Modal (Zero Neon, Zero Emoji, Unified Radius) =====
    shadowHost = document.createElement("div");
    shadowHost.id = "agy-wp-shadow-host";
    shadowHost.style.setProperty("--agy-accent-rgb", BASE_THEME.accentRgb);
    shadowHost.style.setProperty("--agy-radius", state.radiusPx + "px");
    const shadow = shadowHost.attachShadow({ mode: "open" });

    const shadowStyle = document.createElement("style");
    shadowStyle.textContent = \`
        :host {
            --agy-accent-rgb: \${BASE_THEME.accentRgb};
            --agy-tint-rgb: \${BASE_THEME.tintRgb};
            --rad: var(--agy-radius, 10px);
            --on-tint: var(--agy-on-tinted-accent, #ffffff);
            --acc-txt: var(--agy-accent-text, #93c5fd);
            --modal-alpha: var(--agy-surface-modal-alpha, 0.88);
            --m-fg: #f8fafc;
            --m-fg-sec: #e2e8f0;
            --m-fg-muted: #cbd5e1;
            --m-fg-subtle: #94a3b8;
            --m-border: rgba(255, 255, 255, 0.12);
            --m-border-strong: rgba(255, 255, 255, 0.22);
            --m-divider: rgba(255, 255, 255, 0.08);
            --m-hover: rgba(255, 255, 255, 0.07);
            --m-subtle: rgba(255, 255, 255, 0.05);
            --m-subtle-strong: rgba(255, 255, 255, 0.14);
            --m-card-bg: rgba(255, 255, 255, 0.035);
            --m-nav-bg: rgba(255, 255, 255, 0.02);
            --m-listbox-bg: rgba(0, 0, 0, 0.30);
            --m-shadow: 0 28px 72px rgba(0, 0, 0, 0.72);
            --m-backdrop: rgba(4, 6, 10, 0.56);
            --m-backdrop-noblur: rgba(4, 6, 10, 0.64);
            --m-scroll-thumb: rgba(255, 255, 255, 0.18);
            --m-popover-bg: rgba(14, 17, 24, 0.96);
            --m-panel-bg: rgba(12, 14, 20, 0.92);
            --m-panel-blur: 20px;
            --m-danger-fg: #ef4444;
            --m-warn-fg: #f59e0b;
            --m-ok-fg: #22c55e;
            --m-slider-thumb-bg: #ffffff;
            --m-slider-thumb-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
            --m-preview-bg: #080a0f;
            --m-preview-grad: linear-gradient(180deg, rgba(0, 0, 0, 0.46) 0%, rgba(0, 0, 0, 0.06) 45%, rgba(0, 0, 0, 0.86) 100%);
            --m-preview-fg: #ffffff;
            --m-preview-title-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
            font-family: var(--agy-ui-font, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif);
            font-size: var(--agy-base-font-size, 14px);
            color: var(--m-fg);
        }
        :host([data-agy-surface="light"]) {
            --m-preview-bg: rgba(var(--agy-tint-rgb), 0.78);
            --m-preview-grad: linear-gradient(180deg, rgba(var(--agy-tint-rgb), 0.62) 0%, rgba(var(--agy-tint-rgb), 0.04) 44%, rgba(var(--agy-tint-rgb), 0.90) 100%);
            --m-preview-fg: var(--m-fg);
            --m-preview-title-shadow: 0 1px 6px rgba(var(--agy-tint-rgb), 0.88);
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        button:focus-visible, input:focus-visible, select:focus-visible {
            outline: 2px solid rgba(var(--agy-accent-rgb), 0.90);
            outline-offset: 1px;
        }
        :host([data-agy-contrast="high"]) .card-box,
        :host([data-agy-contrast="high"]) .drawer-btn,
        :host([data-agy-contrast="high"]) .cselect-btn,
        :host([data-agy-contrast="high"]) .cselect-menu,
        :host([data-agy-contrast="high"]) .color-field,
        :host([data-agy-contrast="high"]) .cpicker-inline-pop,
        :host([data-agy-contrast="high"]) .segmented,
        :host([data-agy-contrast="high"]) .switch,
        :host([data-agy-contrast="high"]) .panel {
            border-color: var(--m-border-strong);
        }
        :host([data-agy-contrast="high"]) :disabled { opacity: 0.56; cursor: not-allowed; }
        .section-disabled {
            opacity: 0.44;
            pointer-events: none;
            transition: opacity 0.14s ease;
        }
        .info-banner {
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 8px 10px;
            border-radius: calc(var(--rad) * 0.65);
            background: rgba(var(--agy-accent-rgb), 0.14);
            border: 1px solid rgba(var(--agy-accent-rgb), 0.40);
            color: var(--m-fg-sec);
            font-size: 0.82em;
            line-height: 1.35;
        }
        .info-banner.show { display: flex; }
        .info-banner-btn {
            padding: 4px 8px;
            border-radius: calc(var(--rad) * 0.5);
            border: 1px solid rgba(var(--agy-accent-rgb), 0.55);
            background: rgba(var(--agy-accent-rgb), 0.22);
            color: var(--on-tint);
            font-size: 0.92em;
            font-weight: 600;
            white-space: nowrap;
            flex-shrink: 0;
        }
        .info-banner-btn:hover { background: rgba(var(--agy-accent-rgb), 0.32); }
        svg {
            width: 1.07em; height: 1.07em; flex-shrink: 0; fill: none; stroke: currentColor;
            stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: block;
        }
        button { font-family: inherit; cursor: pointer; }

        @keyframes modalFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        @keyframes panelGlideIn {
            from { opacity: 0; transform: translateY(8px) scale(0.975); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .modal-backdrop {
            position: fixed;
            inset: 0;
            z-index: 2147483646;
            background: var(--m-backdrop);
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 28px;
            -webkit-app-region: no-drag;
            user-select: none;
        }
        .modal-backdrop.open {
            display: flex;
            animation: modalFadeIn 0.18s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .modal-backdrop.open .panel {
            animation: panelGlideIn 0.22s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .modal-backdrop.no-blur {
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
            background: var(--m-backdrop);
        }
        .modal-backdrop.no-blur .panel,
        :host([data-agy-blur-skip="1"]) .panel,
        :host([data-agy-blur-skip="1"]) .badge,
        :host([data-agy-blur-skip="1"]) .cbtn,
        :host([data-agy-no-blur="1"]) .badge,
        :host([data-agy-no-blur="1"]) .cbtn {
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
        }
        .modal-backdrop.no-blur .panel {
            background: var(--m-panel-bg, rgba(var(--agy-tint-rgb), var(--modal-alpha)));
        }

        .panel {
            width: min(900px, 92vw);
            height: min(670px, 85vh);
            overflow: hidden;
            contain: layout style;
            border-radius: var(--rad);
            background: var(--m-panel-bg, rgba(var(--agy-tint-rgb), var(--modal-alpha)));
            backdrop-filter: blur(var(--m-panel-blur, 20px));
            -webkit-backdrop-filter: blur(var(--m-panel-blur, 20px));
            border: 1px solid var(--m-border);
            box-shadow: var(--m-shadow);
            display: grid;
            grid-template-columns: minmax(214px, 16em) 1fr;
        }

        .modal-nav {
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 16px 12px 14px;
            border-right: 1px solid var(--m-divider);
            background: var(--m-nav-bg);
            contain: layout style;
        }
        .nav-top { display: flex; flex-direction: column; gap: 14px; }
        .panel-title { font-size: 1.04em; font-weight: 600; color: var(--m-fg); padding: 2px 8px; }
        .tabs-bar { display: flex; flex-direction: column; gap: 4px; }
        .tab-btn {
            min-height: 2.5em; padding: 0.45em 0.75em; border-radius: calc(var(--rad) * 0.75); border: 1px solid transparent;
            background: transparent; color: var(--m-fg-muted); font-size: 0.94em; font-weight: 500;
            display: flex; align-items: center; gap: 9px; text-align: left;
            transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
        }
        .tab-btn:hover { color: var(--m-fg); background: var(--m-hover); }
        .tab-btn.active {
            background: rgba(var(--agy-accent-rgb), 0.22);
            border-color: rgba(var(--agy-accent-rgb), 0.48);
            color: var(--on-tint);
            font-weight: 600;
        }

        .modal-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; contain: layout style; }
        .main-head {
            display: flex; align-items: center; justify-content: space-between;
            padding: 15px 20px 13px;
            border-bottom: 1px solid var(--m-divider);
            flex-shrink: 0;
        }
        .main-title { font-size: 1.1em; font-weight: 600; color: var(--m-fg); }
        .close-btn {
            width: 28px; height: 28px; border-radius: calc(var(--rad) * 0.65);
            border: 1px solid transparent; background: transparent; color: var(--m-fg-muted);
            display: inline-flex; align-items: center; justify-content: center;
        }
        .close-btn:hover { background: var(--m-hover); color: var(--m-fg); }

        .panel-body {
            flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 22px;
            display: flex; flex-direction: column; gap: 14px;
            contain: layout style;
        }
        .panel-body::-webkit-scrollbar { width: 5px; }
        .panel-body::-webkit-scrollbar-thumb { background: var(--m-scroll-thumb); border-radius: 3px; }
        .tab-pane { display: none; flex-direction: column; gap: 14px; }
        .tab-pane.active { display: flex; }

        .preview-card {
            position: relative; width: 100%; height: 186px; border-radius: calc(var(--rad) * 0.85); overflow: hidden;
            background: var(--m-preview-bg, #080a0f); border: 1px solid var(--m-border); flex-shrink: 0;
            contain: strict;
        }
        .preview-card video, .preview-card img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
        .preview-overlay {
            position: absolute; inset: 0; padding: 11px 13px;
            background: var(--m-preview-grad, linear-gradient(180deg, rgba(0,0,0,0.48) 0%, rgba(0,0,0,0.06) 45%, rgba(0,0,0,0.88) 100%));
            display: flex; flex-direction: column; justify-content: space-between;
        }
        .preview-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .badge {
            font-size: 0.78em; font-weight: 600; padding: 3px 8px; border-radius: calc(var(--rad) * 0.55);
            background: var(--m-popover-bg, rgba(12, 14, 20, 0.82)); border: 1px solid var(--m-border-strong); color: var(--m-fg);
            backdrop-filter: blur(10px);
        }
        .preview-bottom { display: flex; flex-direction: column; gap: 8px; }
        .wp-title { font-size: 0.96em; font-weight: 600; color: var(--m-preview-fg, #ffffff); text-shadow: var(--m-preview-title-shadow, none); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .transport { display: flex; align-items: center; gap: 6px; }
        .cbtn {
            min-height: 2.3em; min-width: 2.4em; padding: 0.35em 0.75em; border-radius: calc(var(--rad) * 0.65);
            border: 1px solid var(--m-border-strong); background: var(--m-popover-bg, rgba(16, 18, 26, 0.86)); color: var(--m-fg);
            backdrop-filter: blur(10px);
            font-size: 0.88em; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        }
        .cbtn:hover { background: var(--m-hover); border-color: rgba(var(--agy-accent-rgb), 0.55); }
        .cbtn.primary {
            flex: 1;
            background: linear-gradient(rgba(var(--agy-accent-rgb), 0.24), rgba(var(--agy-accent-rgb), 0.24)), var(--m-popover-bg, rgba(16, 18, 26, 0.86));
            border-color: rgba(var(--agy-accent-rgb), 0.58);
            color: var(--on-tint); font-weight: 600;
        }
        .cbtn.primary:hover {
            background: linear-gradient(rgba(var(--agy-accent-rgb), 0.34), rgba(var(--agy-accent-rgb), 0.34)), var(--m-popover-bg, rgba(16, 18, 26, 0.86));
        }

        .drawer-btn {
            width: 100%; min-height: 2.6em; flex-shrink: 0; padding: 0.45em 0.85em; border-radius: calc(var(--rad) * 0.75);
            border: 1px solid var(--m-border); background: var(--m-subtle); color: var(--m-fg-sec);
            font-size: 0.92em; font-weight: 500; display: flex; align-items: center; justify-content: space-between;
        }
        .drawer-btn:hover { background: var(--m-hover); border-color: var(--m-border-strong); color: var(--m-fg); }
        .drawer-left { display: inline-flex; align-items: center; gap: 8px; }
        .list-box {
            display: none; flex-direction: column; flex-shrink: 0; gap: 8px; padding: 10px;
            border-radius: calc(var(--rad) * 0.8); background: var(--m-listbox-bg); border: 1px solid var(--m-border);
        }
        .list-box.open { display: flex; }
        .filter-tabs { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 5px; }
        .search-input {
            width: 100%; min-height: 2.3em; padding: 0.35em 0.75em; border-radius: calc(var(--rad) * 0.65);
            border: 1px solid var(--m-border); background: var(--m-subtle);
            color: var(--m-fg); font-size: 0.92em; outline: none;
        }
        .search-input:focus { border-color: rgba(var(--agy-accent-rgb), 0.65); }
        .items-scroll { max-height: 210px; overflow-y: auto; display: block; padding-right: 3px; }
        .items-scroll::-webkit-scrollbar { width: 4px; }
        .items-scroll::-webkit-scrollbar-thumb { background: var(--m-scroll-thumb); border-radius: 2px; }
        .item-row { display: flex; align-items: center; gap: 5px; min-height: 2.2em; margin-bottom: 2px; border-radius: calc(var(--rad) * 0.6); padding: 0 5px 0 9px; }
        .item-row:hover { background: var(--m-hover); }
        .item-row.active { background: rgba(var(--agy-accent-rgb), 0.22); }
        .item-btn { flex: 1; min-width: 0; height: 2.2em; line-height: 2.2em; text-align: left; border: none; background: transparent; color: var(--m-fg-sec); font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .item-row:hover .item-btn, .item-row.active .item-btn { color: var(--on-tint); }
        .item-meta { font-size: 0.78em; color: var(--m-fg-subtle); flex-shrink: 0; padding: 0 4px; }
        .item-del { width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; color: var(--m-fg-subtle); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .item-del svg { width: 12px; height: 12px; }
        .item-del:hover { background: var(--m-subtle-strong); color: var(--m-danger-fg, #ef4444); }
        .restore-btn {
            align-self: flex-start; font-size: 0.82em; color: var(--acc-txt); background: transparent; border: none;
            padding: 2px 4px; display: none;
        }
        .restore-btn:hover { text-decoration: underline; }

        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 8px; }
        .section { display: flex; flex-direction: column; flex-shrink: 0; gap: 6px; min-width: 0; }
        .label-row { display: flex; align-items: center; justify-content: space-between; font-size: 0.92em; font-weight: 500; color: var(--m-fg-sec); gap: 8px; }
        .label-row > span:first-child { white-space: nowrap; }
        .val-text { font-variant-numeric: tabular-nums; font-size: 0.85em; font-weight: 600; color: var(--acc-txt); }
        .segmented {
            display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; padding: 3px;
            border-radius: calc(var(--rad) * 0.75); background: var(--m-subtle); border: 1px solid var(--m-border);
        }
        .segmented.cols-3 { grid-template-columns: repeat(3, 1fr); }
        .segmented.cols-2 { grid-template-columns: repeat(2, 1fr); }
        .seg-btn {
            border: 1px solid transparent; background: transparent; color: var(--m-fg-muted);
            min-height: 2.15em; padding: 0.25em 0.4em; border-radius: calc(var(--rad) * 0.55); font-size: 0.88em; font-weight: 500;
        }
        .seg-btn:hover { color: var(--m-fg); background: var(--m-hover); }
        .seg-btn.active {
            background: rgba(var(--agy-accent-rgb), 0.24);
            border-color: rgba(var(--agy-accent-rgb), 0.52);
            color: var(--on-tint);
            font-weight: 600;
        }

        .card-box {
            display: flex; flex-direction: column; flex-shrink: 0; gap: 12px; padding: 13px 14px;
            border-radius: calc(var(--rad) * 0.85); background: var(--m-card-bg); border: 1px solid var(--m-border);
        }
        .range {
            -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
            border-radius: 2px; background: var(--m-subtle-strong); outline: none; cursor: pointer;
        }
        .range::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%;
            background: var(--m-slider-thumb-bg, #ffffff); border: 2px solid rgb(var(--agy-accent-rgb));
            box-shadow: var(--m-slider-thumb-shadow, 0 1px 4px rgba(0, 0, 0, 0.35)); cursor: pointer;
        }
        .cselect { position: relative; width: 100%; }
        .cselect-btn {
            width: 100%; min-height: 2.4em; padding: 0.38em 0.75em;
            border-radius: calc(var(--rad) * 0.7);
            background: var(--m-subtle); border: 1px solid var(--m-border);
            color: var(--m-fg); font-size: 0.92em; font-weight: 500;
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
            transition: background 0.14s ease, border-color 0.14s ease;
        }
        .cselect-btn:hover, .cselect.open .cselect-btn {
            background: var(--m-hover);
            border-color: rgba(var(--agy-accent-rgb), 0.55);
        }
        .cselect-btn svg { width: 14px; height: 14px; flex-shrink: 0; color: var(--m-fg-subtle); transition: transform 0.14s ease; }
        .cselect.open .cselect-btn svg { transform: rotate(180deg); color: var(--m-fg); }
        .cselect-menu {
            display: none; position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 50;
            max-height: 220px; overflow-y: auto; padding: 4px;
            border-radius: calc(var(--rad) * 0.75);
            background: var(--m-popover-bg, rgba(var(--agy-tint-rgb), 0.98));
            border: 1px solid var(--m-border-strong);
            box-shadow: var(--m-shadow);
        }
        .cselect.open .cselect-menu { display: flex; flex-direction: column; gap: 2px; }
        .cselect-opt-row { display: flex; align-items: center; gap: 4px; }
        .cselect-opt {
            flex: 1; min-width: 0; width: 100%; text-align: left; padding: 0.44em 0.7em;
            border-radius: calc(var(--rad) * 0.52); border: 1px solid transparent;
            background: transparent; color: var(--m-fg-sec); font-size: 0.90em; font-weight: 500;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .cselect-opt:hover { background: var(--m-hover); color: var(--m-fg); }
        .cselect-opt.active {
            background: rgba(var(--agy-accent-rgb), 0.24);
            border-color: rgba(var(--agy-accent-rgb), 0.50);
            color: var(--on-tint); font-weight: 600;
        }
        .cselect-divider { height: 1px; background: var(--m-divider); margin: 4px 6px; }
        .cselect-group-lbl { font-size: 0.74em; font-weight: 600; color: var(--m-fg-subtle); padding: 3px 8px 2px; text-transform: uppercase; letter-spacing: 0.04em; }

        .color-field {
            display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow: hidden;
            padding: 8px 9px; border-radius: calc(var(--rad) * 0.7);
            background: var(--m-subtle); border: 1px solid var(--m-border);
            cursor: pointer; text-align: left;
            transition: border-color 0.14s ease, background 0.14s ease;
        }
        .color-field:hover { background: var(--m-hover); border-color: var(--m-border-strong); }
        .color-field.active { border-color: rgba(var(--agy-accent-rgb), 0.72); background: rgba(var(--agy-accent-rgb), 0.10); }
        .color-field-lbl { font-size: 0.80em; font-weight: 500; color: var(--m-fg-muted); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
        .color-field-tag { font-size: 0.82em; color: var(--acc-txt); font-weight: 600; flex-shrink: 0; }
        .color-field-val { display: flex; align-items: center; gap: 7px; min-width: 0; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.82em; color: var(--m-fg); }
        .color-field-val > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cpicker-inline-pop {
            display: none; flex-direction: column; gap: 10px; padding: 11px 12px;
            border-radius: calc(var(--rad) * 0.75);
            background: var(--m-popover-bg, rgba(var(--agy-tint-rgb), 0.96));
            border: 1px solid var(--m-border-strong);
            box-shadow: var(--m-shadow);
        }
        .cpicker-inline-pop.open { display: flex; }
        .mini-reset-btn {
            padding: 3px 9px; border-radius: calc(var(--rad) * 0.55);
            border: 1px solid var(--m-border); background: var(--m-subtle);
            color: var(--m-fg-muted); font-size: 0.80em; font-weight: 500;
            display: inline-flex; align-items: center; gap: 5px;
        }
        .mini-reset-btn:hover { background: var(--m-hover); border-color: var(--m-border-strong); color: var(--m-fg); }

        .cpicker-dot { width: 16px; height: 16px; border-radius: calc(var(--rad) * 0.35); border: 1px solid var(--m-border-strong); flex-shrink: 0; }
        .cpicker-hue {
            background: linear-gradient(90deg, #ff3b30, #ff9500, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30) !important;
            height: 8px !important; border-radius: 4px !important;
        }
        .cpicker-hex-row { display: flex; align-items: center; gap: 8px; }
        .cpicker-hex-input {
            flex: 1; min-width: 0; height: 26px; padding: 0 7px;
            border-radius: calc(var(--rad) * 0.5);
            background: var(--m-subtle); border: 1px solid var(--m-border);
            color: var(--m-fg); font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.84em; outline: none;
        }
        .cpicker-hex-input:focus { border-color: rgba(var(--agy-accent-rgb), 0.65); }

        .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
        .toggle-meta { display: flex; flex-direction: column; gap: 2px; }
        .toggle-title { font-size: 0.92em; font-weight: 500; color: var(--m-fg); }
        .toggle-sub { font-size: 0.80em; color: var(--m-fg-muted); }
        .switch {
            position: relative; width: 36px; height: 20px; border-radius: calc(var(--rad) * 0.9);
            background: var(--m-subtle-strong); border: 1px solid var(--m-border); flex-shrink: 0;
        }
        .switch::after {
            content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: calc(var(--rad) * 0.65); background: #ffffff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28); transition: transform 0.16s ease;
        }
        .switch.on { background: rgb(var(--agy-accent-rgb)); border-color: rgb(var(--agy-accent-rgb)); }
        .switch.on::after { transform: translateX(16px); }

        .swatch-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .swatch { width: 24px; height: 24px; border-radius: calc(var(--rad) * 0.5); border: 2px solid var(--m-border-strong); }
        .swatch.active { border-color: var(--m-fg); transform: scale(1.06); }

        .select-ui {
            width: 100%; min-height: 2.35em; border-radius: calc(var(--rad) * 0.65); background: var(--m-popover-bg, rgba(var(--agy-tint-rgb), 0.95));
            color: var(--m-fg); border: 1px solid var(--m-border); padding: 0.35em 0.65em; font-size: 0.92em; outline: none;
        }

        .reset-btn {
            width: 100%; min-height: 2.4em; padding: 0.35em 0.65em; flex-shrink: 0; border-radius: calc(var(--rad) * 0.75);
            border: 1px solid var(--m-border); background: var(--m-subtle);
            color: var(--m-fg-muted); font-size: 0.88em; font-weight: 500;
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        }
        .reset-btn:hover { background: var(--m-hover); border-color: var(--m-border-strong); color: var(--m-fg); }
    \`;

    const container = document.createElement("div");
    container.innerHTML = \`
        <div class="modal-backdrop" id="backdrop">
            <div class="panel" id="panel" role="dialog" aria-modal="true">
                <div class="modal-nav">
                    <div class="nav-top">
                        <div class="panel-title" id="lbl-studio-title">Персонализация</div>
                        <div class="tabs-bar">
                            <button class="tab-btn active" data-tab="wallpapers" id="tab-wallpapers">\${SVG.wallpaper}<span id="tab-wallpapers-lbl">Обои</span></button>
                            <button class="tab-btn" data-tab="theme" id="tab-theme">\${SVG.palette}<span id="tab-theme-lbl">Интерфейс</span></button>
                            <button class="tab-btn" data-tab="widgets" id="tab-widgets">\${SVG.widgets}<span id="tab-widgets-lbl">Виджеты</span></button>
                            <button class="tab-btn" data-tab="perf" id="tab-perf">\${SVG.perf}<span id="tab-perf-lbl">Оптимизация</span></button>
                            <button class="tab-btn" data-tab="accounts" id="tab-accounts">\${SVG.accounts}<span id="tab-accounts-lbl">Аккаунты</span></button>
                        </div>
                    </div>
                    <button class="reset-btn" id="btn-reset">\${SVG.reset}<span id="lbl-reset">Сбросить настройки</span></button>
                </div>

                <div class="modal-main">
                    <div class="main-head">
                        <div class="main-title" id="main-tab-title">Обои</div>
                        <button class="close-btn" id="btn-close" title="Закрыть">\${SVG.close}</button>
                    </div>

                    <div class="panel-body">
                        <!-- TAB 1: WALLPAPERS -->
                        <div class="tab-pane active" id="pane-wallpapers">
                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-plain-bg">Обычный фон (без обоев)</span>
                                        <span class="toggle-sub" id="lbl-plain-bg-sub">Однотонный фон темы; выгружает видео и фото из памяти</span>
                                    </div>
                                    <button class="switch" id="sw-plain-bg" role="switch" aria-checked="false"></button>
                                </div>
                            </div>

                            <div class="section" id="sec-wp-media-group" style="display:flex;flex-direction:column;gap:14px;">
                            <div class="preview-card">
                                <video id="preview-video" muted loop playsinline></video>
                                <img id="preview-img" style="display:none;" alt="">
                                <div class="preview-overlay">
                                    <div class="preview-top">
                                        <span class="badge" id="wp-res-badge">HD</span>
                                        <span class="badge" id="wp-counter">0 / 0</span>
                                    </div>
                                    <div class="preview-bottom">
                                        <div class="wp-title" id="wp-title">Загрузка...</div>
                                        <div class="transport">
                                            <button class="cbtn" id="c-prev">\${SVG.prev}</button>
                                            <button class="cbtn" id="c-play">\${state.paused ? SVG.play : SVG.pause}</button>
                                            <button class="cbtn primary" id="c-rand">\${SVG.shuffle}<span id="lbl-rand">Случайные</span></button>
                                            <button class="cbtn" id="c-next">\${SVG.next}</button>
                                            <button class="cbtn" id="c-mute">\${state.muted ? SVG.volOff : SVG.volOn}</button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div style="display:flex;gap:8px;">
                                <button class="drawer-btn" id="btn-add-custom-wp" style="flex:1;justify-content:center;">
                                    <span id="lbl-add-custom-wp">+ Добавить фото / видео</span>
                                </button>
                                <button class="drawer-btn" id="btn-open-custom-wp" style="padding:0 14px;width:auto;">
                                    <span id="lbl-open-custom-wp">Папка</span>
                                </button>
                            </div>
                            <button class="drawer-btn" id="list-toggle">
                                <span class="drawer-left">\${SVG.list}<span id="drawer-label">Выбрать обои</span></span>
                                \${SVG.chevronDown}
                            </button>
                            <div class="list-box" id="list-box">
                                <div class="filter-tabs" id="filter-tabs">
                                    <button class="seg-btn" data-filter="all" id="lbl-f-all">Все</button>
                                    <button class="seg-btn" data-filter="video" id="lbl-f-vid">Видео</button>
                                    <button class="seg-btn" data-filter="image" id="lbl-f-img">Фото</button>
                                    <button class="seg-btn" id="btn-rescan" style="padding:0 10px;">\${SVG.refresh}</button>
                                </div>
                                <input class="search-input" id="wp-search" type="text" placeholder="Поиск по названию...">
                                <div class="items-scroll" id="wp-items"></div>
                                <button class="restore-btn" id="btn-restore-hidden"></button>
                            </div>

                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-playmode">Режим смены</span></div>
                                    <div class="segmented cols-3" id="seg-playmode"></div>
                                </div>
                                <div class="section" id="timer-section">
                                    <div class="label-row">
                                        <span id="lbl-timer">Таймер смены</span>
                                        <span class="val-text" id="val-timer"></span>
                                    </div>
                                    <div class="segmented" id="seg-timer"></div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="grid-2">
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-dim">Затемнение</span><span class="val-text" id="v-dim">36%</span></div>
                                        <input class="range" id="r-dim" type="range" min="0" max="0.90" step="0.02">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-blur">Размытие</span><span class="val-text" id="v-vblur">0px</span></div>
                                        <input class="range" id="r-vblur" type="range" min="0" max="24" step="1">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-sat">Насыщенность</span><span class="val-text" id="v-sat">100%</span></div>
                                        <input class="range" id="r-sat" type="range" min="0.40" max="1.80" step="0.02">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-contrast">Контраст</span><span class="val-text" id="v-contrast">100%</span></div>
                                        <input class="range" id="r-contrast" type="range" min="0.60" max="1.50" step="0.02">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-speed">Скорость видео</span><span class="val-text" id="v-speed">1.00×</span></div>
                                        <input class="range" id="r-speed" type="range" min="0.40" max="1.50" step="0.05">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-wp-vol">Громкость обоев</span><span class="val-text" id="v-wp-vol">0%</span></div>
                                        <input class="range" id="r-wp-vol" type="range" min="0" max="1" step="0.02">
                                    </div>
                                </div>
                                <div class="section">
                                    <div class="label-row"><span id="lbl-fit">Масштабирование</span></div>
                                    <div class="segmented cols-2" id="seg-fit">
                                        <button class="seg-btn" data-fit="cover" id="lbl-fit-cover">Заполнить</button>
                                        <button class="seg-btn" data-fit="contain" id="lbl-fit-contain">Вместить</button>
                                    </div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-hide-mature">Скрывать 18+ (Mature)</span>
                                        <span class="toggle-sub" id="lbl-hide-mature-sub">Фильтр по рейтингу и названию</span>
                                    </div>
                                    <button class="switch" id="sw-mature"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-hide-lowres">Скрывать низкое качество (&lt;720p)</span>
                                        <span class="toggle-sub" id="lbl-hide-lowres-sub">Исключать вертикальные и мелкие обои</span>
                                    </div>
                                    <button class="switch" id="sw-lowres"></button>
                                </div>
                            </div>
                            </div>
                        </div>

                        <!-- TAB 2: INTERFACE -->
                        <div class="tab-pane" id="pane-theme">
                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-theme-mode">Режим темы</span></div>
                                    <div class="segmented cols-3" id="seg-theme-mode">
                                        <button type="button" class="seg-btn" data-tmode="dark" id="lbl-tmode-dark">Тёмная</button>
                                        <button type="button" class="seg-btn" data-tmode="light" id="lbl-tmode-light">Светлая</button>
                                        <button type="button" class="seg-btn" data-tmode="system" id="lbl-tmode-system">Системная</button>
                                    </div>
                                </div>
                                <div class="section">
                                    <div class="label-row"><span id="lbl-ui-contrast">Контрастность</span></div>
                                    <div class="segmented cols-2" id="seg-ui-contrast">
                                        <button type="button" class="seg-btn" data-contrast="default" id="lbl-uic-default">Обычная</button>
                                        <button type="button" class="seg-btn" data-contrast="high" id="lbl-uic-high">Высокая</button>
                                    </div>
                                </div>
                                <div class="section">
                                    <div class="label-row"><span id="lbl-alpha">Плотность панелей</span><span class="val-text" id="v-alpha">64%</span></div>
                                    <span class="toggle-sub" id="lbl-alpha-sub">Непрозрачность сайдбара, карточек, поля ввода и окон</span>
                                    <input class="range" id="r-alpha" type="range" min="0" max="100" step="1">
                                </div>
                                <div class="section" id="sec-panel-blur">
                                    <div class="label-row"><span id="lbl-panel-blur">Размытие панелей</span><span class="val-text" id="v-panel-blur">20px</span></div>
                                    <span class="toggle-sub" id="lbl-panel-blur-sub">0px — без размытия; заметнее при плотности ниже 95%</span>
                                    <input class="range" id="r-panel-blur" type="range" min="0" max="32" step="1">
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-autocontrast">Адаптивная вуаль обоев</span>
                                        <span class="toggle-sub" id="luma-badge">Анализ яркости фона</span>
                                    </div>
                                    <button class="switch" id="sw-contrast"></button>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-privacy">Режим приватности (стрим / запись)</span>
                                        <span class="toggle-sub" id="lbl-privacy-sub">Скрывает почту, идентификаторы аккаунтов и пути</span>
                                    </div>
                                    <button class="switch" id="sw-privacy"></button>
                                </div>
                                <div id="sec-privacy-sub" style="display:flex;flex-direction:column;gap:11px;">
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-privacy-reveal">Условие раскрытия</span></div>
                                        <div class="segmented cols-3" id="seg-privacy-reveal">
                                            <button type="button" class="seg-btn" data-reveal="never" id="lbl-prev-never">Никогда</button>
                                            <button type="button" class="seg-btn active" data-reveal="modifier" id="lbl-prev-mod">С Alt / Ctrl</button>
                                            <button type="button" class="seg-btn" data-reveal="hover" id="lbl-prev-hover">Наведение</button>
                                        </div>
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-privacy-style">Способ скрытия</span></div>
                                        <div class="segmented cols-2" id="seg-privacy-style">
                                            <button type="button" class="seg-btn active" data-pstyle="blur" id="lbl-pstyle-blur">Размытие</button>
                                            <button type="button" class="seg-btn" data-pstyle="mask" id="lbl-pstyle-mask">Маска ••••@••••</button>
                                        </div>
                                    </div>
                                    <div class="toggle-row">
                                        <div class="toggle-meta">
                                            <span class="toggle-title" id="lbl-privacy-paths">Скрывать личные пути и заголовки</span>
                                            <span class="toggle-sub" id="lbl-privacy-paths-sub">Маскирует профиль пользователя, /home/... и заголовок окна</span>
                                        </div>
                                        <button class="switch on" id="sw-privacy-paths"></button>
                                    </div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="label-row">
                                    <span id="lbl-custom-colors">Свои цвета</span>
                                    <button type="button" class="mini-reset-btn" id="btn-reset-colors">\${SVG.reset}<span id="lbl-reset-colors">Сбросить цвета</span></button>
                                </div>
                                <div class="segmented cols-2" id="seg-color-theme">
                                    <button type="button" class="seg-btn active" data-cmode="dark" id="lbl-cmode-dark">Тёмная тема</button>
                                    <button type="button" class="seg-btn" data-cmode="light" id="lbl-cmode-light">Светлая тема</button>
                                </div>
                                <div class="info-banner" id="color-edit-mismatch">
                                    <span id="lbl-cmode-mismatch">Вы редактируете неактивную палитру</span>
                                    <button type="button" class="info-banner-btn" id="btn-switch-active-cmode">Перейти к активной</button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-adapt-acc">Авто-акцент из обоев (для обеих тем)</span>
                                        <span class="toggle-sub" id="lbl-adapt-acc-sub">Подбирать цвет акцента под текущие обои</span>
                                    </div>
                                    <button class="switch" id="sw-accent"></button>
                                </div>
                                <div class="grid-3">
                                    <button type="button" class="color-field" id="btn-pick-bg" data-target="bg">
                                        <div class="color-field-lbl"><span id="lbl-color-bg">Фон</span><span class="color-field-tag" id="tag-color-bg">Авто</span></div>
                                        <div class="color-field-val"><span class="cpicker-dot" id="dot-color-bg"></span><span id="hex-color-bg">#0c0e14</span></div>
                                    </button>
                                    <button type="button" class="color-field" id="btn-pick-text" data-target="text">
                                        <div class="color-field-lbl"><span id="lbl-color-text">Текст</span><span class="color-field-tag" id="tag-color-text">Авто</span></div>
                                        <div class="color-field-val"><span class="cpicker-dot" id="dot-color-text"></span><span id="hex-color-text">#f8fafc</span></div>
                                    </button>
                                    <button type="button" class="color-field" id="btn-pick-accent" data-target="accent">
                                        <div class="color-field-lbl"><span id="lbl-color-accent">Акцент</span><span class="color-field-tag" id="tag-color-accent">Авто</span></div>
                                        <div class="color-field-val"><span class="cpicker-dot" id="dot-color-accent"></span><span id="hex-color-accent">#60a5fa</span></div>
                                    </button>
                                </div>
                                <div class="cpicker-inline-pop" id="cpicker-pop">
                                    <div class="label-row">
                                        <span id="lbl-cp-target" style="font-size:0.86em;font-weight:600;">Акцент</span>
                                        <button type="button" class="close-btn" id="btn-cp-close" style="width:22px;height:22px;">\${SVG.close}</button>
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-cp-h">Оттенок</span><span class="val-text" id="v-cp-h">213°</span></div>
                                        <input class="range cpicker-hue" id="r-cp-h" type="range" min="0" max="360" step="1">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-cp-s">Насыщенность</span><span class="val-text" id="v-cp-s">93%</span></div>
                                        <input class="range" id="r-cp-s" type="range" min="0" max="100" step="1">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-cp-l">Яркость</span><span class="val-text" id="v-cp-l">68%</span></div>
                                        <input class="range" id="r-cp-l" type="range" min="0" max="100" step="1">
                                    </div>
                                    <div class="cpicker-hex-row">
                                        <span class="cpicker-dot" id="cpicker-preview" style="width:24px;height:24px;"></span>
                                        <input class="cpicker-hex-input" id="c-picker-hex" type="text" maxlength="7" spellcheck="false" value="#60a5fa">
                                    </div>
                                </div>
                                <div class="swatch-row" id="accent-swatches"></div>
                            </div>

                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-font">Шрифт интерфейса</span></div>
                                    <div class="cselect" id="cs-font">
                                        <button type="button" class="cselect-btn" id="cs-font-btn"><span id="cs-font-lbl">Segoe UI Variable</span>\${SVG.chevronDown}</button>
                                        <div class="cselect-menu" id="cs-font-menu"></div>
                                    </div>
                                    <div style="display:flex;gap:8px;margin-top:4px;">
                                        <button type="button" class="drawer-btn" id="btn-add-custom-font" style="flex:1;justify-content:center;min-height:2.25em;" title="TTF, OTF, WOFF, WOFF2">
                                            <span id="lbl-add-custom-font">+ Загрузить шрифт</span>
                                        </button>
                                        <button type="button" class="drawer-btn" id="btn-open-custom-font" style="padding:0 14px;width:auto;min-height:2.25em;">
                                            <span id="lbl-open-custom-font">Папка</span>
                                        </button>
                                    </div>
                                </div>
                                <div class="grid-2">
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-fsize">Размер шрифта</span><span class="val-text" id="v-fsize">14px</span></div>
                                        <input class="range" id="r-fsize" type="range" min="12" max="18" step="0.5">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-rad">Скругление углов</span><span class="val-text" id="v-rad">10px</span></div>
                                        <input class="range" id="r-rad" type="range" min="0" max="18" step="1">
                                    </div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-lang-sec">Язык интерфейса</span></div>
                                    <div class="segmented cols-2" id="seg-lang">
                                        <button class="seg-btn" data-lang="ru">Русский</button>
                                        <button class="seg-btn" data-lang="en">English</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- TAB 3: WIDGETS -->
                        <div class="tab-pane" id="pane-widgets">
                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-w-player">Музыкальный плеер</span>
                                        <span class="toggle-sub" id="lbl-w-player-sub">Панель сверху по центру и караоке</span>
                                    </div>
                                    <button class="switch on" id="sw-w-player"></button>
                                </div>
                                <div id="sec-w-player-children" style="display:flex;flex-direction:column;gap:12px;">
                                    <div class="section" id="sec-w-openmode">
                                        <div class="label-row"><span id="lbl-w-openmode">Открытие мини-плеера</span></div>
                                        <span class="toggle-sub" id="lbl-w-openmode-sub">Строгий режим: только клик или только наведение</span>
                                        <div class="segmented cols-2" id="seg-w-openmode">
                                            <button type="button" class="seg-btn active" data-openmode="click" id="lbl-w-om-click">По нажатию</button>
                                            <button type="button" class="seg-btn" data-openmode="hover" id="lbl-w-om-hover">По наведению</button>
                                        </div>
                                    </div>
                                    <div class="toggle-row" id="row-w-lyrics">
                                        <div class="toggle-meta">
                                            <span class="toggle-title" id="lbl-w-lyrics">Строка караоке в шапке</span>
                                            <span class="toggle-sub" id="lbl-w-lyrics-sub">Показывать текущую строку песни</span>
                                        </div>
                                        <button class="switch on" id="sw-w-lyrics"></button>
                                    </div>
                                    <div class="section" id="sec-w-eqpos">
                                        <div class="label-row"><span id="lbl-w-eqpos">Визуализатор бита</span></div>
                                        <div class="segmented cols-3" id="seg-w-eqpos">
                                            <button class="seg-btn active" data-eqpos="composer" id="lbl-w-eq-composer">Над полем ввода</button>
                                            <button class="seg-btn" data-eqpos="header" id="lbl-w-eq-header">В плеере</button>
                                            <button class="seg-btn" data-eqpos="off" id="lbl-w-eq-off">Скрыть</button>
                                        </div>
                                    </div>
                                    <div class="section" id="sec-w-vol">
                                        <div class="label-row"><span id="lbl-w-vol">Громкость плеера</span><span class="val-text" id="v-w-vol">100%</span></div>
                                        <input class="range" id="r-w-vol" type="range" min="0" max="100" step="1">
                                    </div>
                                    <div class="grid-2" id="sec-w-lyrics-tuning">
                                        <div class="section">
                                            <div class="label-row"><span id="lbl-w-lsize">Шрифт караоке</span><span class="val-text" id="v-w-lsize">26px</span></div>
                                            <input class="range" id="r-w-lsize" type="range" min="18" max="36" step="1">
                                        </div>
                                        <div class="section">
                                            <div class="label-row"><span id="lbl-w-loffset">Сдвиг караоке</span><span class="val-text" id="v-w-loffset">0.00с</span></div>
                                            <input class="range" id="r-w-loffset" type="range" min="-5" max="5" step="0.25">
                                        </div>
                                    </div>
                                    <div class="section" id="sec-w-lalign">
                                        <div class="label-row"><span id="lbl-w-lalign">Выравнивание текста караоке</span></div>
                                        <div class="segmented cols-2" id="seg-w-lalign">
                                            <button class="seg-btn active" data-align="center" id="lbl-w-la-center">По центру</button>
                                            <button class="seg-btn" data-align="left" id="lbl-w-la-left">По левому краю</button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-w-ctx">Индикатор контекстного окна</span>
                                        <span class="toggle-sub" id="lbl-w-ctx-sub">Круговой счётчик токенов у поля ввода</span>
                                    </div>
                                    <button class="switch on" id="sw-w-ctx"></button>
                                </div>
                                <div class="toggle-row" id="row-w-ctx-pct">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-w-ctx-pct">Процент в кольце токенов</span>
                                        <span class="toggle-sub" id="lbl-w-ctx-pct-sub">Показывать число внутри кольца</span>
                                    </div>
                                    <button class="switch" id="sw-w-ctx-pct" role="switch" aria-checked="false" aria-label="Показывать число внутри кольца"></button>
                                </div>
                            </div>
                        </div>

                        <!-- TAB 4: PERFORMANCE & OPTIMIZATION -->
                        <div class="tab-pane" id="pane-perf">
                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-p-noblur">Отключить тяжёлое размытие окон</span>
                                        <span class="toggle-sub" id="lbl-p-noblur-sub">Убирает GPU-тормоза backdrop-filter поверх живых обоев</span>
                                    </div>
                                    <button class="switch on" id="sw-p-noblur"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-p-pause-modal">Пауза видео при открытых настройках</span>
                                        <span class="toggle-sub" id="lbl-p-pause-modal-sub">Останавливает фон, пока открыто окно персонализации</span>
                                    </div>
                                    <button class="switch" id="sw-p-pause-modal"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-p-pause-blur">Пауза видео в неактивном окне</span>
                                        <span class="toggle-sub" id="lbl-p-pause-blur-sub">Экономит GPU и CPU при переключении на другие программы</span>
                                    </div>
                                    <button class="switch on" id="sw-p-pause-blur"></button>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-p-static">Статичный режим обоев</span>
                                        <span class="toggle-sub" id="lbl-p-static-sub">Фиксирует текущий кадр как картинку (0% нагрузки на видео)</span>
                                    </div>
                                    <button class="switch" id="sw-p-static"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-p-motion">Упрощённые анимации интерфейса</span>
                                        <span class="toggle-sub" id="lbl-p-motion-sub">Отключает плавные переходы для максимальной отзывчивости</span>
                                    </div>
                                    <button class="switch" id="sw-p-motion"></button>
                                </div>
                            </div>
                        </div>

                        <!-- TAB 5: ACCOUNTS -->
                        <div class="tab-pane" id="pane-accounts">
                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-acc-startup">При запуске приложения</span></div>
                                    <div class="segmented cols-3" id="seg-acc-startup">
                                        <button class="seg-btn" data-startup="picker" id="lbl-acc-st-picker">Выбор аккаунта</button>
                                        <button class="seg-btn" data-startup="primary" id="lbl-acc-st-primary">Основной</button>
                                        <button class="seg-btn" data-startup="last" id="lbl-acc-st-last">Последний</button>
                                    </div>
                                </div>
                                <div class="section" id="sec-primary-acc">
                                    <div class="label-row"><span id="lbl-acc-primary">Основной аккаунт</span></div>
                                    <div class="cselect" id="cs-primary-acc">
                                        <button type="button" class="cselect-btn" id="cs-primary-acc-btn"><span id="cs-primary-acc-lbl">default</span>\${SVG.chevronDown}</button>
                                        <div class="cselect-menu" id="cs-primary-acc-menu"></div>
                                    </div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-acc-topbar">Панель вкладок аккаунтов сверху</span>
                                        <span class="toggle-sub" id="lbl-acc-topbar-sub">Если выключить — верхняя полоса скроется без лишних отступов</span>
                                    </div>
                                    <button class="switch on" id="sw-acc-topbar"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-acc-stop">Останавливать сервер при закрытии вкладки</span>
                                        <span class="toggle-sub" id="lbl-acc-stop-sub">Освобождает память; если выключить — вкладка откроется мгновенно</span>
                                    </div>
                                    <button class="switch on" id="sw-acc-stop"></button>
                                </div>
                            </div>

                            <div class="card-box">
                                <button class="drawer-btn" id="btn-open-picker" style="justify-content:center;">
                                    <span id="lbl-open-picker">Открыть экран выбора аккаунтов</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    \`;

    shadow.append(shadowStyle, container);
    registerCustomFonts(state.customFonts);
    applyVisualVars();
    const mountShadow = () => {
        if (!document.getElementById("agy-wp-shadow-host") && document.body) document.body.appendChild(shadowHost);
    };
    mountShadow();

    // Custom tooltips inside wallpaper/appearance settings modal (replaces native OS title popups)
    (() => {
        const tipEl = document.createElement("div");
        tipEl.setAttribute("role", "tooltip");
        tipEl.style.cssText = [
            "position:fixed", "z-index:2147483647", "pointer-events:none",
            "opacity:0", "transition:opacity 0.12s ease", "visibility:hidden",
            "padding:5px 9px", "max-width:min(320px,85vw)", "line-height:1.35",
            "border-radius:var(--agy-radius-sm,7px)",
            "background:var(--m-popover-bg,rgba(var(--agy-tint-rgb,14,17,24),0.96))",
            "border:1px solid var(--m-border-strong,rgba(255,255,255,0.18))",
            "box-shadow:var(--m-shadow,0 10px 28px rgba(0,0,0,0.52))",
            "color:var(--m-fg,#f1f5f9)",
            "font-family:var(--agy-ui-font,'Segoe UI Variable','Segoe UI',system-ui,sans-serif)",
            "font-size:calc(var(--agy-base-font-size,14px) * 0.84)",
            "font-weight:500", "white-space:normal", "word-break:break-word",
        ].join(";");
        shadow.appendChild(tipEl);

        let tipTimer = null;
        let activeEl = null;
        const hideTip = () => {
            clearTimeout(tipTimer);
            tipTimer = null;
            activeEl = null;
            tipEl.style.opacity = "0";
            tipEl.style.visibility = "hidden";
        };
        const showTipFor = (el) => {
            if (!el || !el.isConnected) { hideTip(); return; }
            const txt = (el.getAttribute("data-agy-tip") || "").trim();
            if (!txt) { hideTip(); return; }
            tipEl.textContent = txt;
            tipEl.style.visibility = "visible";
            tipEl.style.left = "-2000px";
            tipEl.style.top = "-2000px";
            const r = el.getBoundingClientRect();
            const tr = tipEl.getBoundingClientRect();
            const gap = 7;
            let left = r.left + (r.width - tr.width) / 2;
            left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
            let top = r.bottom + gap;
            if (top + tr.height > window.innerHeight - 8) {
                top = Math.max(8, r.top - tr.height - gap);
            }
            tipEl.style.left = Math.round(left) + "px";
            tipEl.style.top = Math.round(top) + "px";
            tipEl.style.opacity = "1";
        };
        shadow.addEventListener("pointerover", (e) => {
            let cur = e.target;
            let found = null;
            while (cur && cur.nodeType === 1) {
                const nt = cur.getAttribute("title");
                if (nt) { cur.setAttribute("data-agy-tip", nt); cur.removeAttribute("title"); found = cur; break; }
                if (cur.getAttribute("data-agy-tip")) { found = cur; break; }
                cur = cur.parentElement;
            }
            if (!found) { if (activeEl) hideTip(); return; }
            if (found === activeEl) return;
            hideTip();
            activeEl = found;
            tipTimer = setTimeout(() => showTipFor(found), 240);
        }, true);
        shadow.addEventListener("pointerout", (e) => {
            if (!activeEl) return;
            if (e.relatedTarget && activeEl.contains && activeEl.contains(e.relatedTarget)) return;
            hideTip();
        }, true);
        shadow.addEventListener("pointerdown", hideTip, true);
        window.addEventListener("blur", hideTip);
        window.addEventListener("keydown", hideTip, true);
    })();

    const $ = (sel) => shadow.querySelector(sel);
    const backdrop = $("#backdrop");
    const panel = $("#panel");
    const previewVideo = $("#preview-video");
    const previewImg = $("#preview-img");
    const timerSection = $("#timer-section");
    const timerSeg = $("#seg-timer");
    const playModeSeg = $("#seg-playmode");
    const timerVal = $("#val-timer");
    const listBox = $("#list-box");
    const listItemsEl = $("#wp-items");
    const searchInput = $("#wp-search");
    lumaBadge = $("#luma-badge");
    const drawerLabel = $("#drawer-label");
    const mainTabTitle = $("#main-tab-title");

    const swatchBox = $("#accent-swatches");
    ACCENT_SWATCHES.forEach((hex) => {
        const b = document.createElement("button");
        b.className = "swatch";
        b.dataset.hex = hex;
        b.style.background = hex;
        b.onclick = () => {
            if (state.colorEditMode === "light") state.lightCustomAccentHex = hex.toLowerCase();
            else state.darkCustomAccentHex = hex.toLowerCase();
            state.customAccentHex = hex.toLowerCase();
            state.adaptiveAccent = false;
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        };
        swatchBox.appendChild(b);
    });

    function getActiveTabTitle() {
        const ru = isRu();
        if (state.activeTab === "theme") return ru ? "Интерфейс" : "Interface";
        if (state.activeTab === "widgets") return ru ? "Виджеты" : "Widgets";
        if (state.activeTab === "perf") return ru ? "Оптимизация" : "Performance";
        if (state.activeTab === "accounts") return ru ? "Аккаунты" : "Accounts";
        return ru ? "Обои" : "Wallpapers";
    }

    function rebuildLocalizedSegments() {
        const ru = isRu();
        playModeSeg.innerHTML = "";
        [["lock", ru ? "Закрепить" : "Pin"], ["seq", ru ? "По порядку" : "Sequence"], ["random", ru ? "Случайные" : "Random"]].forEach(([m, label]) => {
            const b = document.createElement("button");
            b.className = "seg-btn" + (state.playMode === m ? " active" : "");
            b.dataset.mode = m;
            b.textContent = label;
            b.onclick = () => {
                state.playMode = m;
                if (m !== "lock" && (!state.timerMinutes || state.timerMinutes <= 0)) {
                    state.timerMinutes = 15;
                }
                saveState(true);
                resetTimer();
                syncControlsFromState();
            };
            playModeSeg.appendChild(b);
        });

        timerSeg.innerHTML = "";
        [[1, ru ? "1м" : "1m"], [5, ru ? "5м" : "5m"], [15, ru ? "15м" : "15m"], [30, ru ? "30м" : "30m"], [60, ru ? "1ч" : "1h"], [180, ru ? "3ч" : "3h"]].forEach(([m, label]) => {
            const b = document.createElement("button");
            b.className = "seg-btn" + (state.timerMinutes === m ? " active" : "");
            b.dataset.mins = String(m);
            b.textContent = label;
            b.onclick = () => {
                state.timerMinutes = m;
                saveState(true);
                resetTimer();
                syncControlsFromState();
            };
            timerSeg.appendChild(b);
        });
    }

    function applyPanelTranslations() {
        const ru = isRu();
        $("#lbl-studio-title").textContent = ru ? "Персонализация" : "Personalization";
        $("#tab-wallpapers-lbl").textContent = ru ? "Обои" : "Wallpapers";
        $("#tab-theme-lbl").textContent = ru ? "Интерфейс" : "Interface";
        $("#tab-widgets-lbl").textContent = ru ? "Виджеты" : "Widgets";
        if ($("#tab-perf-lbl")) $("#tab-perf-lbl").textContent = ru ? "Оптимизация" : "Performance";
        if ($("#tab-accounts-lbl")) $("#tab-accounts-lbl").textContent = ru ? "Аккаунты" : "Accounts";
        if (mainTabTitle) mainTabTitle.textContent = getActiveTabTitle();
        $("#btn-close").title = ru ? "Закрыть" : "Close";
        if ($("#lbl-plain-bg")) $("#lbl-plain-bg").textContent = ru ? "Обычный фон (без обоев)" : "Plain background (no wallpaper)";
        if ($("#lbl-plain-bg-sub")) $("#lbl-plain-bg-sub").textContent = ru ? "Однотонный фон темы; выгружает видео и фото из памяти" : "Solid theme background; unloads video and photo from memory";
        $("#lbl-rand").textContent = ru ? "Случайные" : "Random";
        $("#lbl-f-all").textContent = ru ? "Все" : "All";
        $("#lbl-f-vid").textContent = ru ? "Видео" : "Videos";
        if ($("#lbl-f-img")) $("#lbl-f-img").textContent = ru ? "Фото" : "Photos";
        if ($("#lbl-add-custom-wp")) $("#lbl-add-custom-wp").textContent = ru ? "+ Добавить фото / видео" : "+ Add photo / video";
        if ($("#lbl-open-custom-wp")) $("#lbl-open-custom-wp").textContent = ru ? "Папка" : "Folder";
        searchInput.placeholder = ru ? "Поиск по названию..." : "Search wallpapers...";
        $("#lbl-hide-mature").textContent = ru ? "Скрывать 18+ (Mature)" : "Hide 18+ (Mature)";
        $("#lbl-hide-mature-sub").textContent = ru ? "Фильтр по рейтингу и названию" : "Filter by rating & title";
        $("#lbl-hide-lowres").textContent = ru ? "Скрывать низкое качество (<720p)" : "Hide low resolution (<720p)";
        $("#lbl-hide-lowres-sub").textContent = ru ? "Исключать вертикальные и мелкие обои" : "Exclude vertical & SD clips";
        $("#lbl-playmode").textContent = ru ? "Режим смены" : "Change mode";
        $("#lbl-timer").textContent = ru ? "Таймер смены" : "Auto-change timer";
        $("#lbl-dim").textContent = ru ? "Затемнение" : "Dimming";
        $("#lbl-blur").textContent = ru ? "Размытие" : "Blur";
        $("#lbl-sat").textContent = ru ? "Насыщенность" : "Saturation";
        $("#lbl-contrast").textContent = ru ? "Контраст" : "Contrast";
        $("#lbl-speed").textContent = ru ? "Скорость видео" : "Playback speed";
        $("#lbl-wp-vol").textContent = ru ? "Громкость обоев" : "Wallpaper volume";
        $("#lbl-fit").textContent = ru ? "Масштабирование" : "Video fit";
        $("#lbl-fit-cover").textContent = ru ? "Заполнить" : "Cover";
        $("#lbl-fit-contain").textContent = ru ? "Вместить" : "Contain";
        if ($("#lbl-theme-mode")) $("#lbl-theme-mode").textContent = ru ? "Режим темы" : "Theme mode";
        if ($("#lbl-tmode-dark")) $("#lbl-tmode-dark").textContent = ru ? "Тёмная" : "Dark";
        if ($("#lbl-tmode-light")) $("#lbl-tmode-light").textContent = ru ? "Светлая" : "Light";
        if ($("#lbl-tmode-system")) $("#lbl-tmode-system").textContent = ru ? "Системная" : "System";
        if ($("#lbl-ui-contrast")) $("#lbl-ui-contrast").textContent = ru ? "Контрастность" : "Contrast";
        if ($("#lbl-uic-default")) $("#lbl-uic-default").textContent = ru ? "Обычная" : "Normal";
        if ($("#lbl-uic-high")) $("#lbl-uic-high").textContent = ru ? "Высокая" : "High";
        $("#lbl-alpha").textContent = ru ? "Плотность панелей" : "Panel opacity";
        if ($("#lbl-alpha-sub")) $("#lbl-alpha-sub").textContent = ru ? "Непрозрачность сайдбара, карточек, поля ввода и окон" : "Opacity of sidebar, cards, input box & windows";
        if ($("#lbl-panel-blur")) $("#lbl-panel-blur").textContent = ru ? "Размытие панелей" : "Panel blur";
        updatePanelBlurHint();
        $("#lbl-autocontrast").textContent = ru ? "Адаптивная вуаль обоев" : "Adaptive wallpaper scrim";
        if ($("#lbl-privacy")) $("#lbl-privacy").textContent = ru ? "Режим приватности (стрим / запись)" : "Privacy mode (stream / recording)";
        if ($("#lbl-privacy-sub")) $("#lbl-privacy-sub").textContent = ru ? "Скрывает почту, идентификаторы аккаунтов и пути" : "Hides emails, account identifiers & file paths";
        if ($("#lbl-privacy-reveal")) $("#lbl-privacy-reveal").textContent = ru ? "Условие раскрытия" : "Reveal condition";
        if ($("#lbl-prev-never")) $("#lbl-prev-never").textContent = ru ? "Никогда" : "Never";
        if ($("#lbl-prev-mod")) $("#lbl-prev-mod").textContent = ru ? "С Alt / Ctrl" : "With Alt / Ctrl";
        if ($("#lbl-prev-hover")) $("#lbl-prev-hover").textContent = ru ? "Наведение" : "Hover element";
        if ($("#lbl-privacy-style")) $("#lbl-privacy-style").textContent = ru ? "Способ скрытия" : "Hide style";
        if ($("#lbl-pstyle-blur")) $("#lbl-pstyle-blur").textContent = ru ? "Размытие" : "Blur";
        if ($("#lbl-pstyle-mask")) $("#lbl-pstyle-mask").textContent = ru ? "Маска ••••@••••" : "Mask ••••@••••";
        if ($("#lbl-privacy-paths")) $("#lbl-privacy-paths").textContent = ru ? "Скрывать личные пути и заголовки" : "Hide personal paths & titles";
        if ($("#lbl-privacy-paths-sub")) $("#lbl-privacy-paths-sub").textContent = ru ? "Маскирует профиль пользователя, /home/... и заголовок окна" : "Masks user home folder, /home/... & window title";
        if ($("#lbl-custom-colors")) $("#lbl-custom-colors").textContent = ru ? "Свои цвета" : "Custom colors";
        if ($("#lbl-reset-colors")) $("#lbl-reset-colors").textContent = ru ? "Сбросить цвета" : "Reset colors";
        if ($("#lbl-cmode-dark")) $("#lbl-cmode-dark").textContent = ru ? "Тёмная тема" : "Dark theme";
        if ($("#lbl-cmode-light")) $("#lbl-cmode-light").textContent = ru ? "Светлая тема" : "Light theme";
        if ($("#btn-switch-active-cmode")) $("#btn-switch-active-cmode").textContent = ru ? "Перейти к активной" : "Edit active theme";
        if ($("#lbl-color-bg")) $("#lbl-color-bg").textContent = ru ? "Фон" : "Background";
        if ($("#lbl-color-text")) $("#lbl-color-text").textContent = ru ? "Текст" : "Text";
        if ($("#lbl-color-accent")) $("#lbl-color-accent").textContent = ru ? "Акцент" : "Accent";
        if ($("#lbl-cp-h")) $("#lbl-cp-h").textContent = ru ? "Оттенок" : "Hue";
        if ($("#lbl-cp-s")) $("#lbl-cp-s").textContent = ru ? "Насыщенность" : "Saturation";
        if ($("#lbl-cp-l")) $("#lbl-cp-l").textContent = ru ? "Яркость" : "Lightness";
        $("#lbl-adapt-acc").textContent = ru ? "Авто-акцент из обоев (для обеих тем)" : "Adaptive wallpaper accent (global)";
        $("#lbl-adapt-acc-sub").textContent = ru ? "Подбирать цвет акцента под текущие обои" : "Match accent color to current wallpaper";
        $("#lbl-font").textContent = ru ? "Шрифт интерфейса" : "Interface font";
        if ($("#lbl-add-custom-font")) $("#lbl-add-custom-font").textContent = ru ? "+ Загрузить шрифт" : "+ Upload font";
        if ($("#lbl-open-custom-font")) $("#lbl-open-custom-font").textContent = ru ? "Папка" : "Folder";
        $("#lbl-fsize").textContent = ru ? "Размер шрифта" : "Font size";
        $("#lbl-rad").textContent = ru ? "Скругление углов" : "Corner radius";
        $("#lbl-lang-sec").textContent = ru ? "Язык интерфейса" : "Language";
        $("#lbl-w-player").textContent = ru ? "Музыкальный плеер" : "Music player";
        $("#lbl-w-player-sub").textContent = ru ? "Панель сверху по центру и караоке" : "Top bar player & karaoke";
        if ($("#lbl-w-openmode")) $("#lbl-w-openmode").textContent = ru ? "Открытие мини-плеера" : "Mini-player open trigger";
        if ($("#lbl-w-openmode-sub")) $("#lbl-w-openmode-sub").textContent = ru ? "Строгий режим: только клик или только наведение" : "Strict mode: click only or hover only";
        if ($("#lbl-w-om-click")) $("#lbl-w-om-click").textContent = ru ? "По нажатию" : "On click";
        if ($("#lbl-w-om-hover")) $("#lbl-w-om-hover").textContent = ru ? "По наведению" : "On hover";
        if ($("#lbl-w-lsize")) $("#lbl-w-lsize").textContent = ru ? "Шрифт караоке" : "Karaoke font size";
        if ($("#lbl-w-loffset")) $("#lbl-w-loffset").textContent = ru ? "Сдвиг караоке" : "Lyrics sync offset";
        if ($("#lbl-w-lalign")) $("#lbl-w-lalign").textContent = ru ? "Выравнивание текста караоке" : "Karaoke text align";
        if ($("#lbl-w-la-center")) $("#lbl-w-la-center").textContent = ru ? "По центру" : "Center";
        if ($("#lbl-w-la-left")) $("#lbl-w-la-left").textContent = ru ? "По левому краю" : "Left";
        $("#lbl-w-lyrics").textContent = ru ? "Строка караоке в шапке" : "Live lyric in top bar";
        $("#lbl-w-lyrics-sub").textContent = ru ? "Показывать текущую строку песни" : "Show synced lyrics in bar";
        if ($("#lbl-w-eqpos")) $("#lbl-w-eqpos").textContent = ru ? "Визуализатор бита" : "Beat visualizer";
        if ($("#lbl-w-eq-composer")) $("#lbl-w-eq-composer").textContent = ru ? "Над полем ввода" : "Above input";
        if ($("#lbl-w-eq-header")) $("#lbl-w-eq-header").textContent = ru ? "В плеере" : "In player";
        if ($("#lbl-w-eq-off")) $("#lbl-w-eq-off").textContent = ru ? "Скрыть" : "Hidden";
        $("#lbl-w-vol").textContent = ru ? "Громкость плеера" : "Player volume";
        $("#lbl-w-ctx").textContent = ru ? "Индикатор контекстного окна" : "Context window ring";
        $("#lbl-w-ctx-sub").textContent = ru ? "Круговой счётчик токенов у поля ввода" : "Token ring next to composer";
        $("#lbl-w-ctx-pct").textContent = ru ? "Процент в кольце токенов" : "Percentage in token ring";
        $("#lbl-w-ctx-pct-sub").textContent = ru ? "Показывать число внутри кольца" : "Show the value inside the ring";
        $("#sw-w-ctx-pct").setAttribute("aria-label", ru ? "Показывать число внутри кольца" : "Show the value inside the ring");
        if ($("#lbl-p-noblur")) $("#lbl-p-noblur").textContent = ru ? "Отключить тяжёлое размытие окон" : "Disable heavy window blur";
        if ($("#lbl-p-noblur-sub")) $("#lbl-p-noblur-sub").textContent = ru ? "Убирает GPU-тормоза backdrop-filter поверх живых обоев" : "Removes GPU backdrop-filter lag over live video";
        if ($("#lbl-p-pause-modal")) $("#lbl-p-pause-modal").textContent = ru ? "Пауза видео при открытых настройках" : "Pause video while settings are open";
        if ($("#lbl-p-pause-modal-sub")) $("#lbl-p-pause-modal-sub").textContent = ru ? "Останавливает фон, пока открыто окно персонализации" : "Pauses background video while this dialog is open";
        if ($("#lbl-p-pause-blur")) $("#lbl-p-pause-blur").textContent = ru ? "Пауза видео в неактивном окне" : "Pause video when window is unfocused";
        if ($("#lbl-p-pause-blur-sub")) $("#lbl-p-pause-blur-sub").textContent = ru ? "Экономит GPU и CPU при переключении на другие программы" : "Saves GPU & CPU when switching to other apps";
        if ($("#lbl-p-static")) $("#lbl-p-static").textContent = ru ? "Статичный режим обоев" : "Static wallpaper mode";
        if ($("#lbl-p-static-sub")) $("#lbl-p-static-sub").textContent = ru ? "Фиксирует текущий кадр как картинку (0% нагрузки на видео)" : "Freezes current frame as a still image (0% video decode)";
        if ($("#lbl-p-motion")) $("#lbl-p-motion").textContent = ru ? "Упрощённые анимации интерфейса" : "Reduce UI animations";
        if ($("#lbl-p-motion-sub")) $("#lbl-p-motion-sub").textContent = ru ? "Отключает плавные переходы для максимальной отзывчивости" : "Disables transitions for maximum snappiness";
        if ($("#lbl-acc-startup")) $("#lbl-acc-startup").textContent = ru ? "При запуске приложения" : "On app startup";
        if ($("#lbl-acc-st-picker")) $("#lbl-acc-st-picker").textContent = ru ? "Выбор аккаунта" : "Account Picker";
        if ($("#lbl-acc-st-primary")) $("#lbl-acc-st-primary").textContent = ru ? "Основной" : "Primary";
        if ($("#lbl-acc-st-last")) $("#lbl-acc-st-last").textContent = ru ? "Последний" : "Last used";
        if ($("#lbl-acc-primary")) $("#lbl-acc-primary").textContent = ru ? "Основной аккаунт" : "Primary account";
        if ($("#lbl-acc-stop")) $("#lbl-acc-stop").textContent = ru ? "Останавливать сервер при закрытии вкладки" : "Stop server when closing tab";
        if ($("#lbl-acc-stop-sub")) $("#lbl-acc-stop-sub").textContent = ru ? "Освобождает память; если выключить — вкладка откроется мгновенно" : "Frees RAM; turn off for instant tab reopening";
        if ($("#lbl-open-picker")) $("#lbl-open-picker").textContent = ru ? "Открыть экран выбора аккаунтов" : "Open Account Picker";
        $("#lbl-reset").textContent = ru ? "Сбросить настройки" : "Reset settings";
        rebuildLocalizedSegments();
    }

    function setLanguage(lang) {
        state.lang = lang === "en" ? "en" : "ru";
        applyPanelTranslations();
        syncControlsFromState();
        saveState(true);
        window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang } }));
    }

    shadow.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.onclick = () => {
            state.activeTab = btn.dataset.tab;
            shadow.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
            shadow.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + state.activeTab));
            if (mainTabTitle) mainTabTitle.textContent = getActiveTabTitle();
            syncPreviewMedia();
            if (state.activeTab === "widgets") syncPlayerVolumeFromServer();
            if (state.activeTab === "accounts") loadAccountsForTab();
        };
    });

    function formatPrimaryAccountOption(acc) {
        const ru = isRu();
        const baseName = (acc.customLabel || acc.displayName || acc.name || "").trim();
        const email = (acc.email || "").trim();
        if (state.privacyMode) {
            if (baseName && !baseName.includes("@")) return baseName;
            return acc.id === "default" ? (ru ? "Основной аккаунт" : "Primary account") : (ru ? "Аккаунт" : "Account");
        }
        if (baseName && email && baseName !== email) return baseName + " (" + email + ")";
        return baseName || email || acc.id;
    }

    function loadAccountsForTab() {
        const menu = $("#cs-primary-acc-menu");
        const lbl = $("#cs-primary-acc-lbl");
        if (!menu || !lbl) return;
        apiFetch("/accounts/list")
            .then((r) => r.json())
            .then((snap) => {
                const list = Array.isArray(snap?.accounts) ? snap.accounts : [];
                if (!list.length) return;
                menu.innerHTML = "";
                let activeLabel = "";
                for (const acc of list) {
                    const label = formatPrimaryAccountOption(acc);
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "cselect-opt" + (acc.id === state.primaryAccountId ? " active" : "");
                    btn.dataset.val = acc.id;
                    btn.textContent = label;
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        state.primaryAccountId = acc.id;
                        lbl.textContent = label;
                        menu.querySelectorAll(".cselect-opt").forEach((o) => o.classList.toggle("active", o.dataset.val === acc.id));
                        $("#cs-primary-acc")?.classList.remove("open");
                        saveState(true);
                    };
                    menu.appendChild(btn);
                    if (acc.id === state.primaryAccountId) activeLabel = label;
                }
                lbl.textContent = activeLabel || formatPrimaryAccountOption(list[0]);
            })
            .catch(() => {});
    }

    $("#seg-lang").querySelectorAll("button").forEach((b) => { b.onclick = () => setLanguage(b.dataset.lang); });

    function syncPlayerVolumeFromServer() {
        apiFetch("/media/rich")
            .then((r) => r.json())
            .then((d) => {
                if (d && Number.isFinite(Number(d.volume))) {
                    state.playerVolume = Math.max(0, Math.min(100, Math.round(Number(d.volume))));
                    state.playerMuted = !!d.muted;
                    const slider = $("#r-w-vol");
                    const label = $("#v-w-vol");
                    if (slider) slider.value = String(state.playerMuted ? 0 : state.playerVolume);
                    if (label) label.textContent = (state.playerMuted ? 0 : state.playerVolume) + "%";
                }
            })
            .catch(() => {});
    }

    function openModal() {
        backdrop.classList.add("open");
        backdrop.classList.toggle("no-blur", !!state.reduceBackdropBlur);
        syncControlsFromState();
        syncPreviewMedia();
        syncVideoPlaybackState();
        syncPlayerVolumeFromServer();
    }

    function closeModal() {
        backdrop.classList.remove("open");
        syncPreviewMedia();
        syncVideoPlaybackState();
    }

    function isStaticWallpaperItem(item) {
        return Boolean(item && (item.kind === "scene" || item.kind === "image"));
    }

    function syncVideoOnlyControls() {
        const plainBg = state.wallpaperEnabled === false;
        const wpMediaGroup = $("#sec-wp-media-group");
        if (wpMediaGroup) {
            wpMediaGroup.classList.toggle("section-disabled", plainBg);
            wpMediaGroup.querySelectorAll("button, input").forEach((ctrl) => {
                ctrl.disabled = plainBg;
            });
        }
        if (plainBg) return;

        const item = state.videos[state.currentIndex];
        const staticItem = isStaticWallpaperItem(item);
        const speedEl = $("#r-speed");
        const volEl = $("#r-wp-vol");
        const playBtn = $("#c-play");
        const muteBtn = $("#c-mute");
        const tip = isRu() ? "Только для видео-обоев" : "Video wallpapers only";
        for (const el of [speedEl, volEl]) {
            if (!el) continue;
            el.disabled = staticItem;
            const sec = el.closest(".section");
            if (sec) {
                sec.style.opacity = staticItem ? "0.42" : "1";
                sec.title = staticItem ? tip : "";
            }
        }
        for (const btn of [playBtn, muteBtn]) {
            if (!btn) continue;
            btn.disabled = staticItem;
            btn.style.opacity = staticItem ? "0.42" : "1";
            btn.style.pointerEvents = staticItem ? "none" : "auto";
        }
    }

    function captureBgVideoPoster() {
        try {
            if (!bgVideo || bgVideo.readyState < 2 || !bgVideo.videoWidth || !bgVideo.videoHeight) return "";
            const c = document.createElement("canvas");
            const w = Math.min(640, bgVideo.videoWidth);
            const h = Math.max(1, Math.round((w * bgVideo.videoHeight) / bgVideo.videoWidth));
            c.width = w;
            c.height = h;
            const ctx = c.getContext("2d");
            if (!ctx) return "";
            ctx.drawImage(bgVideo, 0, 0, w, h);
            return c.toDataURL("image/jpeg", 0.82);
        } catch {
            return "";
        }
    }

    function syncPreviewMedia() {
        const isOpen = backdrop.classList.contains("open") && state.activeTab === "wallpapers";
        if (!isOpen || state.wallpaperEnabled === false) {
            try { previewVideo.pause(); previewVideo.removeAttribute("src"); previewVideo.load(); } catch {}
            if (state.wallpaperEnabled === false) {
                previewVideo.style.display = "none";
                previewImg.style.display = "none";
                try { previewImg.removeAttribute("src"); } catch {}
                if ($("#wp-title")) $("#wp-title").textContent = isRu() ? "Обычный фон (без обоев)" : "Plain background (no wallpaper)";
                syncVideoOnlyControls();
            }
            return;
        }
        const item = state.videos[state.currentIndex];
        if (!item || !currentStreamUrl) return;
        syncVideoOnlyControls();
        if (isStaticWallpaperItem(item)) {
            try { previewVideo.pause(); previewVideo.removeAttribute("src"); } catch {}
            previewVideo.style.display = "none";
            previewImg.style.display = "block";
            previewImg.src = currentStreamUrl;
        } else if (state.reduceBackdropBlur) {
            // In blur-optimization mode, show a crisp static snapshot of bgVideo to avoid running two 4K video decoders simultaneously
            const poster = captureBgVideoPoster();
            if (poster) {
                try { previewVideo.pause(); previewVideo.removeAttribute("src"); } catch {}
                previewVideo.style.display = "none";
                previewImg.style.display = "block";
                previewImg.src = poster;
            } else {
                previewImg.style.display = "none";
                previewVideo.style.display = "block";
                previewVideo.muted = true;
                if (previewVideo.src !== currentStreamUrl) previewVideo.src = currentStreamUrl;
                previewVideo.onloadeddata = () => {
                    previewVideo.onloadeddata = null;
                    try { previewVideo.pause(); } catch {}
                };
            }
        } else {
            previewImg.style.display = "none";
            previewVideo.style.display = "block";
            previewVideo.muted = true;
            if (previewVideo.src !== currentStreamUrl) previewVideo.src = currentStreamUrl;
            previewVideo.playbackRate = state.playbackRate;
            if (!state.paused) previewVideo.play().catch(() => {});
            else try { previewVideo.pause(); } catch {}
        }
    }

    const PA_MIN = 0;
    const PA_MAX = 1;
    const panelAlphaToPct = (a) => {
        const clamped = Math.max(PA_MIN, Math.min(PA_MAX, Number.isFinite(Number(a)) ? Number(a) : 0.68));
        return Math.round(((clamped - PA_MIN) / (PA_MAX - PA_MIN)) * 100);
    };
    const pctToPanelAlpha = (pct) => {
        const p = Math.max(0, Math.min(100, Number.isFinite(Number(pct)) ? Number(pct) : 68));
        return Number((PA_MIN + (p / 100) * (PA_MAX - PA_MIN)).toFixed(3));
    };

    function updatePanelBlurHint() {
        const el = shadowHost?.shadowRoot?.getElementById("lbl-panel-blur-sub");
        if (!el) return;
        const ru = typeof isRu === "function" ? isRu() : state.lang !== "en";
        const isNearlySolid = Number(state.panelAlpha ?? 0.68) >= 0.96;
        el.textContent = isNearlySolid
            ? (ru ? "При плотности 96–100% панели почти непрозрачны — стекло не видно" : "At 96–100% opacity panels are nearly solid — glass blur won't show")
            : (ru ? "Матовое стекло для полупрозрачных панелей (0px — выкл.)" : "Frosted glass for translucent panels (0px = off)");
    }

    function syncControlsFromState() {
        const ru = isRu();
        const plainBgOn = state.wallpaperEnabled === false;
        const swPlainBg = $("#sw-plain-bg");
        if (swPlainBg) {
            swPlainBg.classList.toggle("on", plainBgOn);
            swPlainBg.setAttribute("aria-checked", String(plainBgOn));
        }
        syncVideoOnlyControls();
        if (timerSection) {
            timerSection.style.display = state.playMode === "lock" ? "none" : "flex";
        }
        if (timerVal) {
            const mins = state.timerMinutes > 0 ? state.timerMinutes : 15;
            timerVal.textContent = mins >= 60 ? (mins / 60) + (ru ? " ч" : "h") : mins + (ru ? " мин" : "m");
        }
        const setR = (id, valId, val, fmtStr) => { const el = $(id), v = $(valId); if (el) el.value = String(val); if (v) v.textContent = fmtStr; };
        setR("#r-dim", "#v-dim", state.dim, Math.round(state.dim * 100) + "%");
        setR("#r-vblur", "#v-vblur", state.videoBlur, state.videoBlur + "px");
        const alphaPct = panelAlphaToPct(state.panelAlpha);
        setR("#r-alpha", "#v-alpha", alphaPct, alphaPct + "%");
        const blurVal = state.reduceBackdropBlur ? 0 : Math.max(0, Math.min(32, Math.round(Number(state.panelBlurPx ?? 20))));
        setR("#r-panel-blur", "#v-panel-blur", blurVal, blurVal + "px");
        if ($("#r-panel-blur")) $("#r-panel-blur").disabled = false;
        $("#sec-panel-blur")?.classList.remove("section-disabled");
        setR("#r-speed", "#v-speed", state.playbackRate, state.playbackRate.toFixed(2) + "×");
        setR("#r-sat", "#v-sat", state.videoSat, Math.round(state.videoSat * 100) + "%");
        setR("#r-contrast", "#v-contrast", state.videoContrast, Math.round(state.videoContrast * 100) + "%");
        setR("#r-fsize", "#v-fsize", state.fontSizePx, state.fontSizePx + "px");
        setR("#r-rad", "#v-rad", state.radiusPx, state.radiusPx + "px");
        const effWpVol = state.muted ? 0 : state.wallpaperVolume;
        setR("#r-wp-vol", "#v-wp-vol", effWpVol, Math.round(effWpVol * 100) + "%");
        setR("#r-w-vol", "#v-w-vol", state.playerMuted ? 0 : state.playerVolume, (state.playerMuted ? 0 : state.playerVolume) + "%");

    let lastFontOptionsSig = "";
    function renderFontOptions() {
        const fontMenu = $("#cs-font-menu");
        if (!fontMenu) return;
        const ru = isRu();
        const customSig = Array.isArray(state.customFonts)
            ? state.customFonts.map((f) => (f?.fileName || f?.family || "") + ":" + (f?.cssValue || "")).join(",")
            : "";
        const nextSig = (ru ? "ru" : "en") + "|" + String(state.uiFontChoice || "") + "|" + customSig;
        if (nextSig === lastFontOptionsSig && fontMenu.childElementCount > 0) return;
        lastFontOptionsSig = nextSig;
        fontMenu.innerHTML = "";
        let matchedLbl = "";

        const addOption = (label, cssValue, previewFont, customFontItem = null) => {
            const isAct = cssValue === state.uiFontChoice;
            if (isAct) matchedLbl = label;
            const row = document.createElement("div");
            row.className = "cselect-opt-row";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cselect-opt" + (isAct ? " active" : "");
            btn.dataset.val = cssValue;
            btn.style.fontFamily = previewFont || cssValue;
            btn.textContent = label;
            btn.onclick = (e) => {
                e.stopPropagation();
                state.uiFontChoice = cssValue;
                $("#cs-font")?.classList.remove("open");
                applyVisualVars();
                syncControlsFromState();
                saveState(true);
            };
            row.appendChild(btn);

            if (customFontItem) {
                const del = document.createElement("button");
                del.type = "button";
                del.className = "item-del";
                del.innerHTML = SVG.close;
                del.title = ru ? "Удалить шрифт" : "Delete font";
                del.onclick = (e) => {
                    e.stopPropagation();
                    apiFetch("/fonts/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ fileName: customFontItem.fileName }),
                    })
                        .then((r) => r.json())
                        .then((d) => {
                            if (d && Array.isArray(d.fonts)) {
                                registerCustomFonts(d.fonts);
                                if (state.uiFontChoice === cssValue) {
                                    state.uiFontChoice = DEFAULTS.uiFontChoice;
                                    applyVisualVars();
                                    saveState(true);
                                }
                                syncControlsFromState();
                            }
                        })
                        .catch(() => {});
                };
                row.appendChild(del);
            }
            fontMenu.appendChild(row);
        };

        for (const bf of BUILTIN_FONTS) {
            addOption(bf.label, bf.cssValue, bf.preview, null);
        }

        if (Array.isArray(state.customFonts) && state.customFonts.length > 0) {
            const divider = document.createElement("div");
            divider.className = "cselect-divider";
            fontMenu.appendChild(divider);

            const grpLbl = document.createElement("div");
            grpLbl.className = "cselect-group-lbl";
            grpLbl.textContent = ru ? "Загруженные шрифты" : "Uploaded fonts";
            fontMenu.appendChild(grpLbl);

            for (const cf of state.customFonts) {
                addOption(cf.name || cf.family, cf.cssValue, cf.cssValue, cf);
            }
        }

        if (!matchedLbl && state.uiFontChoice) {
            matchedLbl = String(state.uiFontChoice).split(",")[0].replace(/['"]/g, "").trim() || "Segoe UI Variable";
        }
        if ($("#cs-font-lbl")) $("#cs-font-lbl").textContent = matchedLbl || "Segoe UI Variable";
    }

        const activeEffMode = resolveEffectiveThemeMode();
        const editMode = state.colorEditMode === "light" ? "light" : "dark";
        const editProf = getThemeColorProfile(editMode);
        const editBgHex = (editProf.useBg ? editProf.bgHex : (editMode === "light" ? LIGHT_DEFAULT_BG_HEX : DARK_DEFAULT_BG_HEX)).toLowerCase();
        const editFgHex = (editProf.useText ? editProf.textHex : (editMode === "light" ? (state.uiContrast === "high" ? "#000000" : LIGHT_DEFAULT_TEXT_HEX) : (state.uiContrast === "high" ? "#ffffff" : DARK_DEFAULT_TEXT_HEX))).toLowerCase();
        const editAccHex = (editProf.accentHex || (editMode === "light" ? LIGHT_DEFAULT_ACCENT_HEX : DARK_DEFAULT_ACCENT_HEX)).toLowerCase();
        const effAdaptiveHex = rgbToHex(parseRgb(state.adaptiveRgb || lastAccentRgb || BASE_THEME.accentRgb, [96, 165, 250])).toLowerCase();
        const shownAccHex = state.adaptiveAccent ? effAdaptiveHex : editAccHex;
        const autoTag = ru ? "Авто" : "Auto";
        const customTag = ru ? "Свой" : "Custom";

        $("#seg-theme-mode")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tmode === state.themeMode));
        $("#seg-ui-contrast")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.contrast === state.uiContrast));
        $("#seg-color-theme")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.cmode === editMode));
        const mismatchBanner = $("#color-edit-mismatch");
        if (mismatchBanner) {
            const mismatch = editMode !== activeEffMode;
            mismatchBanner.classList.toggle("show", mismatch);
            if ($("#lbl-cmode-mismatch")) {
                $("#lbl-cmode-mismatch").textContent = editMode === "light"
                    ? (ru ? "Вы редактируете Светлую палитру (сейчас активна Тёмная)" : "Editing Light palette (Dark is currently active)")
                    : (ru ? "Вы редактируете Тёмную палитру (сейчас активна Светлая)" : "Editing Dark palette (Light is currently active)");
            }
        }

        if ($("#dot-color-bg")) $("#dot-color-bg").style.background = editBgHex;
        if ($("#hex-color-bg")) $("#hex-color-bg").textContent = editBgHex;
        if ($("#tag-color-bg")) $("#tag-color-bg").textContent = editProf.useBg ? customTag : autoTag;

        if ($("#dot-color-text")) $("#dot-color-text").style.background = editFgHex;
        if ($("#hex-color-text")) $("#hex-color-text").textContent = editFgHex;
        if ($("#tag-color-text")) $("#tag-color-text").textContent = editProf.useText ? customTag : autoTag;

        if ($("#dot-color-accent")) $("#dot-color-accent").style.background = shownAccHex;
        if ($("#hex-color-accent")) $("#hex-color-accent").textContent = shownAccHex;
        if ($("#tag-color-accent")) $("#tag-color-accent").textContent = state.adaptiveAccent ? autoTag : customTag;

        const pickerOpen = Boolean($("#cpicker-pop")?.classList.contains("open"));
        for (const [id, tgt] of [["#btn-pick-bg", "bg"], ["#btn-pick-text", "text"], ["#btn-pick-accent", "accent"]]) {
            $(id)?.classList.toggle("active", pickerOpen && state.activePickerTarget === tgt);
        }
        const activeHex = state.activePickerTarget === "bg" ? editBgHex : (state.activePickerTarget === "text" ? editFgHex : editAccHex);
        const modeTitle = editMode === "light" ? (ru ? "Светлая тема" : "Light theme") : (ru ? "Тёмная тема" : "Dark theme");
        const targetTitle = state.activePickerTarget === "bg"
            ? (ru ? "Фон" : "Background")
            : (state.activePickerTarget === "text" ? (ru ? "Текст" : "Text") : (ru ? "Акцент" : "Accent"));
        if ($("#lbl-cp-target")) $("#lbl-cp-target").textContent = targetTitle + " — " + modeTitle;
        if ($("#c-picker-hex")) $("#c-picker-hex").value = activeHex;
        if ($("#cpicker-preview")) $("#cpicker-preview").style.background = activeHex;
        syncColorPickerSliders(activeHex);
        swatchBox.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", !state.adaptiveAccent && s.dataset.hex.toLowerCase() === editAccHex));
        renderFontOptions();

        $("#sw-contrast")?.classList.toggle("on", !!state.autoContrast);
        updateLumaBadge();
        const privOn = !!state.privacyMode;
        $("#sw-privacy")?.classList.toggle("on", privOn);
        $("#sec-privacy-sub")?.classList.toggle("section-disabled", !privOn);
        const revMode = state.privacyRevealMode === "never" || state.privacyRevealMode === "hover" ? state.privacyRevealMode : "modifier";
        $("#seg-privacy-reveal")?.querySelectorAll("button").forEach((b) => {
            b.classList.toggle("active", b.dataset.reveal === revMode);
            b.disabled = !privOn;
        });
        const pStyle = state.privacyHideStyle === "mask" ? "mask" : "blur";
        $("#seg-privacy-style")?.querySelectorAll("button").forEach((b) => {
            b.classList.toggle("active", b.dataset.pstyle === pStyle);
            b.disabled = !privOn;
        });
        const pPaths = state.privacyHidePaths !== false;
        $("#sw-privacy-paths")?.classList.toggle("on", pPaths);
        if ($("#sw-privacy-paths")) $("#sw-privacy-paths").disabled = !privOn;

        $("#sw-accent")?.classList.toggle("on", state.adaptiveAccent);
        $("#sw-mature")?.classList.toggle("on", state.hideMature);
        $("#sw-lowres")?.classList.toggle("on", state.hideLowRes);
        $("#sw-p-noblur")?.classList.toggle("on", !!state.reduceBackdropBlur);
        $("#sw-p-pause-modal")?.classList.toggle("on", !!state.pauseVideoInModal);
        $("#sw-p-pause-blur")?.classList.toggle("on", !!state.pauseVideoOnBlur);
        $("#sw-p-static")?.classList.toggle("on", !!state.staticWallpaperMode);
        $("#sw-p-motion")?.classList.toggle("on", !!state.reduceMotion);
        $("#sw-acc-stop")?.classList.toggle("on", !!state.stopServerOnTabClose);
        $("#sw-acc-topbar")?.classList.toggle("on", state.showTopTabBar !== false);
        $("#seg-acc-startup")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.startup === state.accountStartupMode));
        const accMenu = $("#cs-primary-acc-menu");
        if (accMenu) {
            accMenu.querySelectorAll(".cselect-opt").forEach((o) => {
                const isAct = o.dataset.val === state.primaryAccountId;
                o.classList.toggle("active", isAct);
                if (isAct && $("#cs-primary-acc-lbl")) $("#cs-primary-acc-lbl").textContent = o.textContent;
            });
        }

        playModeSeg?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.playMode));
        timerSeg?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.dataset.mins) === state.timerMinutes));
        $("#seg-fit")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.fit === state.videoFit));
        $("#filter-tabs")?.querySelectorAll("button[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === state.mediaFilter));
        $("#seg-lang")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));

        if ($("#c-play")) $("#c-play").innerHTML = state.paused ? SVG.play : SVG.pause;
        if ($("#c-mute")) $("#c-mute").innerHTML = (state.muted || state.wallpaperVolume <= 0.001) ? SVG.volOff : SVG.volOn;
        if (drawerLabel) drawerLabel.textContent = (ru ? "Выбрать обои (" : "Choose wallpaper (") + state.videos.length + ")";

        const restoreBtn = $("#btn-restore-hidden");
        if (restoreBtn) {
            if (state.hiddenIds.length > 0) {
                restoreBtn.style.display = "inline-block";
                restoreBtn.textContent = ru
                    ? ("Вернуть скрытые обои (" + state.hiddenIds.length + ")")
                    : ("Restore hidden wallpapers (" + state.hiddenIds.length + ")");
            } else {
                restoreBtn.style.display = "none";
            }
        }

        if (typeof window.__agyGetExtrasState === "function") {
            const ex = window.__agyGetExtrasState();
            const playerOn = !!ex.showPlayer;
            const playerDis = !playerOn;
            $("#sw-w-player")?.classList.toggle("on", playerOn);
            $("#sec-w-player-children")?.classList.toggle("section-disabled", playerDis);
            const openMode = ex.playerOpenMode === "hover" || ex.playerOpenMode === "click"
                ? ex.playerOpenMode
                : (ex.hoverOpenPlayer ? "hover" : "click");
            $("#seg-w-openmode")?.querySelectorAll("button").forEach((b) => {
                b.classList.toggle("active", b.dataset.openmode === openMode);
                b.disabled = playerDis;
            });
            $("#sw-w-lyrics")?.classList.toggle("on", !!ex.showLyricsInBar);
            if ($("#sw-w-lyrics")) $("#sw-w-lyrics").disabled = playerDis;
            const eqPos = ex.eqPosition || "composer";
            $("#seg-w-eqpos")?.querySelectorAll("button").forEach((b) => {
                b.classList.toggle("active", b.dataset.eqpos === eqPos);
                b.disabled = playerDis;
            });
            if ($("#r-w-vol")) $("#r-w-vol").disabled = playerDis;
            const lSize = Number.isFinite(Number(ex.lyricsFontSize)) ? Math.max(18, Math.min(36, Math.round(Number(ex.lyricsFontSize)))) : 26;
            setR("#r-w-lsize", "#v-w-lsize", lSize, lSize + "px");
            if ($("#r-w-lsize")) $("#r-w-lsize").disabled = playerDis;
            const lOffset = Number.isFinite(Number(ex.lyricsOffsetSec)) ? Math.max(-5, Math.min(5, Number(ex.lyricsOffsetSec))) : 0;
            setR("#r-w-loffset", "#v-w-loffset", lOffset, (lOffset > 0 ? "+" : "") + lOffset.toFixed(2) + (ru ? "с" : "s"));
            if ($("#r-w-loffset")) $("#r-w-loffset").disabled = playerDis;
            const lAlign = ex.lyricsAlign === "left" ? "left" : "center";
            $("#seg-w-lalign")?.querySelectorAll("button").forEach((b) => {
                b.classList.toggle("active", b.dataset.align === lAlign);
                b.disabled = playerDis;
            });

            const ctxOn = !!ex.showContextRing;
            $("#sw-w-ctx")?.classList.toggle("on", ctxOn);
            $("#row-w-ctx-pct")?.classList.toggle("section-disabled", !ctxOn);
            const ctxPercentSwitch = $("#sw-w-ctx-pct");
            if (ctxPercentSwitch) {
                const enabled = !!ex.showContextPercent;
                ctxPercentSwitch.classList.toggle("on", enabled);
                ctxPercentSwitch.setAttribute("aria-checked", String(enabled));
                ctxPercentSwitch.disabled = !ctxOn;
            }
        }
    }

    applyPanelTranslations();
    syncControlsFromState();

    function renderVideoList(filter = "") {
        if (!listItemsEl) return;
        const q = filter.trim().toLowerCase();
        listItemsEl.innerHTML = "";
        state.videos.forEach((v, listIdx) => {
            if (q && !v.name.toLowerCase().includes(q)) return;
            const row = document.createElement("div");
            row.className = "item-row" + (listIdx === state.currentIndex ? " active" : "");

            const b = document.createElement("button");
            b.className = "item-btn";
            b.textContent = (listIdx + 1) + ". " + v.name;
            b.title = v.name + (v.width ? " (" + v.width + "×" + v.height + ")" : "");
            b.onclick = () => { playVideoAtIndex(listIdx); resetTimer(); };

            const meta = document.createElement("span");
            meta.className = "item-meta";
            meta.textContent = [v.resLabel, v.kind === "video" && v.duration ? (v.duration + (isRu() ? "с" : "s")) : ""].filter(Boolean).join(" ");

            const del = document.createElement("button");
            del.className = "item-del";
            del.innerHTML = SVG.close;
            del.title = isRu() ? "Скрыть из списка" : "Hide from list";
            del.onclick = (e) => {
                e.stopPropagation();
                if (!state.hiddenIds.includes(v.id)) state.hiddenIds.push(v.id);
                const wasCurrent = listIdx === state.currentIndex;
                rebuildFilteredList();
                syncControlsFromState();
                saveState(true);
                if (wasCurrent && state.videos.length > 0) pickRandom();
                else renderVideoList(searchInput?.value || "");
            };

            row.append(b, meta, del);
            listItemsEl.appendChild(row);
        });
    }

    backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) closeModal();
    });
    $("#btn-close").onclick = () => closeModal();
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && backdrop.classList.contains("open")) closeModal();
    });

    // One-shot luma + accent analyzer (only runs once when wallpaper changes, ZERO per-frame overhead!)
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 32; sampleCanvas.height = 18;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

    function updateLumaBadge(knownIsLight = null) {
        if (!lumaBadge) return;
        const ru = isRu();
        if (state.wallpaperEnabled === false) {
            lumaBadge.textContent = ru ? "Отключена (обычный однотонный фон)" : "Inactive (plain solid background)";
            return;
        }
        if (!state.autoContrast) {
            lumaBadge.textContent = ru ? "Выключена (только ручное затемнение)" : "Disabled (manual dimming only)";
            return;
        }
        const isLightNow = typeof knownIsLight === "boolean" ? knownIsLight : computeResolvedPalette().isLightSurface;
        const boostPct = Math.round((Number(state.lumaBoost) || 0) * 100);
        if (!state.wallpaperSampled) {
            lumaBadge.textContent = boostPct > 0
                ? (ru ? ("Включена: вуаль +" + boostPct + "% (ожидание кадра)") : ("Enabled: +" + boostPct + "% scrim (sampling frame)"))
                : (ru ? "Включена — анализ яркости фона" : "Enabled — analyzing backdrop brightness");
            return;
        }
        if (boostPct >= 1) {
            lumaBadge.textContent = isLightNow
                ? (ru ? ("Активна: +" + boostPct + "% светлой вуали для чёткости текста") : ("Active: +" + boostPct + "% light veil for legibility"))
                : (ru ? ("Активна: +" + boostPct + "% тёмной вуали от бликов обоев") : ("Active: +" + boostPct + "% dark veil against bright art"));
        } else {
            lumaBadge.textContent = ru ? "Активна: фон уже оптимального контраста" : "Active: wallpaper already has optimal contrast";
        }
    }

    function analyzeCurrentWallpaperOnce() {
        if (state.wallpaperEnabled === false) {
            state.wallpaperSampled = false;
            applyVisualVars();
            updateLumaBadge();
            return;
        }
        if (!sampleCtx || !activeMediaEl) {
            applyVisualVars();
            updateLumaBadge();
            return;
        }
        if (activeMediaEl.tagName === "VIDEO" && (activeMediaEl.readyState < 2 || activeMediaEl.videoWidth === 0)) {
            applyVisualVars();
            updateLumaBadge();
            return;
        }
        if (activeMediaEl.tagName === "IMG" && (!activeMediaEl.complete || activeMediaEl.naturalWidth === 0)) {
            applyVisualVars();
            updateLumaBadge();
            return;
        }
        try {
            sampleCtx.drawImage(activeMediaEl, 0, 0, 32, 18);
            const data = sampleCtx.getImageData(0, 0, 32, 18).data;
            const lumaSamples = [];
            let lumaSum = 0;
            let satSum = 0;
            let accR = 0, accG = 0, accB = 0, accW = 0;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                lumaSamples.push(luma);
                lumaSum += luma;
                const sat = Math.max(r, g, b) - Math.min(r, g, b);
                satSum += sat;
                if (sat > 18 && luma > 28 && luma < 235) {
                    const w = sat / 255;
                    accR += r * w; accG += g * w; accB += b * w; accW += w;
                }
            }
            const totalPx = Math.max(1, lumaSamples.length);
            const meanLuma = lumaSum / totalPx;
            const avgSat = satSum / totalPx;
            if (activeMediaEl.tagName === "VIDEO" && meanLuma < 2.5 && !state._blackFrameRetried) {
                state._blackFrameRetried = true;
                setTimeout(() => { analyzeCurrentWallpaperOnce(); }, 650);
                return;
            }
            state._blackFrameRetried = false;
            lumaSamples.sort((a, b) => a - b);
            const brightLuma = lumaSamples[Math.floor((lumaSamples.length - 1) * 0.85)] || 0;
            const darkLuma = lumaSamples[Math.floor((lumaSamples.length - 1) * 0.15)] || 0;
            const oppBright = Math.min(255, Math.round(0.65 * brightLuma + 0.35 * meanLuma + Math.min(24, avgSat * 0.25)));
            const oppDark = Math.min(255, Math.round(0.65 * (255 - darkLuma) + 0.35 * (255 - meanLuma) + Math.min(32, avgSat * 0.38)));
            state.wallpaperBrightLuma = oppBright;
            state.wallpaperDarkLuma = Math.max(0, 255 - oppDark);
            state.wallpaperSampled = true;
            if (state.adaptiveAccent && accW > 0.05) {
                const rawRgb = [Math.round(accR / accW), Math.round(accG / accW), Math.round(accB / accW)];
                const norm = normalizeAdaptiveAccent(rawRgb);
                const nextRgb = norm[0] + ", " + norm[1] + ", " + norm[2];
                const changed = nextRgb !== lastAccentRgb;
                lastAccentRgb = nextRgb;
                state.adaptiveRgb = nextRgb;
                if (changed) saveState();
            }
            applyVisualVars();
            updateLumaBadge();
            if (backdrop && backdrop.classList.contains("open")) syncControlsFromState();
        } catch {
            applyVisualVars();
            updateLumaBadge();
        }
    }

    const observer = new MutationObserver(() => { mountLayer(); mountShadow(); });
    if (document.body) observer.observe(document.body, { childList: true, subtree: false });

    function updateTitleDisplay(itemObj, statusPrefix = "") {
        if ($("#wp-counter")) $("#wp-counter").textContent = (state.currentIndex + 1) + " / " + state.videos.length;
        if ($("#wp-title") && itemObj) $("#wp-title").textContent = statusPrefix + itemObj.name;
        if ($("#wp-res-badge") && itemObj) $("#wp-res-badge").textContent = itemObj.resLabel || (itemObj.kind === "video" ? "VIDEO" : "IMG");
        if (drawerLabel) drawerLabel.textContent = (isRu() ? "Выбрать обои (" : "Choose wallpaper (") + state.videos.length + ")";
        renderVideoList(searchInput?.value || "");
    }

    function playVideoAtIndex(idx, retries = 0) {
        if (!state.videos.length) return;
        const safeIdx = ((idx % state.videos.length) + state.videos.length) % state.videos.length;
        const item = state.videos[safeIdx];
        state.currentIndex = safeIdx;
        state.currentId = item.id;
        saveState();
        if (state.wallpaperEnabled === false) {
            applyWallpaperMediaState();
            syncPreviewMedia();
            return;
        }
        updateTitleDisplay(item, isRu() ? "Загрузка: " : "Loading: ");

        const src = withToken(BASE_URL + "/stream/" + item.index);
        const isStatic = isStaticWallpaperItem(item);
        syncVideoOnlyControls();
        if (currentStreamUrl === src && ((isStatic && sceneImg.src === src) || (!isStatic && bgVideo.src === src))) {
            updateTitleDisplay(item, "");
            if (!isStatic && !state.paused && tabVisible && document.visibilityState !== "hidden") {
                bgVideo.play().catch(() => {});
            }
            syncPreviewMedia();
            setTimeout(analyzeCurrentWallpaperOnce, 120);
            return;
        }
        currentStreamUrl = src;
        const loadSeq = ++state._mediaLoadSeq || (state._mediaLoadSeq = 1);

        if (isStatic) {
            sceneImg.onload = () => {
                if (state._mediaLoadSeq !== loadSeq) return;
                sceneImg.onload = null; sceneImg.onerror = null;
                updateTitleDisplay(item, "");
                sceneImg.style.opacity = "1"; bgVideo.style.opacity = "0";
                try { bgVideo.pause(); bgVideo.removeAttribute("src"); bgVideo.load(); } catch {}
                activeMediaEl = sceneImg;
                syncPreviewMedia();
                setTimeout(analyzeCurrentWallpaperOnce, 80);
            };
            sceneImg.onerror = () => { if (state._mediaLoadSeq === loadSeq && retries < 10) pickRandom(retries + 1); };
            sceneImg.src = src;
            return;
        }

        applyVideoAudio();
        bgVideo.playbackRate = state.playbackRate;
        bgVideo.onerror = () => { if (state._mediaLoadSeq === loadSeq && retries < 10) pickRandom(retries + 1); else if (state._mediaLoadSeq === loadSeq) updateTitleDisplay(item, "Error: "); };
        let videoRevealed = false;
        const revealVideo = () => {
            if (videoRevealed || state._mediaLoadSeq !== loadSeq) return;
            videoRevealed = true;
            bgVideo.onloadeddata = null; bgVideo.oncanplay = null; bgVideo.onerror = null;
            updateTitleDisplay(item, "");
            bgVideo.style.opacity = "1"; sceneImg.style.opacity = "0";
            activeMediaEl = bgVideo;
            if (!state.paused && tabVisible && document.visibilityState !== "hidden") bgVideo.play().catch(() => {});
            else bgVideo.pause();
            syncPreviewMedia();
            setTimeout(analyzeCurrentWallpaperOnce, 180);
        };
        bgVideo.onloadeddata = revealVideo;
        bgVideo.oncanplay = revealVideo;
        bgVideo.style.opacity = "1";
        sceneImg.style.opacity = "0";
        activeMediaEl = bgVideo;
        bgVideo.src = src;
        if (!state.paused && tabVisible && document.visibilityState !== "hidden") {
            bgVideo.play().catch(() => {});
        }
        if (bgVideo.readyState >= 2) revealVideo();
    }

    function pickRandom(retries = 0) {
        if (!state.videos.length) return;
        if (state.videos.length === 1) { playVideoAtIndex(0, retries); return; }
        if (!state.shuffleBag.length) refillShuffleBag(state.currentIndex);
        let next = state.shuffleBag.pop();
        if (next === state.currentIndex && state.shuffleBag.length) {
            state.shuffleBag.unshift(next);
            next = state.shuffleBag.pop();
        }
        playVideoAtIndex(next, retries);
    }

    function resetTimer() {
        if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
        if (state.wallpaperEnabled !== false && state.playMode !== "lock" && state.timerMinutes > 0) {
            state.timerHandle = setInterval(() => {
                if (state.wallpaperEnabled !== false && !state.paused && tabVisible && document.visibilityState !== "hidden") {
                    if (state.playMode === "seq") playVideoAtIndex(state.currentIndex + 1);
                    else pickRandom();
                }
            }, state.timerMinutes * 60 * 1000);
        }
    }

    window.addEventListener("agy-toggle-style-panel", () => {
        if (backdrop.classList.contains("open")) closeModal();
        else openModal();
    });

    $("#c-prev").onclick = () => { playVideoAtIndex(state.currentIndex - 1); resetTimer(); };
    $("#c-next").onclick = () => { playVideoAtIndex(state.currentIndex + 1); resetTimer(); };
    $("#c-rand").onclick = () => { pickRandom(); resetTimer(); };
    $("#c-play").onclick = () => {
        state.paused = !state.paused;
        $("#c-play").innerHTML = state.paused ? SVG.play : SVG.pause;
        if (state.paused) { bgVideo.pause(); previewVideo?.pause(); }
        else { bgVideo.play().catch(() => {}); if (backdrop.classList.contains("open")) previewVideo?.play().catch(() => {}); }
        saveState(true);
    };
    $("#c-mute").onclick = () => {
        if (state.muted || state.wallpaperVolume <= 0.001) {
            state.muted = false;
            if (state.wallpaperVolume <= 0.001) state.wallpaperVolume = 0.35;
        } else {
            state.muted = true;
        }
        applyVideoAudio();
        syncControlsFromState();
        saveState(true);
    };
    $("#r-wp-vol").oninput = (e) => {
        beginSliderDrag();
        const v = Math.max(0, Math.min(1, parseFloat(e.target.value) || 0));
        state.wallpaperVolume = v;
        state.muted = v <= 0.001;
        applyVideoAudio();
        $("#v-wp-vol").textContent = Math.round(v * 100) + "%";
        if ($("#c-mute")) $("#c-mute").innerHTML = state.muted ? SVG.volOff : SVG.volOn;
        saveState("drag");
    };
    $("#r-wp-vol").onchange = () => { endSliderDrag(); saveState(true); };

    let wVolTimer = null;
    $("#r-w-vol").oninput = (e) => {
        const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        state.playerVolume = v;
        state.playerMuted = v === 0;
        $("#v-w-vol").textContent = v + "%";
        clearTimeout(wVolTimer);
        wVolTimer = setTimeout(() => {
            apiFetch("/media/volume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ volume: v, muted: v === 0 }),
            }).catch(() => {});
        }, 60);
    };

    $("#list-toggle").onclick = () => listBox.classList.toggle("open");
    searchInput.oninput = () => renderVideoList(searchInput.value);
    $("#btn-restore-hidden").onclick = () => {
        state.hiddenIds = [];
        applyFiltersAndReload();
    };

    function applyFiltersAndReload() {
        const curId = state.currentId;
        rebuildFilteredList();
        const foundIdx = state.videos.findIndex((v) => v.id === curId);
        if (foundIdx >= 0) state.currentIndex = foundIdx;
        else if (state.videos.length > 0) pickRandom();
        syncControlsFromState();
        renderVideoList(searchInput?.value || "");
        saveState(true);
    }

    $("#filter-tabs").querySelectorAll("button[data-filter]").forEach((b) => { b.onclick = () => { state.mediaFilter = b.dataset.filter || "all"; applyFiltersAndReload(); }; });
    $("#btn-rescan").onclick = () => {
        apiFetch("/list?refresh=1").then((r) => r.json()).then((data) => { state.allVideos = Array.isArray(data.videos) ? data.videos : []; applyFiltersAndReload(); }).catch(() => {});
    };
    $("#sw-mature").onclick = () => { state.hideMature = !state.hideMature; applyFiltersAndReload(); };
    $("#sw-lowres").onclick = () => { state.hideLowRes = !state.hideLowRes; applyFiltersAndReload(); };
    $("#seg-fit").querySelectorAll("button").forEach((b) => { b.onclick = () => { state.videoFit = b.dataset.fit === "contain" ? "contain" : "cover"; applyVisualVars(); syncControlsFromState(); saveState(true); }; });

    let dragResumeTimer = null;
    let pausedPreviewForDrag = false;
    function beginSliderDrag() {
        if (!pausedPreviewForDrag && previewVideo && !previewVideo.paused && backdrop.classList.contains("open")) {
            pausedPreviewForDrag = true;
            try { previewVideo.pause(); } catch {}
        }
        clearTimeout(dragResumeTimer);
        dragResumeTimer = setTimeout(endSliderDrag, 240);
    }
    function endSliderDrag() {
        clearTimeout(dragResumeTimer);
        dragResumeTimer = null;
        if (pausedPreviewForDrag) {
            pausedPreviewForDrag = false;
            if (backdrop.classList.contains("open") && state.activeTab === "wallpapers" && state.wallpaperEnabled !== false && !state.paused && !state.staticWallpaperMode && !state.reduceBackdropBlur && previewVideo && previewVideo.src) {
                previewVideo.play().catch(() => {});
            }
        }
        if (pendingDeferredDomSync) {
            pendingDeferredDomSync = false;
            scheduleCodeSyntaxAdapt({ full: true });
        }
    }

    $("#r-dim").oninput = (e) => {
        beginSliderDrag();
        state.dim = parseFloat(e.target.value);
        $("#v-dim").textContent = Math.round(state.dim * 100) + "%";
        scheduleVisualUpdate({ wallpaperOnly: true, wallpaperDrag: true });
        saveState("drag");
    };
    $("#r-dim").onchange = () => { endSliderDrag(); applyWallpaperLayerVarsFast(false); saveState(true); };
    $("#r-vblur").oninput = (e) => {
        beginSliderDrag();
        state.videoBlur = parseInt(e.target.value, 10);
        $("#v-vblur").textContent = state.videoBlur + "px";
        scheduleVisualUpdate({ wallpaperOnly: true, wallpaperDrag: true });
        saveState("drag");
    };
    $("#r-vblur").onchange = () => { endSliderDrag(); applyWallpaperLayerVarsFast(false); saveState(true); };
    $("#r-sat").oninput = (e) => {
        beginSliderDrag();
        state.videoSat = parseFloat(e.target.value);
        $("#v-sat").textContent = Math.round(state.videoSat * 100) + "%";
        scheduleVisualUpdate({ wallpaperOnly: true, wallpaperDrag: true });
        saveState("drag");
    };
    $("#r-sat").onchange = () => { endSliderDrag(); applyWallpaperLayerVarsFast(false); saveState(true); };
    $("#r-contrast").oninput = (e) => {
        beginSliderDrag();
        state.videoContrast = parseFloat(e.target.value);
        $("#v-contrast").textContent = Math.round(state.videoContrast * 100) + "%";
        scheduleVisualUpdate({ wallpaperOnly: true, wallpaperDrag: true });
        saveState("drag");
    };
    $("#r-contrast").onchange = () => { endSliderDrag(); applyWallpaperLayerVarsFast(false); saveState(true); };
    $("#r-speed").oninput = (e) => {
        beginSliderDrag();
        state.playbackRate = parseFloat(e.target.value);
        $("#v-speed").textContent = state.playbackRate.toFixed(2) + "×";
        bgVideo.playbackRate = state.playbackRate;
        if (previewVideo && backdrop.classList.contains("open")) previewVideo.playbackRate = state.playbackRate;
        saveState("drag");
    };
    $("#r-speed").onchange = () => { endSliderDrag(); saveState(true); };
    $("#r-alpha").oninput = (e) => {
        beginSliderDrag();
        const pct = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        state.panelAlpha = pctToPanelAlpha(pct);
        $("#v-alpha").textContent = pct + "%";
        scheduleVisualUpdate({ tokens: true, deferDomSync: true });
        saveState("drag");
    };
    $("#r-alpha").onchange = () => { endSliderDrag(); saveState(true); };
    function hexToHsl(hex) {
        const clean = String(hex || "#60a5fa").replace("#", "");
        const r = parseInt(clean.slice(0, 2), 16) / 255;
        const g = parseInt(clean.slice(2, 4), 16) / 255;
        const b = parseInt(clean.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0, l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
    }
    function hslToHex(h, s, l) {
        s /= 100; l /= 100;
        const k = (n) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
        return "#" + f(0) + f(8) + f(4);
    }
    function syncColorPickerSliders(hex) {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
        const [h, s, l] = hexToHsl(hex);
        if ($("#r-cp-h")) $("#r-cp-h").value = String(h);
        if ($("#v-cp-h")) $("#v-cp-h").textContent = h + "°";
        if ($("#r-cp-s")) $("#r-cp-s").value = String(Math.max(0, Math.min(100, s)));
        if ($("#v-cp-s")) $("#v-cp-s").textContent = s + "%";
        if ($("#r-cp-l")) $("#r-cp-l").value = String(Math.max(0, Math.min(100, l)));
        if ($("#v-cp-l")) $("#v-cp-l").textContent = l + "%";
    }
    function syncColorPickerDisplayFast(cleanHex, h, s, l) {
        const customTag = isRu() ? "Свой" : "Custom";
        if (state.activePickerTarget === "bg") {
            if ($("#dot-color-bg")) $("#dot-color-bg").style.background = cleanHex;
            if ($("#hex-color-bg")) $("#hex-color-bg").textContent = cleanHex;
            if ($("#tag-color-bg")) $("#tag-color-bg").textContent = customTag;
        } else if (state.activePickerTarget === "text") {
            if ($("#dot-color-text")) $("#dot-color-text").style.background = cleanHex;
            if ($("#hex-color-text")) $("#hex-color-text").textContent = cleanHex;
            if ($("#tag-color-text")) $("#tag-color-text").textContent = customTag;
        } else {
            if ($("#dot-color-accent")) $("#dot-color-accent").style.background = cleanHex;
            if ($("#hex-color-accent")) $("#hex-color-accent").textContent = cleanHex;
            if ($("#tag-color-accent")) $("#tag-color-accent").textContent = customTag;
            $("#sw-accent")?.classList.remove("on");
        }
        if ($("#c-picker-hex")) $("#c-picker-hex").value = cleanHex;
        if ($("#cpicker-preview")) $("#cpicker-preview").style.background = cleanHex;
        if (Number.isFinite(h) && $("#v-cp-h")) $("#v-cp-h").textContent = h + "°";
        if (Number.isFinite(s) && $("#v-cp-s")) $("#v-cp-s").textContent = s + "%";
        if (Number.isFinite(l) && $("#v-cp-l")) $("#v-cp-l").textContent = l + "%";
    }
    function applyPickerColorHex(hex, fromSliderDrag = false, hslVals = null) {
        if (!isHex6(hex)) return;
        const clean = hex.trim().toLowerCase();
        const isLightEdit = state.colorEditMode === "light";
        if (state.activePickerTarget === "bg") {
            if (isLightEdit) { state.lightCustomBgHex = clean; state.lightUseCustomBg = true; }
            else { state.darkCustomBgHex = clean; state.darkUseCustomBg = true; }
        } else if (state.activePickerTarget === "text") {
            if (isLightEdit) { state.lightCustomTextHex = clean; state.lightUseCustomText = true; }
            else { state.darkCustomTextHex = clean; state.darkUseCustomText = true; }
        } else {
            if (isLightEdit) state.lightCustomAccentHex = clean;
            else state.darkCustomAccentHex = clean;
            state.customAccentHex = clean;
            state.adaptiveAccent = false;
        }
        if (fromSliderDrag) {
            beginSliderDrag();
            syncColorPickerDisplayFast(clean, hslVals?.[0], hslVals?.[1], hslVals?.[2]);
            scheduleVisualUpdate({ tokens: true, deferDomSync: true });
            saveState("drag");
        } else {
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        }
    }
    const onHslSlider = () => {
        const h = parseInt($("#r-cp-h")?.value || "213", 10);
        const s = parseInt($("#r-cp-s")?.value || "90", 10);
        const l = parseInt($("#r-cp-l")?.value || "65", 10);
        applyPickerColorHex(hslToHex(h, s, l), true, [h, s, l]);
    };
    const onHslCommit = () => {
        endSliderDrag();
        syncControlsFromState();
        saveState(true);
    };
    if ($("#r-cp-h")) { $("#r-cp-h").oninput = onHslSlider; $("#r-cp-h").onchange = onHslCommit; }
    if ($("#r-cp-s")) { $("#r-cp-s").oninput = onHslSlider; $("#r-cp-s").onchange = onHslCommit; }
    if ($("#r-cp-l")) { $("#r-cp-l").oninput = onHslSlider; $("#r-cp-l").onchange = onHslCommit; }
    if ($("#c-picker-hex")) {
        $("#c-picker-hex").oninput = (e) => {
            const v = e.target.value.trim();
            if (isHex6(v)) applyPickerColorHex(v);
        };
    }
    for (const [id, tgt] of [["#btn-pick-bg", "bg"], ["#btn-pick-text", "text"], ["#btn-pick-accent", "accent"]]) {
        const btn = $(id);
        if (!btn) continue;
        btn.onclick = (e) => {
            e.stopPropagation();
            const pop = $("#cpicker-pop");
            const wasSameOpen = pop?.classList.contains("open") && state.activePickerTarget === tgt;
            state.activePickerTarget = tgt;
            if (pop) pop.classList.toggle("open", !wasSameOpen);
            syncControlsFromState();
        };
    }
    if ($("#btn-cp-close")) {
        $("#btn-cp-close").onclick = (e) => {
            e.stopPropagation();
            $("#cpicker-pop")?.classList.remove("open");
            syncControlsFromState();
        };
    }
    if ($("#cpicker-pop")) $("#cpicker-pop").onclick = (e) => e.stopPropagation();

    $("#seg-theme-mode")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            const nextMode = b.dataset.tmode;
            if (nextMode !== "dark" && nextMode !== "light" && nextMode !== "system") return;
            state.themeMode = nextMode;
            state.colorEditMode = resolveEffectiveThemeMode();
            applyVisualVars();
            syncControlsFromState();
            analyzeCurrentWallpaperOnce();
            saveState(true);
        };
    });
    $("#seg-color-theme")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            state.colorEditMode = b.dataset.cmode === "light" ? "light" : "dark";
            syncControlsFromState();
        };
    });
    $("#seg-ui-contrast")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            state.uiContrast = b.dataset.contrast === "high" ? "high" : "default";
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        };
    });
    if ($("#btn-reset-colors")) {
        $("#btn-reset-colors").onclick = () => {
            if (state.colorEditMode === "light") {
                state.lightUseCustomBg = false;
                state.lightUseCustomText = false;
                state.lightCustomBgHex = LIGHT_DEFAULT_BG_HEX;
                state.lightCustomTextHex = LIGHT_DEFAULT_TEXT_HEX;
                state.lightCustomAccentHex = LIGHT_DEFAULT_ACCENT_HEX;
                if (resolveEffectiveThemeMode() === "light") {
                    state.useCustomBg = false;
                    state.useCustomText = false;
                    state.customBgHex = LIGHT_DEFAULT_BG_HEX;
                    state.customTextHex = LIGHT_DEFAULT_TEXT_HEX;
                    state.customAccentHex = LIGHT_DEFAULT_ACCENT_HEX;
                }
            } else {
                state.darkUseCustomBg = false;
                state.darkUseCustomText = false;
                state.darkCustomBgHex = DARK_DEFAULT_BG_HEX;
                state.darkCustomTextHex = DARK_DEFAULT_TEXT_HEX;
                state.darkCustomAccentHex = DARK_DEFAULT_ACCENT_HEX;
                if (resolveEffectiveThemeMode() === "dark") {
                    state.useCustomBg = false;
                    state.useCustomText = false;
                    state.customBgHex = DARK_DEFAULT_BG_HEX;
                    state.customTextHex = DARK_DEFAULT_TEXT_HEX;
                    state.customAccentHex = DARK_DEFAULT_ACCENT_HEX;
                }
            }
            $("#cpicker-pop")?.classList.remove("open");
            applyVisualVars();
            syncControlsFromState();
            analyzeCurrentWallpaperOnce();
            saveState(true);
        };
    }
    if ($("#btn-switch-active-cmode")) {
        $("#btn-switch-active-cmode").onclick = () => {
            state.colorEditMode = resolveEffectiveThemeMode();
            syncControlsFromState();
        };
    }

    if ($("#cs-font-btn")) {
        $("#cs-font-btn").onclick = (e) => {
            e.stopPropagation();
            $("#cs-primary-acc")?.classList.remove("open");
            $("#cs-font")?.classList.toggle("open");
        };
    }
    if ($("#btn-open-custom-font")) {
        $("#btn-open-custom-font").onclick = () => {
            apiFetch("/fonts/open", { method: "POST" }).catch(() => {});
        };
    }
    if ($("#btn-add-custom-font")) {
        $("#btn-add-custom-font").onclick = () => {
            apiFetch("/fonts/add", { method: "POST" })
                .then((r) => r.json())
                .then((d) => {
                    if (d && Array.isArray(d.fonts)) {
                        registerCustomFonts(d.fonts);
                        if (Array.isArray(d.addedFonts) && d.addedFonts.length > 0 && d.addedFonts[0].cssValue) {
                            state.uiFontChoice = d.addedFonts[0].cssValue;
                            applyVisualVars();
                            saveState(true);
                        }
                        syncControlsFromState();
                    }
                })
                .catch(() => {});
        };
    }
    if ($("#cs-primary-acc-btn")) {
        $("#cs-primary-acc-btn").onclick = (e) => {
            e.stopPropagation();
            $("#cs-font")?.classList.remove("open");
            $("#cs-primary-acc")?.classList.toggle("open");
        };
    }
    if ($("#cpicker-pop")) $("#cpicker-pop").addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("pointerdown", (e) => {
        const p = e.composedPath ? e.composedPath() : [];
        const insideCselect = p.some((n) => n && n.classList && n.classList.contains && n.classList.contains("cselect"));
        if (!insideCselect) {
            shadow.querySelectorAll(".cselect.open").forEach((el) => el.classList.remove("open"));
        }
        const pop = $("#cpicker-pop");
        if (pop && pop.classList.contains("open")) {
            const insidePicker = p.includes(pop) || p.some((n) => n && n.classList && n.classList.contains && n.classList.contains("color-field"));
            if (!insidePicker) {
                pop.classList.remove("open");
                syncControlsFromState();
            }
        }
    });
    $("#r-fsize").oninput = (e) => {
        beginSliderDrag();
        state.fontSizePx = parseFloat(e.target.value);
        $("#v-fsize").textContent = state.fontSizePx + "px";
        scheduleVisualUpdate({ tokens: true, deferDomSync: true });
        saveState("drag");
    };
    $("#r-fsize").onchange = () => { endSliderDrag(); saveState(true); };
    $("#r-rad").oninput = (e) => {
        beginSliderDrag();
        state.radiusPx = parseInt(e.target.value, 10);
        $("#v-rad").textContent = state.radiusPx + "px";
        scheduleVisualUpdate({ tokens: true, deferDomSync: true });
        saveState("drag");
    };
    $("#r-rad").onchange = () => { endSliderDrag(); saveState(true); };
    if ($("#r-panel-blur")) {
        $("#r-panel-blur").oninput = (e) => {
            beginSliderDrag();
            const v = Math.max(0, Math.min(32, parseInt(e.target.value, 10) || 0));
            state.panelBlurPx = v;
            if (v > 0) {
                state._lastPanelBlurPx = v;
                state.reduceBackdropBlur = false;
            } else {
                state.reduceBackdropBlur = true;
            }
            if ($("#v-panel-blur")) $("#v-panel-blur").textContent = v + "px";
            $("#sw-p-noblur")?.classList.toggle("on", !!state.reduceBackdropBlur);
            scheduleVisualUpdate({ tokens: true, deferDomSync: true });
            saveState("drag");
        };
        $("#r-panel-blur").onchange = () => { endSliderDrag(); saveState(true); };
    }

    $("#sw-contrast").onclick = () => {
        state.autoContrast = !state.autoContrast;
        applyVisualVars();
        syncControlsFromState();
        if (state.autoContrast) analyzeCurrentWallpaperOnce();
        saveState(true);
    };
    if ($("#sw-privacy")) {
        $("#sw-privacy").onclick = () => { state.privacyMode = !state.privacyMode; applyVisualVars(); syncControlsFromState(); loadAccountsForTab(); saveState(true); };
    }
    $("#seg-privacy-reveal")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            if (!state.privacyMode) return;
            state.privacyRevealMode = b.dataset.reveal || "modifier";
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        };
    });
    $("#seg-privacy-style")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            if (!state.privacyMode) return;
            state.privacyHideStyle = b.dataset.pstyle === "mask" ? "mask" : "blur";
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        };
    });
    if ($("#sw-privacy-paths")) {
        $("#sw-privacy-paths").onclick = () => {
            if (!state.privacyMode) return;
            state.privacyHidePaths = state.privacyHidePaths === false ? true : false;
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        };
    }
    $("#sw-accent").onclick = () => { state.adaptiveAccent = !state.adaptiveAccent; syncControlsFromState(); if (state.adaptiveAccent) analyzeCurrentWallpaperOnce(); else applyVisualVars(); saveState(true); };

    $("#sw-w-player").onclick = (e) => { const next = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", next); window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { showPlayer: next } })); };
    $("#seg-w-openmode")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            const mode = b.dataset.openmode === "hover" ? "hover" : "click";
            $("#seg-w-openmode")?.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
            window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { playerOpenMode: mode } }));
        };
    });
    if ($("#btn-open-custom-wp")) {
        $("#btn-open-custom-wp").onclick = () => {
            apiFetch("/custom-wallpapers/open", { method: "POST" }).catch(() => {});
        };
    }
    if ($("#btn-add-custom-wp")) {
        $("#btn-add-custom-wp").onclick = () => {
            apiFetch("/custom-wallpapers/add", { method: "POST" })
                .then((r) => r.json())
                .then((d) => {
                    if (d && Array.isArray(d.videos)) {
                        state.allVideos = d.videos;
                        rebuildFilteredList();
                        if (d.added > 0 && state.videos.length > 0) {
                            const firstCustom = state.videos.findIndex((v) => v.source === "custom");
                            if (firstCustom >= 0) playVideoAtIndex(firstCustom);
                        }
                    }
                })
                .catch(() => {});
        };
    }
    $("#sw-w-lyrics").onclick = (e) => { const next = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", next); window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { showLyricsInBar: next } })); };
    $("#seg-w-eqpos")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            const pos = b.dataset.eqpos || "composer";
            $("#seg-w-eqpos")?.querySelectorAll("button").forEach((btn) => btn.classList.toggle("active", btn === b));
            window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { eqPosition: pos } }));
        };
    });
    $("#sw-w-ctx").onclick = (e) => { const next = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", next); window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { showContextRing: next } })); };
    $("#sw-w-ctx-pct").onclick = (e) => { const next = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", next); e.currentTarget.setAttribute("aria-checked", String(next)); window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { showContextPercent: next } })); };

    if ($("#sw-plain-bg")) {
        $("#sw-plain-bg").onclick = () => {
            state.wallpaperEnabled = !(state.wallpaperEnabled !== false);
            applyWallpaperMediaState();
            applyVisualVars();
            syncControlsFromState();
            if (state.wallpaperEnabled !== false && state.videos.length > 0) {
                const idx = state.currentId ? state.videos.findIndex((v) => v.id === state.currentId) : -1;
                playVideoAtIndex(idx >= 0 ? idx : (state.currentIndex >= 0 && state.currentIndex < state.videos.length ? state.currentIndex : 0));
                resetTimer();
            } else {
                resetTimer();
                analyzeCurrentWallpaperOnce();
            }
            saveState(true);
        };
    }

    $("#sw-p-noblur").onclick = () => {
        state.reduceBackdropBlur = !state.reduceBackdropBlur;
        if (state.reduceBackdropBlur) {
            if (state.panelBlurPx > 0) state._lastPanelBlurPx = state.panelBlurPx;
        } else if (!state.panelBlurPx || state.panelBlurPx <= 0) {
            state.panelBlurPx = state._lastPanelBlurPx || 20;
        }
        applyVisualVars();
        syncControlsFromState();
        saveState(true);
    };
    $("#sw-p-pause-modal").onclick = () => { state.pauseVideoInModal = !state.pauseVideoInModal; syncControlsFromState(); syncVideoPlaybackState(); saveState(true); };
    $("#sw-p-pause-blur").onclick = () => { state.pauseVideoOnBlur = !state.pauseVideoOnBlur; syncControlsFromState(); syncVideoPlaybackState(); saveState(true); };
    $("#sw-p-static").onclick = () => { state.staticWallpaperMode = !state.staticWallpaperMode; syncControlsFromState(); syncVideoPlaybackState(); saveState(true); };
    $("#sw-p-motion").onclick = () => { state.reduceMotion = !state.reduceMotion; applyVisualVars(); syncControlsFromState(); saveState(true); };
    $("#seg-acc-startup")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => { state.accountStartupMode = b.dataset.startup; syncControlsFromState(); saveState(true); };
    });
    if ($("#sw-acc-stop")) {
        $("#sw-acc-stop").onclick = () => { state.stopServerOnTabClose = !state.stopServerOnTabClose; syncControlsFromState(); saveState(true); };
    }
    if ($("#sw-acc-topbar")) {
        $("#sw-acc-topbar").onclick = () => { state.showTopTabBar = state.showTopTabBar === false ? true : false; applyVisualVars(); syncControlsFromState(); saveState(true); };
    }
    if ($("#r-w-lsize")) {
        $("#r-w-lsize").oninput = (e) => {
            const v = parseInt(e.target.value, 10);
            if ($("#v-w-lsize")) $("#v-w-lsize").textContent = v + "px";
            window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { lyricsFontSize: v } }));
        };
    }
    if ($("#r-w-loffset")) {
        $("#r-w-loffset").oninput = (e) => {
            const v = parseFloat(e.target.value);
            if ($("#v-w-loffset")) $("#v-w-loffset").textContent = (v > 0 ? "+" : "") + v.toFixed(2) + (isRu() ? "с" : "s");
            window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { lyricsOffsetSec: v } }));
        };
    }
    $("#seg-w-lalign")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
            const align = b.dataset.align === "left" ? "left" : "center";
            $("#seg-w-lalign")?.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.align === align));
            window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { lyricsAlign: align } }));
        };
    });
    if ($("#btn-open-picker")) {
        $("#btn-open-picker").onclick = () => {
            closeModal();
            apiFetch("/accounts/open-picker", { method: "POST" }).catch(() => {});
        };
    }

    $("#btn-reset").onclick = () => {
        Object.assign(state, DEFAULTS, {
            themeMode: "dark",
            uiContrast: "default",
            wallpaperEnabled: true,
            privacyMode: false,
            privacyRevealMode: "modifier",
            privacyHideStyle: "blur",
            privacyHidePaths: true,
            panelBlurPx: 20,
            colorEditMode: "dark",
            hiddenIds: [],
            adaptiveRgb: "",
            wallpaperSampled: false,
        });
        lastAccentRgb = BASE_THEME.accentRgb;
        rebuildFilteredList();
        applyWallpaperMediaState();
        bgVideo.playbackRate = state.playbackRate;
        applyVideoAudio();
        applyPanelTranslations();
        applyVisualVars();
        syncControlsFromState();
        renderVideoList(searchInput?.value || "");
        if (state.videos.length > 0 && !currentStreamUrl) {
            playVideoAtIndex(0);
        } else {
            analyzeCurrentWallpaperOnce();
        }
        resetTimer();
        saveState(true, { _reset: true });
        window.dispatchEvent(new CustomEvent("agy-extras-reset"));
        window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang } }));
    };

    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.altKey && (e.key === "w" || e.key === "W")) { e.preventDefault(); pickRandom(); resetTimer(); }
    });

    // Pause live video decoding when hidden, unfocused, static, disabled, or while settings modal is open
    let tabVisible = true;
    let windowFocused = true;
    const initTs = Date.now();
    function syncVideoPlaybackState() {
        const modalOpen = backdrop && backdrop.classList.contains("open");
        const shouldPauseBg = state.wallpaperEnabled === false
            || !tabVisible
            || state.paused
            || state.staticWallpaperMode
            || (state.pauseVideoInModal && modalOpen)
            || (state.pauseVideoOnBlur && !windowFocused);
        if (shouldPauseBg) {
            try { bgVideo.pause(); } catch {}
        } else if (bgVideo.style.display !== "none" && bgVideo.src) {
            bgVideo.play().catch(() => {});
        }
        if (modalOpen) {
            if (state.wallpaperEnabled === false || !tabVisible || state.paused || state.staticWallpaperMode) {
                try { previewVideo.pause(); } catch {}
            } else if (previewVideo.style.display !== "none" && previewVideo.src) {
                previewVideo.play().catch(() => {});
            }
        }
    }
    window.addEventListener("blur", () => {
        // Ignore transient blur events during initial tab mount/focus handoff
        if (Date.now() - initTs < 3500 && tabVisible && !document.hidden) return;
        windowFocused = false;
        syncVideoPlaybackState();
    });
    window.addEventListener("focus", () => { windowFocused = true; syncVideoPlaybackState(); });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            windowFocused = false;
        } else if (tabVisible) {
            windowFocused = true;
        }
        syncVideoPlaybackState();
    });
    bgVideo.addEventListener("pause", () => {
        if (state.wallpaperEnabled === false || activeMediaEl !== bgVideo || !bgVideo.src) return;
        const modalOpen = backdrop && backdrop.classList.contains("open");
        const shouldPauseBg = !tabVisible
            || document.hidden
            || state.paused
            || state.staticWallpaperMode
            || (state.pauseVideoInModal && modalOpen)
            || (state.pauseVideoOnBlur && !windowFocused);
        if (!shouldPauseBg) {
            setTimeout(() => {
                const modalStillOpen = backdrop && backdrop.classList.contains("open");
                if (
                    state.wallpaperEnabled !== false &&
                    bgVideo.paused &&
                    activeMediaEl === bgVideo &&
                    tabVisible &&
                    !document.hidden &&
                    !state.paused &&
                    !state.staticWallpaperMode &&
                    !(state.pauseVideoInModal && modalStillOpen) &&
                    !(state.pauseVideoOnBlur && !windowFocused)
                ) {
                    bgVideo.play().catch(() => {});
                }
            }, 60);
        }
    });
    // Startup watchdog for the first 10 seconds to ensure initial playback never gets stuck paused
    const startupWatchdog = setInterval(() => {
        if (Date.now() - initTs > 10000) {
            clearInterval(startupWatchdog);
            return;
        }
        mountLayer();
        if (state.wallpaperEnabled !== false && activeMediaEl === bgVideo && bgVideo.src && bgVideo.paused && tabVisible && !document.hidden && !state.paused && !state.staticWallpaperMode) {
            windowFocused = true;
            bgVideo.play().catch(() => {});
        }
    }, 250);
    window.addEventListener("agy-tab-visibility", (e) => {
        tabVisible = Boolean(e.detail?.visible);
        if (!tabVisible) {
            try { bgVideo.pause(); } catch {}
            try { previewVideo.pause(); } catch {}
        } else {
            windowFocused = true;
            syncVideoPlaybackState();
            if (backdrop.classList.contains("open")) {
                syncPreviewMedia();
            }
        }
    });

    // Live cross-tab appearance sync via shared SSE stream
    try {
        const wpEs = window.__agySharedEventSource || (window.__agySharedEventSource = new EventSource(withToken(BASE_URL + "/events")));
        wpEs.addEventListener("config", (ev) => {
            try {
                if (Date.now() - (window.__agyLastWpSaveTs || 0) < 450) return;
                const diskCfg = JSON.parse(ev.data);
                if (!diskCfg || typeof diskCfg !== "object") return;
                const prevId = state.currentId;
                const wasEnabled = state.wallpaperEnabled !== false;
                hydrateFromObject(diskCfg);
                const nowEnabled = state.wallpaperEnabled !== false;
                applyPanelTranslations();
                applyVisualVars();
                syncControlsFromState();
                bgVideo.playbackRate = state.playbackRate;
                applyVideoAudio();
                window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang, persist: false } }));
                if (!nowEnabled) {
                    applyWallpaperMediaState();
                    resetTimer();
                } else if (state.videos.length > 0 && (!wasEnabled || !currentStreamUrl || (state.currentId && state.currentId !== prevId))) {
                    const idx = state.currentId ? state.videos.findIndex((v) => v.id === state.currentId) : -1;
                    playVideoAtIndex(idx >= 0 ? idx : (state.currentIndex >= 0 && state.currentIndex < state.videos.length ? state.currentIndex : 0));
                    if (!tabVisible) { try { bgVideo.pause(); } catch {} }
                    resetTimer();
                }
            } catch {}
        });
        wpEs.addEventListener("fonts", (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                if (payload && Array.isArray(payload.fonts)) {
                    registerCustomFonts(payload.fonts);
                    syncControlsFromState();
                }
            } catch {}
        });
        wpEs.addEventListener("extras", (ev) => {
            try {
                const ex = JSON.parse(ev.data);
                if (ex && (ex.lang === "ru" || ex.lang === "en") && ex.lang !== state.lang) {
                    state.lang = ex.lang;
                    applyPanelTranslations();
                }
                syncControlsFromState();
            } catch {}
        });
        window.addEventListener("agy-extras-synced", () => {
            syncControlsFromState();
        });
        if (!window.__agySsePagehideHooked) {
            window.__agySsePagehideHooked = true;
            window.addEventListener("pagehide", () => {
                try { window.__agySharedEventSource?.close?.(); } catch {}
                window.__agySharedEventSource = null;
            });
        }
    } catch {}

    Promise.all([
        apiFetch("/config").then((r) => r.json()).catch(() => ({})),
        apiFetch("/list").then((r) => r.json()),
        apiFetch("/fonts/list").then((r) => r.json()).catch(() => ({ fonts: [] })),
    ])
        .then(([diskCfg, data, fontData]) => {
            if (fontData && Array.isArray(fontData.fonts)) {
                registerCustomFonts(fontData.fonts);
            }
            hydrateFromObject(diskCfg);
            applyPanelTranslations();
            applyVisualVars();
            window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang, persist: false } }));

            state.allVideos = Array.isArray(data.videos) ? data.videos : [];
            rebuildFilteredList();
            syncControlsFromState();
            if (state.wallpaperEnabled === false) {
                applyWallpaperMediaState();
                const el = $("#wp-title");
                if (el) el.textContent = isRu() ? "Обычный фон (без обоев)" : "Plain background (no wallpaper)";
            } else if (state.videos.length > 0) {
                const byId = state.currentId ? state.videos.findIndex((v) => v.id === state.currentId) : -1;
                if (byId >= 0) playVideoAtIndex(byId);
                else if (state.currentIndex >= 0 && state.currentIndex < state.videos.length) playVideoAtIndex(state.currentIndex);
                else playVideoAtIndex(0);
                if (!tabVisible) { try { bgVideo.pause(); } catch {} }
                resetTimer();
            } else {
                const el = $("#wp-title");
                if (el) el.textContent = isRu() ? "Нет обоев — нажмите «+ Добавить фото / видео»" : "No wallpapers — click «+ Add photo / video»";
            }
        })
        .catch((err) => {
            const el = $("#wp-title");
            if (el) el.textContent = "Error: " + String(err);
        });
})();`;
}

const injectedCssByWebContents = new WeakMap();

function injectWallpaperUi(hubContents, explicitProfile) {
    if (!hubContents || hubContents.isDestroyed?.()) return;
    ensureLocalServer();
    const waitAndInject = (attempt = 0) => {
        if (!hubContents || hubContents.isDestroyed?.()) return;
        if (!serverPort) {
            if (attempt < 25) {
                setTimeout(() => waitAndInject(attempt + 1), 100);
            } else {
                console.warn("[WallpaperEngine] Skipping UI injection: local server port unavailable");
            }
            return;
        }
        if (!hubContents || hubContents.isDestroyed?.()) return;
        const profile = explicitProfile || getActiveProfile();
        const curUrl = typeof hubContents.getURL === "function" ? hubContents.getURL() : "";
        if (injectedCssByWebContents.get(hubContents) !== curUrl) {
            injectedCssByWebContents.set(hubContents, curUrl);
            const css = buildInjectedCss(BASE_THEME);
            Promise.resolve(hubContents.insertCSS(css, { cssOrigin: "author" })).catch(() => {});
        }
        const tabToken = getProfileServerToken(profile);
        const js = buildInjectedJs(profile, BASE_THEME, serverPort, tabToken);
        const exJs = buildExtrasClientJs(profile, serverPort, tabToken);
        Promise.resolve(hubContents.executeJavaScript(exJs, true))
            .catch((e) => console.error("[WallpaperEngine] exJs error:", e?.message || e))
            .finally(() => {
                if (!hubContents || hubContents.isDestroyed?.()) return;
                Promise.resolve(hubContents.executeJavaScript(js, true))
                    .catch((e) => console.error("[WallpaperEngine] wpJs error:", e?.message || e));
            });
    };
    waitAndInject();
}

function readAppearanceConfig() {
    try {
        const cfgPath = getAppearanceConfigPath();
        if (fs.existsSync(cfgPath)) {
            return JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {};
        }
    } catch {}
    return {};
}

module.exports = {
    getActiveProfile,
    getLocalServerPort,
    getLocalServerToken,
    getShellServerToken,
    getProfileServerToken,
    getProfileIdForToken,
    parseByteRangeHeader,
    isValidFontMagicBytes,
    safeEqualTokens,
    validateLocalServerRequest,
    sanitizeAppearanceConfig,
    buildShellCspHeader,
    isSafeOpenDirectory,
    readAppearanceConfig,
    ensureLocalServer,
    broadcastSseEvent,
    attachWallpaperCspToSession,
    registerWallpaperScheme,
    registerWallpaperProtocol,
    injectWallpaperUi,
    scanWallpapers,
    scanCustomWallpapers,
    getCustomWallpaperDir,
    getCustomFontsDir,
    sanitizeFontFileName,
    deriveFontFamilyName,
    scanCustomFonts,
    resolveCustomFontFile,
    saveCustomFontBuffer,
    handleFontsRequest,
    buildInjectedCss,
    buildInjectedJs,
    BASE_THEME,
    IMAGE_EXTS,
    VIDEO_EXTS,
    FONT_EXTS,
    FONT_MIME_TYPES,
};
