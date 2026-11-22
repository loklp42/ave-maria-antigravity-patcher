"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
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
} = require("./agyUiContrast");

const DEFAULT_WALLPAPER_DIR = "C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960";
const VIDEO_EXTS = new Set([".mp4", ".webm", ".m4v", ".mov"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const MAX_VIDEO_DURATION_SEC = 240;
const MAX_VIDEO_SIZE_BYTES = 1200 * 1024 * 1024;
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

const BASE_THEME = {
    label: "Antigravity",
    accentRgb: "96, 165, 250",
    tintRgb: "12, 14, 20",
    uiFont: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
    monoFont: "'Cascadia Code', Consolas, monospace",
    fontSize: "14px",
};

let cachedWallpapers = null;
let serverPort = 0;
let serverStarted = false;
const sseClients = new Set();
let accountsSseWired = false;

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

function scanCustomWallpapers(customDir, results) {
    if (!customDir || !fs.existsSync(customDir)) return;
    const collect = (dir, depth) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
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

        const findDirectVideos = (dir) => {
            const out = [];
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) out.push(...findDirectVideos(p));
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
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
        res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

        try {
            const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

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
                req.on("close", () => {
                    clearInterval(ping);
                    sseClients.delete(res);
                });
                return;
            }

            if (reqUrl.pathname === "/shell/tabbar") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
                res.end(agyShellViews.renderTabBarHtml(serverPort));
                return;
            }

            if (reqUrl.pathname === "/shell/picker") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
                res.end(agyShellViews.renderPickerHtml(serverPort));
                return;
            }

            if (handleExtrasRequest(reqUrl, req, res, serverPort, broadcastSseEvent)) return;

            if (reqUrl.pathname === "/config") {
                const cfgPath = getAppearanceConfigPath();
                if (req.method === "POST") {
                    let body = "";
                    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
                    req.on("end", () => {
                        try {
                            const parsed = JSON.parse(body || "{}");
                            fs.writeFileSync(cfgPath, JSON.stringify(parsed, null, 2), "utf8");
                            if (typeof parsed.showTopTabBar === "boolean") {
                                try {
                                    const tm = require("./agyTabManager");
                                    if (tm && typeof tm.setTabBarVisible === "function") tm.setTabBarVisible(parsed.showTopTabBar);
                                } catch {}
                            }
                            broadcastSseEvent("config", parsed);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end('{"ok":true}');
                        } catch {
                            res.writeHead(400);
                            res.end('{"ok":false}');
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
                if (dir) {
                    try { require("electron").shell.openPath(dir); } catch {}
                }
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: Boolean(dir), dir }));
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
                }).then((pick) => {
                    let added = 0;
                    if (pick && !pick.canceled && Array.isArray(pick.filePaths) && dir) {
                        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
                        for (const src of pick.filePaths) {
                            try {
                                const dst = path.join(dir, path.basename(src));
                                fs.copyFileSync(src, dst);
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
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: true, added, dir, videos }));
                }).catch(() => {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end('{"ok":false}');
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
                    const match = /bytes=(\d*)-(\d*)/.exec(range);
                    const start = match && match[1] ? parseInt(match[1], 10) : 0;
                    const end = match && match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
                    if (start >= fileSize || start > end) {
                        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
                        res.end();
                        return;
                    }
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

    srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
            serverPort = addr.port;
        }
    });
}

function registerWallpaperScheme() {}

const cspHookedSessions = new WeakSet();

function attachWallpaperCspToSession(targetSession) {
    if (!targetSession || cspHookedSessions.has(targetSession)) return;
    cspHookedSessions.add(targetSession);
    try {
        targetSession.webRequest.onHeadersReceived(
            { urls: ["https://127.0.0.1:*/*", "http://127.0.0.1:*/*"] },
            (details, callback) => {
                const headers = { ...(details.responseHeaders || {}) };
                for (const key of Object.keys(headers)) {
                    if (key.toLowerCase() === "content-security-policy" && Array.isArray(headers[key])) {
                        headers[key] = headers[key].map((csp) => {
                            let updated = csp;
                            if (/media-src\s+/i.test(updated)) updated = updated.replace(/media-src\s+/i, "media-src http://127.0.0.1:* blob: data: ");
                            else updated += "; media-src 'self' http://127.0.0.1:* blob: data:";
                            if (/img-src\s+/i.test(updated)) updated = updated.replace(/img-src\s+/i, "img-src http://127.0.0.1:* blob: data: ");
                            if (/connect-src\s+/i.test(updated)) updated = updated.replace(/connect-src\s+/i, "connect-src http://127.0.0.1:* ");
                            return updated;
                        });
                    }
                }
                callback({ responseHeaders: headers });
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
    --agy-effective-alpha: 0.68;
    --agy-surface-card-alpha: 0.78;
    --agy-surface-modal-alpha: 0.86;
    --agy-luma-boost: 0;
    --agy-video-sat: 1.00;
    --agy-video-contrast: 1.00;
    --agy-video-fit: cover;

    --agy-on-solid-accent: #000000;
    --agy-on-tinted-accent: #ffffff;
    --agy-accent-text: #93c5fd;

    --shell: transparent !important;
    --shell-canvas: transparent !important;
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

:root {
    --background: transparent !important;
    --color-background: transparent !important;
    --foreground: #f8fafc !important;
    --color-foreground: #f8fafc !important;
    --sidebar: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
    --color-sidebar: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
    --sidebar-secondary: rgba(var(--agy-accent-rgb), 0.20) !important;
    --color-sidebar-secondary: rgba(var(--agy-accent-rgb), 0.20) !important;
    --sidebar-muted: rgba(255, 255, 255, 0.07) !important;
    --color-sidebar-muted: rgba(255, 255, 255, 0.07) !important;

    --card: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    --color-card: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    --card-border: rgba(255, 255, 255, 0.11) !important;
    --color-card-border: rgba(255, 255, 255, 0.11) !important;
    --glass: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    --glass-border: rgba(255, 255, 255, 0.12) !important;
    --glass-highlight: rgba(255, 255, 255, 0.08) !important;

    --onyx-frame: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
    --onyx-raised: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    --onyx-selected: rgba(var(--agy-accent-rgb), 0.20) !important;
    --onyx-well: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
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
    --code-foreground: color-mix(in srgb, #f8fafc 65%, rgb(var(--agy-accent-rgb))) !important;
    --color-code: color-mix(in srgb, #f8fafc 65%, rgb(var(--agy-accent-rgb))) !important;
    --ring: rgba(var(--agy-accent-rgb), 0.45) !important;
    --focus-ring-color: rgba(var(--agy-accent-rgb), 0.45) !important;
    --nux-focus-ring: rgba(var(--agy-accent-rgb), 0.50) !important;
    --muted: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
    --color-muted: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
    --secondary: rgba(255, 255, 255, 0.08) !important;
    --color-secondary: rgba(255, 255, 255, 0.08) !important;
    --secondary-foreground: #e2e8f0 !important;
    --color-secondary-foreground: #e2e8f0 !important;
    --border: rgba(255, 255, 255, 0.10) !important;
    --color-border: rgba(255, 255, 255, 0.10) !important;
    --card-edge: rgba(255, 255, 255, 0.10) !important;
    --sash-line: rgba(var(--agy-accent-rgb), 0.45) !important;
    --sash-glow: transparent !important;
    --editor-selection-background: rgba(var(--agy-accent-rgb), 0.30) !important;
    --editor-comment-selection-background: rgba(var(--agy-accent-rgb), 0.20) !important;

    --color-blue-300: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 70%, #ffffff) !important;
    --color-blue-400: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 85%, #ffffff) !important;
    --color-blue-500: rgb(var(--agy-accent-rgb)) !important;
    --color-blue-600: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 85%, #000000) !important;
    --color-blue-700: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 70%, #000000) !important;
    --color-blue-800: color-mix(in srgb, rgb(var(--agy-accent-rgb)) 55%, #000000) !important;
}

/* ===== 2. Root, Typography & Hardware-Accelerated Wallpaper Layer ===== */
html, body {
    background-color: #07090e !important;
    font-family: var(--agy-ui-font) !important;
    font-size: var(--agy-base-font-size) !important;
    -webkit-font-smoothing: antialiased;
}

#root, #app {
    position: relative !important;
    z-index: 1 !important;
    background: transparent !important;
    font-family: var(--agy-ui-font) !important;
    font-size: var(--agy-base-font-size);
}

code, pre, kbd, samp, .font-mono, [class*="monospace"] {
    font-family: var(--agy-mono-font) !important;
}

*::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
*::-webkit-scrollbar-track { background: transparent !important; }
*::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16) !important; border-radius: 3px !important; }
*::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.30) !important; }

#agy-wallpaper-layer {
    position: fixed !important;
    inset: 0 !important;
    z-index: 0 !important;
    pointer-events: none !important;
    overflow: hidden !important;
    background: #07090e !important;
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
    background: rgba(6, 8, 14, 0.88) !important;
    opacity: min(0.92, calc(var(--agy-wp-dim) + var(--agy-luma-boost))) !important;
    pointer-events: none !important;
}

/* ===== 3. Transparent Main Canvas & Chat Viewport ===== */
:root,
body,
.agy-shell,
.agy-sheet,
.agy-inset-shell,
.dark .agy-inset-shell,
body[data-agy-theme] .agy-inset-shell {
    --shell: transparent !important;
    --shell-canvas: transparent !important;
    --background: transparent !important;
    --color-background: transparent !important;
    --body-background: transparent !important;
}

.agy-shell,
.agy-sheet,
.agy-inset-shell,
body[data-agy-theme] .agy-shell,
body[data-agy-theme] .agy-sheet,
body[data-agy-theme] .agy-inset-shell,
[data-main-content-body],
.agy-sheet[data-sheet-inset] [data-main-content-body],
[data-split-panes] .agy-sheet[data-sheet-inset] [data-tiling-pane],
[data-split-panes] .agy-sheet[data-sheet-inset] [data-pane-id] {
    background-color: transparent !important;
    background-image: none !important;
}

[data-main-content-body] [class*="bg-gradient-to-"],
[data-main-content-body] [class*="from-background"] {
    background-image: none !important;
    background-color: transparent !important;
}

/* ===== 4. Sidebar & Conversation List (Clean, Unified Radius, Zero Glow) ===== */
[aria-label="Sidebar"] [data-testid="conversation-list-sidebar"] .bg-sidebar,
[aria-label="Sidebar"] [data-testid="project-header"],
[aria-label="Sidebar"] [data-testid="section-header"],
[aria-label="Sidebar"] [data-testid="section-header"] > div {
    background-color: transparent !important;
}

[aria-label="Sidebar"] [data-testid="project-header"]:hover {
    background-color: rgba(255, 255, 255, 0.06) !important;
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
    background-color: rgba(255, 255, 255, 0.06) !important;
    box-shadow: none !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"])[data-selected="true"],
body[data-agy-theme].dark .agy-sidebar-row[data-selected="true"] {
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
    color: rgba(241, 245, 249, 0.72) !important;
    box-shadow: none !important;
}

body[data-agy-theme] :is(.agy-sidebar-row, [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"]) .agy-row-actions button:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
}

body[data-agy-theme].dark .agy-sidebar-raised,
body[data-agy-theme] .agy-sidebar-raised {
    border-radius: var(--agy-radius-sm) !important;
    background: rgba(var(--agy-accent-rgb), 0.20) !important;
    border: 1px solid rgba(var(--agy-accent-rgb), 0.44) !important;
    box-shadow: none !important;
    color: var(--agy-on-tinted-accent) !important;
}

body[data-agy-theme].dark .agy-sidebar-raised:hover,
body[data-agy-theme] .agy-sidebar-raised:hover {
    background: rgba(var(--agy-accent-rgb), 0.28) !important;
    border-color: rgba(var(--agy-accent-rgb), 0.65) !important;
    box-shadow: none !important;
}

/* ===== 5. Composer, Voice Button, Send & Stop (Unified Radius, Zero Glow) ===== */
body[data-agy-theme] .surface-composer,
body[data-agy-theme].dark .surface-composer {
    border-radius: var(--agy-radius) !important;
    background-color: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    backdrop-filter: blur(18px) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.36) !important;
    transition: border-color 0.16s ease !important;
}

body[data-agy-theme] .surface-composer:focus-within,
body[data-agy-theme].dark .surface-composer:focus-within {
    border-color: rgba(var(--agy-accent-rgb), 0.55) !important;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.44) !important;
}

body[data-agy-theme] .surface-composer > .surface-composer-card,
body[data-agy-theme].dark .surface-composer > .surface-composer-card {
    border-radius: var(--agy-radius) !important;
    background-color: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
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
    background: rgba(255, 255, 255, 0.10) !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    color: #ffffff !important;
    box-shadow: none !important;
}

[data-testid="voice-live-pill"]:not(.bg-red-600):hover {
    background: rgba(var(--agy-accent-rgb), 0.26) !important;
    border-color: rgba(var(--agy-accent-rgb), 0.55) !important;
}

[data-testid="voice-live-pill"] svg,
[data-testid="voice-live-pill"] svg * {
    color: #ffffff !important;
    fill: currentColor !important;
}

button[data-testid="input-cancel-button"] {
    border-radius: var(--agy-radius-sm) !important;
    background-color: rgba(var(--agy-tint-rgb), 0.90) !important;
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    box-shadow: none !important;
}

button[data-testid="input-cancel-button"] > div {
    background-color: #ef4444 !important;
    width: 9px !important;
    height: 9px !important;
    border-radius: 2px !important;
    box-shadow: none !important;
}

body[data-agy-theme] .agy-user-bubble {
    border-radius: var(--agy-radius) !important;
    background-color: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    border: 1px solid rgba(255, 255, 255, 0.11) !important;
    box-shadow: none !important;
}

/* ===== 6. Titlebar, Modals, Settings, Inputs (Consistent Transparency & Unified Radius) ===== */
[data-testid="title-menu-bar"] { position: relative !important; z-index: 8500 !important; }
[data-testid="title-menu-bar"],
[data-testid="title-menu-bar"] > div,
.agy-titlebar,
.window-controls-container,
[class*="titlebar"] {
    background-color: transparent !important;
    background-image: none !important;
}

body[data-agy-theme] .surface-glass,
body[data-agy-theme] .surface-opaque,
body[data-agy-theme] .agy-dialog,
body[data-agy-theme] .settings-modal-container,
body[data-agy-theme] .agy-overlay,
body[data-agy-theme] .agy-takeover-card,
body[data-agy-theme] .agy-selection-pill,
body[data-agy-theme] .compact-tooltip,
body[data-agy-theme] .agy-toast,
body[data-agy-theme] .agy-tip-card,
body[data-agy-theme] [data-browser-occluder="true"],
[role="dialog"],
[role="menu"],
[role="listbox"],
[role="tooltip"] {
    --background: rgba(var(--agy-tint-rgb), var(--agy-surface-modal-alpha)) !important;
    --color-background: rgba(var(--agy-tint-rgb), var(--agy-surface-modal-alpha)) !important;
    --sidebar: rgba(var(--agy-tint-rgb), var(--agy-surface-modal-alpha)) !important;
    --color-sidebar: rgba(var(--agy-tint-rgb), var(--agy-surface-modal-alpha)) !important;
    --sidebar-secondary: rgba(var(--agy-accent-rgb), 0.22) !important;
    --color-sidebar-secondary: rgba(var(--agy-accent-rgb), 0.22) !important;
    --sidebar-muted: rgba(255, 255, 255, 0.06) !important;
    --color-sidebar-muted: rgba(255, 255, 255, 0.06) !important;
    background-color: rgba(var(--agy-tint-rgb), var(--agy-surface-modal-alpha)) !important;
    backdrop-filter: blur(22px) !important;
    border-color: rgba(255, 255, 255, 0.13) !important;
    border-radius: var(--agy-radius) !important;
    box-shadow: 0 18px 46px rgba(0, 0, 0, 0.62) !important;
    color: #f1f5f9 !important;
}

[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"].bg-sidebar-secondary {
    background-color: rgba(var(--agy-accent-rgb), 0.22) !important;
    border: 1px solid rgba(var(--agy-accent-rgb), 0.45) !important;
    border-radius: var(--agy-radius-sm) !important;
    box-shadow: none !important;
    color: var(--agy-on-tinted-accent) !important;
}

[data-testid="settings-sidebar"] button[data-testid^="settings-nav-item-"]:not(.bg-sidebar-secondary):hover {
    background-color: rgba(255, 255, 255, 0.06) !important;
    border-radius: var(--agy-radius-sm) !important;
}

/* Performance mode: remove heavy GPU backdrop-filter over live video */
html[data-agy-no-blur="1"] body[data-agy-theme] .surface-composer,
html[data-agy-no-blur="1"] body[data-agy-theme] .compact-tooltip,
html[data-agy-no-blur="1"] body[data-agy-theme] .agy-toast,
html[data-agy-no-blur="1"] body[data-agy-theme] .agy-tip-card,
html[data-agy-no-blur="1"] body[data-agy-theme] [data-browser-occluder="true"],
html[data-agy-no-blur="1"] [role="dialog"],
html[data-agy-no-blur="1"] [role="menu"],
html[data-agy-no-blur="1"] [role="listbox"],
html[data-agy-no-blur="1"] [role="tooltip"],
html[data-agy-no-blur="1"] #agy-ctx-pop,
html[data-agy-no-blur="1"] [data-radix-popper-content-wrapper] > *,
html[data-agy-no-blur="1"] .backdrop-blur,
html[data-agy-no-blur="1"] .backdrop-blur-sm,
html[data-agy-no-blur="1"] .backdrop-blur-md,
html[data-agy-no-blur="1"] .backdrop-blur-lg,
html[data-agy-no-blur="1"] .backdrop-blur-xl {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}

html[data-agy-reduce-motion="1"] *,
html[data-agy-reduce-motion="1"] *::before,
html[data-agy-reduce-motion="1"] *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
}

html[data-agy-no-topbar="1"] [data-testid="title-menu-bar"],
html[data-agy-no-topbar="1"] [data-testid="title-menu-bar"] *,
html[data-agy-no-topbar="1"] [style*="app-region"],
html[data-agy-no-topbar="1"] [style*="AppRegion"],
html[data-agy-no-topbar="1"] [class*="titlebar"],
html[data-agy-no-topbar="1"] [class*="drag"],
html[data-agy-no-topbar="1"] header {
    -webkit-app-region: no-drag !important;
    app-region: no-drag !important;
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
body[data-agy-theme].dark [data-slot="toggle-group"] {
    background-color: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.10) !important;
    border-radius: var(--agy-radius-sm) !important;
    padding: 2px !important;
}

body[data-agy-theme] [data-slot="toggle-group"] > :is(button, [data-pressed])[data-pressed],
body[data-agy-theme].dark [data-slot="toggle-group"] > :is(button, [data-pressed])[data-pressed],
body[data-agy-theme] [data-slot="toggle-group"] > button[aria-pressed="true"] {
    background-color: rgba(var(--agy-accent-rgb), 0.24) !important;
    border: 1px solid rgba(var(--agy-accent-rgb), 0.50) !important;
    border-radius: calc(var(--agy-radius-sm) * 0.8) !important;
    color: var(--agy-on-tinted-accent) !important;
    box-shadow: none !important;
}

body[data-agy-theme] .agy-button.bg-secondary {
    background-color: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.13) !important;
    border-radius: var(--agy-radius-sm) !important;
    color: #f8fafc !important;
}

body[data-agy-theme] .agy-button.bg-secondary:hover {
    background-color: rgba(255, 255, 255, 0.14) !important;
    border-color: rgba(255, 255, 255, 0.22) !important;
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
[data-testid="bottom-terminal-panel-sidebar"] {
    background-color: rgba(var(--agy-tint-rgb), var(--agy-effective-alpha)) !important;
}

.group\\/terminal-card,
.group\\/run-command,
.agy-select-trigger,
input.bg-background,
textarea.bg-background,
select.bg-background {
    border-radius: var(--agy-radius-sm) !important;
    background-color: rgba(var(--agy-tint-rgb), var(--agy-surface-card-alpha)) !important;
    border-color: rgba(255, 255, 255, 0.12) !important;
}

/* Unified user border-radius across pill CTA buttons, dialog controls, menus, and tooltips */
body[data-agy-theme] button.rounded-full:not([role="switch"]):not([class*="size-"]):not([class*="w-5"]):not([class*="w-6"]):not([class*="w-7"]):not([class*="w-8"]):not([class*="h-5"]):not([class*="h-6"]):not([class*="h-7"]),
body[data-agy-theme] [role="dialog"] button:not([role="switch"]):not([class*="size-"]),
body[data-agy-theme] [role="dialog"] input,
body[data-agy-theme] [role="tooltip"],
body[data-agy-theme] .agy-button {
    border-radius: var(--agy-radius-sm) !important;
}

body[data-agy-theme] [role="dialog"],
body[data-agy-theme] [role="menu"],
body[data-agy-theme] [data-radix-popper-content-wrapper] > div {
    border-radius: var(--agy-radius) !important;
}

/* Smooth cohesive entrance micro-animations for native Antigravity popovers and dialogs */
@keyframes agyUiEnter {
    from { opacity: 0; transform: translateY(4px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

html:not([data-agy-reduce-motion="1"]) body[data-agy-theme] [role="dialog"],
html:not([data-agy-reduce-motion="1"]) body[data-agy-theme] [role="menu"],
html:not([data-agy-reduce-motion="1"]) body[data-agy-theme] [role="listbox"],
html:not([data-agy-reduce-motion="1"]) body[data-agy-theme] [role="tooltip"] {
    animation: agyUiEnter 0.16s cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* Telegram-style spoiler blur for personal data (emails, account identifiers) in Privacy Mode */
html[data-agy-privacy="1"] [data-agy-spoiler="1"] {
    filter: blur(5px) !important;
    opacity: 0.82 !important;
    transition: filter 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease !important;
    cursor: pointer;
}

html[data-agy-privacy="1"] [data-agy-spoiler="1"]:hover {
    filter: none !important;
    opacity: 1 !important;
}
`;
}

function buildInjectedJs(profile, theme, port) {
    const contrastHelpers = [
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
    ].map((fn) => fn.toString()).join("\n");

    let initialMedia = null;
    try {
        const cfg = readAppearanceConfig();
        const items = scanWallpapers(false);
        if (Array.isArray(items) && items.length > 0) {
            let pick = cfg.currentId ? items.find((v) => v.id === cfg.currentId) : null;
            if (!pick && Number.isInteger(cfg.currentIndex) && items[cfg.currentIndex]) pick = items[cfg.currentIndex];
            if (!pick) pick = items[0];
            if (pick) {
                initialMedia = {
                    id: pick.id,
                    index: pick.index,
                    kind: pick.kind || "video",
                    src: `http://127.0.0.1:${Number(port)}/stream/${pick.index}`,
                };
            }
        }
    } catch {}

    return `(() => {
    if (!document.getElementById("agy-wp-injected-css")) {
        const stEl = document.createElement("style");
        stEl.id = "agy-wp-injected-css";
        stEl.textContent = ${JSON.stringify(buildInjectedCss(theme))};
        (document.head || document.documentElement).appendChild(stEl);
    }
    if (window.__agyWallpaperInitialized) return;
    window.__agyWallpaperInitialized = true;

    const BASE_THEME = ${JSON.stringify(theme)};
    const INITIAL_MEDIA = ${JSON.stringify(initialMedia)};
    ${contrastHelpers}
    const BASE_URL = "http://127.0.0.1:" + ${Number(port)};
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
        playbackRate: 1.0,
        videoSat: 1.00,
        videoContrast: 1.00,
        videoFit: "cover",
        autoContrast: true,
        adaptiveAccent: true,
        customAccentHex: "#60a5fa",
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
        shuffleBag: [],
        ...DEFAULTS,
        timerHandle: null,
        lumaBoost: 0,
        wallpaperBrightLuma: 0,
        activeTab: "wallpapers",
        playerVolume: 100,
        playerMuted: false,
    };

    function hydrateFromObject(src) {
        if (!src || typeof src !== "object") return;
        for (const k of ["timerMinutes", "dim", "videoBlur", "panelAlpha", "playbackRate", "videoSat", "videoContrast", "currentIndex", "fontSizePx", "radiusPx", "wallpaperVolume"]) {
            if (typeof src[k] === "number" && !Number.isNaN(src[k])) state[k] = src[k];
        }
        for (const k of ["paused", "muted", "autoContrast", "adaptiveAccent", "hideMature", "hideLowRes", "reduceBackdropBlur", "pauseVideoInModal", "pauseVideoOnBlur", "reduceMotion", "staticWallpaperMode", "stopServerOnTabClose", "showTopTabBar", "privacyMode"]) {
            if (typeof src[k] === "boolean") state[k] = src[k];
        }
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
        if (typeof src.customAccentHex === "string" && /^#[0-9a-fA-F]{6}$/.test(src.customAccentHex)) state.customAccentHex = src.customAccentHex;
        if (typeof src.uiFontChoice === "string" && src.uiFontChoice.trim()) state.uiFontChoice = src.uiFontChoice;
        if (src.mediaFilter === "video" || src.mediaFilter === "image" || src.mediaFilter === "all") state.mediaFilter = src.mediaFilter;
        if (src.lang === "ru" || src.lang === "en") state.lang = src.lang;
        if (typeof src.currentId === "string") state.currentId = src.currentId;
        if (Array.isArray(src.hiddenIds)) state.hiddenIds = src.hiddenIds;
    }

    try { hydrateFromObject(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); } catch {}

    let saveDebounce = null;
    function saveState(immediate = false) {
        const payload = {
            timerMinutes: state.timerMinutes,
            playMode: state.playMode,
            paused: state.paused,
            muted: state.muted,
            wallpaperVolume: state.wallpaperVolume,
            dim: state.dim,
            videoBlur: state.videoBlur,
            panelAlpha: state.panelAlpha,
            playbackRate: state.playbackRate,
            videoSat: state.videoSat,
            videoContrast: state.videoContrast,
            videoFit: state.videoFit,
            autoContrast: state.autoContrast,
            adaptiveAccent: state.adaptiveAccent,
            privacyMode: !!state.privacyMode,
            customAccentHex: state.customAccentHex,
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
            accountStartupMode: state.accountStartupMode,
            primaryAccountId: state.primaryAccountId,
            stopServerOnTabClose: state.stopServerOnTabClose,
            showTopTabBar: state.showTopTabBar,
            lang: state.lang,
            hiddenIds: state.hiddenIds,
            currentId: state.currentId,
            currentIndex: state.currentIndex,
            accentRgb: state.adaptiveAccent ? (state.adaptiveRgb || BASE_THEME.accentRgb) : undefined,
            tintRgb: BASE_THEME.tintRgb,
        };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch {}
        const flush = () => {
            window.__agyLastWpSaveTs = Date.now();
            try {
                fetch(BASE_URL + "/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                }).catch(() => {});
            } catch {}
        };
        if (immediate) { clearTimeout(saveDebounce); flush(); }
        else { clearTimeout(saveDebounce); saveDebounce = setTimeout(flush, 180); }
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
    let lastAccentRgb = BASE_THEME.accentRgb;

    function setAccentRgbEverywhere(rgb) {
        lastAccentRgb = rgb;
        const tokens = getAdaptiveThemeTokens(BASE_THEME.tintRgb, rgb, 0.24);
        const root = document.documentElement.style;
        root.setProperty("--agy-accent-rgb", rgb);
        root.setProperty("--primary", "rgb(" + rgb + ")");
        root.setProperty("--color-primary", "rgb(" + rgb + ")");
        root.setProperty("--primary-foreground", tokens.onSolidAccent);
        root.setProperty("--color-primary-foreground", tokens.onSolidAccent);
        root.setProperty("--cta-foreground", tokens.onSolidAccent);
        root.setProperty("--agy-on-solid-accent", tokens.onSolidAccent);
        root.setProperty("--agy-on-tinted-accent", tokens.onTintedAccent);
        root.setProperty("--agy-accent-text", tokens.accentText);
        root.setProperty("--link", tokens.accentText);
        root.setProperty("--color-link", tokens.accentText);

        for (const el of [shadowHost, document.getElementById("agy-extras-shadow-host")]) {
            if (!el) continue;
            el.style.setProperty("--agy-accent-rgb", rgb);
            el.style.setProperty("--agy-on-solid-accent", tokens.onSolidAccent);
            el.style.setProperty("--agy-on-tinted-accent", tokens.onTintedAccent);
            el.style.setProperty("--agy-accent-text", tokens.accentText);
        }
        window.dispatchEvent(new CustomEvent("agy-visual-sync", { detail: { accentRgb: rgb, radiusPx: state.radiusPx } }));
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

    let activeMediaEl = bgVideo;
    let currentStreamUrl = "";

    const scrim = document.createElement("div");
    scrim.id = "agy-wallpaper-scrim";
    layer.appendChild(scrim);

    const mountLayer = () => {
        if (document.body) {
            if (!document.body.hasAttribute("data-agy-theme")) {
                document.body.setAttribute("data-agy-theme", "");
            }
            if (!document.getElementById("agy-wallpaper-layer")) {
                document.body.prepend(layer);
                if (bgVideo.src && bgVideo.paused && !state.paused && !state.staticWallpaperMode) {
                    bgVideo.play().catch(() => {});
                }
            }
        }
    };
    mountLayer();

    // Start playing the active wallpaper immediately on dom-ready without waiting for /config & /list
    if (INITIAL_MEDIA && INITIAL_MEDIA.src) {
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

    function applyVideoFilterFast() {
        const needsFilter = state.videoBlur > 0 || Math.abs(state.videoSat - 1) > 0.01 || Math.abs(state.videoContrast - 1) > 0.01;
        const filterStr = needsFilter
            ? ("blur(" + state.videoBlur + "px) saturate(" + state.videoSat + ") contrast(" + state.videoContrast + ")")
            : "none";
        const scaleStr = state.videoBlur > 0 ? ("scale(" + (1 + state.videoBlur * 0.003).toFixed(3) + ") translateZ(0)") : "translateZ(0)";
        bgVideo.style.filter = filterStr;
        bgVideo.style.transform = scaleStr;
        sceneImg.style.filter = filterStr;
        sceneImg.style.transform = scaleStr;
    }

    function applyVideoAudio() {
        const vol = Math.max(0, Math.min(1, Number(state.wallpaperVolume) || 0));
        bgVideo.volume = vol;
        bgVideo.muted = state.muted || vol <= 0.001;
    }

    function applyVisualVars() {
        const root = document.documentElement.style;
        const boost = state.autoContrast ? getContrastBoost(state.wallpaperBrightLuma, state.dim) : 0;
        state.lumaBoost = boost;
        const effAlpha = Math.min(0.94, state.panelAlpha + boost);
        const cardAlpha = Math.min(0.95, effAlpha + 0.10);
        const modalAlpha = Math.min(0.96, effAlpha + 0.18);

        root.setProperty("--background", "transparent", "important");
        root.setProperty("--color-background", "transparent", "important");
        root.setProperty("--shell", "transparent", "important");
        root.setProperty("--shell-canvas", "transparent", "important");
        root.setProperty("--body-background", "transparent", "important");
        root.setProperty("--agy-wp-dim", String(state.dim));
        root.setProperty("--agy-video-blur", state.videoBlur + "px");
        root.setProperty("--agy-video-blur-num", String(state.videoBlur));
        root.setProperty("--agy-panel-alpha", String(state.panelAlpha));
        root.setProperty("--agy-effective-alpha", effAlpha.toFixed(3));
        root.setProperty("--agy-surface-card-alpha", cardAlpha.toFixed(3));
        root.setProperty("--agy-surface-modal-alpha", modalAlpha.toFixed(3));
        root.setProperty("--agy-luma-boost", boost.toFixed(3));
        root.setProperty("--agy-video-sat", String(state.videoSat));
        root.setProperty("--agy-video-contrast", String(state.videoContrast));
        root.setProperty("--agy-video-fit", state.videoFit);

        if (state.uiFontChoice) root.setProperty("--agy-ui-font", state.uiFontChoice);
        const fSize = Math.max(12, Math.min(18, Number(state.fontSizePx) || 14));
        const fontScale = (fSize / 14).toFixed(4);
        root.setProperty("--agy-base-font-size", fSize + "px");
        root.setProperty("--agy-font-scale", fontScale);

        const parsedRad = Number(state.radiusPx);
        const r = Number.isFinite(parsedRad) ? Math.max(0, Math.min(18, Math.round(parsedRad))) : DEFAULTS.radiusPx;
        const rSm = Math.max(0, Math.round(r * 0.72));
        root.setProperty("--agy-radius", r + "px");
        root.setProperty("--agy-radius-sm", rSm + "px");
        root.setProperty("--agy-radius-lg", r + "px");
        root.setProperty("--radius", r + "px", "important");
        root.setProperty("--radius-sm", rSm + "px", "important");
        root.setProperty("--radius-md", rSm + "px", "important");
        root.setProperty("--radius-lg", r + "px", "important");
        root.setProperty("--radius-xl", r + "px", "important");
        root.setProperty("--radius-2xl", r + "px", "important");
        root.setProperty("--radius-3xl", r + "px", "important");
        root.setProperty("--nux-radius-sm", rSm + "px", "important");
        root.setProperty("--nux-radius-md", r + "px", "important");
        root.setProperty("--nux-radius-lg", r + "px", "important");
        root.setProperty("--nux-radius-xl", r + "px", "important");
        for (const el of [shadowHost, document.getElementById("agy-extras-shadow-host")]) {
            if (!el) continue;
            el.style.setProperty("--agy-radius", r + "px");
            el.style.setProperty("--agy-radius-sm", rSm + "px");
            el.style.setProperty("--agy-base-font-size", fSize + "px");
            el.style.setProperty("--agy-font-scale", fontScale);
            el.style.setProperty("--agy-surface-modal-alpha", modalAlpha.toFixed(3));
            el.style.setProperty("--agy-surface-card-alpha", cardAlpha.toFixed(3));
            el.style.setProperty("--agy-effective-alpha", effAlpha.toFixed(3));
        }

        applyVideoFilterFast();
        applyVideoAudio();

        if (state.reduceBackdropBlur) document.documentElement.dataset.agyNoBlur = "1";
        else delete document.documentElement.dataset.agyNoBlur;
        if (state.reduceMotion) document.documentElement.dataset.agyReduceMotion = "1";
        else delete document.documentElement.dataset.agyReduceMotion;
        window.__agyShowTopTabBar = state.showTopTabBar !== false;
        if (!window.__agyShowTopTabBar) document.documentElement.dataset.agyNoTopbar = "1";
        else delete document.documentElement.dataset.agyNoTopbar;
        const sideAccBtn = document.getElementById("agy-accounts-side-btn");
        if (sideAccBtn) sideAccBtn.style.display = window.__agyShowTopTabBar ? "none" : "flex";
        document.documentElement.dataset.agyPrivacy = state.privacyMode ? "1" : "0";
        window.dispatchEvent(new CustomEvent("agy-privacy-sync", { detail: { privacyMode: !!state.privacyMode } }));
        const modalBackdropEl = shadowHost?.shadowRoot?.getElementById("backdrop");
        if (modalBackdropEl) {
            modalBackdropEl.classList.toggle("no-blur", !!state.reduceBackdropBlur);
        }

        if (!state.adaptiveAccent) {
            let rgb = BASE_THEME.accentRgb;
            if (state.customAccentHex && /^#[0-9a-fA-F]{6}$/.test(state.customAccentHex)) {
                const h = state.customAccentHex.slice(1);
                rgb = parseInt(h.slice(0, 2), 16) + ", " + parseInt(h.slice(2, 4), 16) + ", " + parseInt(h.slice(4, 6), 16);
            }
            setAccentRgbEverywhere(rgb);
        } else {
            setAccentRgbEverywhere(lastAccentRgb);
        }
    }
    applyVisualVars();

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
            font-family: var(--agy-ui-font, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif);
            font-size: var(--agy-base-font-size, 14px);
            color: #f1f5f9;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
            background: rgba(4, 6, 10, 0.56);
            backdrop-filter: blur(8px);
            display: none;
            align-items: center;
            justify-content: center;
            padding: 28px;
            -webkit-app-region: no-drag;
            user-select: none;
        }
        .modal-backdrop.open {
            display: flex;
            animation: modalFadeIn 0.18s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .modal-backdrop.open .panel {
            animation: panelGlideIn 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .modal-backdrop.no-blur {
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
            background: rgba(4, 6, 10, 0.64);
        }
        .modal-backdrop.no-blur .panel {
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
            background: rgba(var(--agy-tint-rgb), 0.94);
        }

        .panel {
            width: min(900px, 92vw);
            height: min(670px, 85vh);
            overflow: hidden;
            border-radius: var(--rad);
            background: rgba(var(--agy-tint-rgb), var(--modal-alpha));
            backdrop-filter: blur(26px);
            border: 1px solid rgba(255, 255, 255, 0.13);
            box-shadow: 0 28px 72px rgba(0, 0, 0, 0.72);
            display: grid;
            grid-template-columns: minmax(214px, 16em) 1fr;
        }

        .modal-nav {
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 16px 12px 14px;
            border-right: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(255, 255, 255, 0.02);
        }
        .nav-top { display: flex; flex-direction: column; gap: 14px; }
        .panel-title { font-size: 1.04em; font-weight: 600; color: #ffffff; padding: 2px 8px; }
        .tabs-bar { display: flex; flex-direction: column; gap: 4px; }
        .tab-btn {
            min-height: 2.5em; padding: 0.45em 0.75em; border-radius: calc(var(--rad) * 0.75); border: 1px solid transparent;
            background: transparent; color: #94a3b8; font-size: 0.94em; font-weight: 500;
            display: flex; align-items: center; gap: 9px; text-align: left;
            transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
        }
        .tab-btn:hover { color: #ffffff; background: rgba(255, 255, 255, 0.06); }
        .tab-btn.active {
            background: rgba(var(--agy-accent-rgb), 0.22);
            border-color: rgba(var(--agy-accent-rgb), 0.48);
            color: var(--on-tint);
            font-weight: 600;
        }

        .modal-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
        .main-head {
            display: flex; align-items: center; justify-content: space-between;
            padding: 15px 20px 13px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            flex-shrink: 0;
        }
        .main-title { font-size: 1.1em; font-weight: 600; color: #ffffff; }
        .close-btn {
            width: 28px; height: 28px; border-radius: calc(var(--rad) * 0.65);
            border: 1px solid transparent; background: transparent; color: #94a3b8;
            display: inline-flex; align-items: center; justify-content: center;
        }
        .close-btn:hover { background: rgba(255, 255, 255, 0.09); color: #ffffff; }

        .panel-body {
            flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 22px;
            display: flex; flex-direction: column; gap: 14px;
        }
        .panel-body::-webkit-scrollbar { width: 5px; }
        .panel-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); border-radius: 3px; }
        .tab-pane { display: none; flex-direction: column; gap: 14px; }
        .tab-pane.active { display: flex; }

        .preview-card {
            position: relative; width: 100%; height: 186px; border-radius: calc(var(--rad) * 0.85); overflow: hidden;
            background: #080a0f; border: 1px solid rgba(255, 255, 255, 0.10); flex-shrink: 0;
        }
        .preview-card video, .preview-card img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
        .preview-overlay {
            position: absolute; inset: 0; padding: 11px 13px;
            background: linear-gradient(180deg, rgba(0,0,0,0.48) 0%, rgba(0,0,0,0.06) 45%, rgba(0,0,0,0.88) 100%);
            display: flex; flex-direction: column; justify-content: space-between;
        }
        .preview-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .badge {
            font-size: 0.78em; font-weight: 600; padding: 3px 8px; border-radius: calc(var(--rad) * 0.55);
            background: rgba(12, 14, 20, 0.82); border: 1px solid rgba(255, 255, 255, 0.14); color: #e2e8f0;
        }
        .preview-bottom { display: flex; flex-direction: column; gap: 8px; }
        .wp-title { font-size: 0.96em; font-weight: 600; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .transport { display: flex; align-items: center; gap: 6px; }
        .cbtn {
            min-height: 2.3em; min-width: 2.4em; padding: 0.35em 0.75em; border-radius: calc(var(--rad) * 0.65);
            border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(16, 18, 26, 0.86); color: #f1f5f9;
            font-size: 0.88em; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        }
        .cbtn:hover { background: rgba(255, 255, 255, 0.18); }
        .cbtn.primary {
            flex: 1; background: rgba(var(--agy-accent-rgb), 0.26); border-color: rgba(var(--agy-accent-rgb), 0.58);
            color: var(--on-tint); font-weight: 600;
        }

        .drawer-btn {
            width: 100%; min-height: 2.6em; flex-shrink: 0; padding: 0.45em 0.85em; border-radius: calc(var(--rad) * 0.75);
            border: 1px solid rgba(255, 255, 255, 0.10); background: rgba(255, 255, 255, 0.04); color: #e2e8f0;
            font-size: 0.92em; font-weight: 500; display: flex; align-items: center; justify-content: space-between;
        }
        .drawer-btn:hover { background: rgba(255, 255, 255, 0.08); }
        .drawer-left { display: inline-flex; align-items: center; gap: 8px; }
        .list-box {
            display: none; flex-direction: column; flex-shrink: 0; gap: 8px; padding: 10px;
            border-radius: calc(var(--rad) * 0.8); background: rgba(0, 0, 0, 0.30); border: 1px solid rgba(255, 255, 255, 0.09);
        }
        .list-box.open { display: flex; }
        .filter-tabs { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; }
        .search-input {
            width: 100%; min-height: 2.3em; padding: 0.35em 0.75em; border-radius: calc(var(--rad) * 0.65);
            border: 1px solid rgba(255, 255, 255, 0.13); background: rgba(255, 255, 255, 0.05);
            color: #f8fafc; font-size: 0.92em; outline: none;
        }
        .search-input:focus { border-color: rgba(var(--agy-accent-rgb), 0.65); }
        .items-scroll { max-height: 210px; overflow-y: auto; display: block; padding-right: 3px; }
        .items-scroll::-webkit-scrollbar { width: 4px; }
        .items-scroll::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.20); border-radius: 2px; }
        .item-row { display: flex; align-items: center; gap: 5px; min-height: 2.2em; margin-bottom: 2px; border-radius: calc(var(--rad) * 0.6); padding: 0 5px 0 9px; }
        .item-row:hover { background: rgba(255, 255, 255, 0.08); }
        .item-row.active { background: rgba(var(--agy-accent-rgb), 0.22); }
        .item-btn { flex: 1; min-width: 0; height: 2.2em; line-height: 2.2em; text-align: left; border: none; background: transparent; color: #cbd5e1; font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .item-row:hover .item-btn, .item-row.active .item-btn { color: var(--on-tint); }
        .item-meta { font-size: 0.78em; color: #94a3b8; flex-shrink: 0; padding: 0 4px; }
        .item-del { width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; color: rgba(148,163,184,0.65); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .item-del svg { width: 12px; height: 12px; }
        .item-del:hover { background: rgba(239, 68, 68, 0.24); color: #fca5a5; }
        .restore-btn {
            align-self: flex-start; font-size: 0.82em; color: var(--acc-txt); background: transparent; border: none;
            padding: 2px 4px; display: none;
        }
        .restore-btn:hover { text-decoration: underline; }

        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .section { display: flex; flex-direction: column; flex-shrink: 0; gap: 6px; }
        .label-row { display: flex; align-items: center; justify-content: space-between; font-size: 0.92em; font-weight: 500; color: #e2e8f0; }
        .val-text { font-variant-numeric: tabular-nums; font-size: 0.85em; font-weight: 600; color: var(--acc-txt); }
        .segmented {
            display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; padding: 3px;
            border-radius: calc(var(--rad) * 0.75); background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .segmented.cols-3 { grid-template-columns: repeat(3, 1fr); }
        .segmented.cols-2 { grid-template-columns: repeat(2, 1fr); }
        .seg-btn {
            border: 1px solid transparent; background: transparent; color: rgba(226, 232, 240, 0.74);
            min-height: 2.15em; padding: 0.25em 0.4em; border-radius: calc(var(--rad) * 0.55); font-size: 0.88em; font-weight: 500;
        }
        .seg-btn:hover { color: #ffffff; background: rgba(255, 255, 255, 0.06); }
        .seg-btn.active {
            background: rgba(var(--agy-accent-rgb), 0.24);
            border-color: rgba(var(--agy-accent-rgb), 0.52);
            color: var(--on-tint);
            font-weight: 600;
        }

        .card-box {
            display: flex; flex-direction: column; flex-shrink: 0; gap: 12px; padding: 13px 14px;
            border-radius: calc(var(--rad) * 0.85); background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .range {
            -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
            border-radius: 2px; background: rgba(255, 255, 255, 0.16); outline: none; cursor: pointer;
        }
        .range::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%;
            background: #ffffff; border: 2px solid rgb(var(--agy-accent-rgb)); cursor: pointer;
        }
        .cselect { position: relative; width: 100%; }
        .cselect-btn {
            width: 100%; min-height: 2.4em; padding: 0.38em 0.75em;
            border-radius: calc(var(--rad) * 0.7);
            background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.11);
            color: #f1f5f9; font-size: 0.92em; font-weight: 500;
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
            transition: background 0.14s ease, border-color 0.14s ease;
        }
        .cselect-btn:hover, .cselect.open .cselect-btn {
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(var(--agy-accent-rgb), 0.55);
        }
        .cselect-btn svg { width: 14px; height: 14px; flex-shrink: 0; color: #94a3b8; transition: transform 0.14s ease; }
        .cselect.open .cselect-btn svg { transform: rotate(180deg); color: #f1f5f9; }
        .cselect-menu {
            display: none; position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 50;
            max-height: 220px; overflow-y: auto; padding: 4px;
            border-radius: calc(var(--rad) * 0.75);
            background: rgba(var(--agy-tint-rgb), 0.98);
            border: 1px solid rgba(255, 255, 255, 0.14);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        }
        .cselect.open .cselect-menu { display: flex; flex-direction: column; gap: 2px; }
        .cselect-opt {
            width: 100%; text-align: left; padding: 0.44em 0.7em;
            border-radius: calc(var(--rad) * 0.52); border: 1px solid transparent;
            background: transparent; color: #cbd5e1; font-size: 0.90em; font-weight: 500;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .cselect-opt:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
        .cselect-opt.active {
            background: rgba(var(--agy-accent-rgb), 0.24);
            border-color: rgba(var(--agy-accent-rgb), 0.50);
            color: var(--on-tint); font-weight: 600;
        }

        .cpicker-wrap { position: relative; display: inline-flex; align-items: center; gap: 8px; }
        .cpicker-btn {
            display: inline-flex; align-items: center; gap: 7px; padding: 3px 8px 3px 5px;
            border-radius: calc(var(--rad) * 0.55);
            background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14);
            color: #e2e8f0; font-size: 0.82em; font-family: 'JetBrains Mono', Consolas, monospace;
        }
        .cpicker-btn:hover { border-color: rgba(var(--agy-accent-rgb), 0.55); }
        .cpicker-dot { width: 16px; height: 16px; border-radius: calc(var(--rad) * 0.35); border: 1px solid rgba(255, 255, 255, 0.25); flex-shrink: 0; }
        .cpicker-pop {
            display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 60;
            width: 240px; padding: 12px; gap: 10px; flex-direction: column;
            border-radius: calc(var(--rad) * 0.8);
            background: rgba(var(--agy-tint-rgb), 0.98);
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 14px 36px rgba(0, 0, 0, 0.72);
        }
        .cpicker-wrap.open .cpicker-pop { display: flex; }
        .cpicker-hue {
            background: linear-gradient(90deg, #ff3b30, #ff9500, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30) !important;
            height: 8px !important; border-radius: 4px !important;
        }
        .cpicker-hex-row { display: flex; align-items: center; gap: 8px; }
        .cpicker-hex-input {
            flex: 1; min-width: 0; height: 28px; padding: 0 8px;
            border-radius: calc(var(--rad) * 0.5);
            background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14);
            color: #f8fafc; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 0.86em; outline: none;
        }
        .cpicker-hex-input:focus { border-color: rgba(var(--agy-accent-rgb), 0.65); }

        .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
        .toggle-meta { display: flex; flex-direction: column; gap: 2px; }
        .toggle-title { font-size: 0.92em; font-weight: 500; color: #f1f5f9; }
        .toggle-sub { font-size: 0.80em; color: #94a3b8; }
        .switch {
            position: relative; width: 36px; height: 20px; border-radius: calc(var(--rad) * 0.9);
            background: rgba(255, 255, 255, 0.18); border: 1px solid rgba(255, 255, 255, 0.12); flex-shrink: 0;
        }
        .switch::after {
            content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: calc(var(--rad) * 0.65); background: #ffffff; transition: transform 0.16s ease;
        }
        .switch.on { background: rgb(var(--agy-accent-rgb)); border-color: rgb(var(--agy-accent-rgb)); }
        .switch.on::after { transform: translateX(16px); }

        .swatch-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .swatch { width: 24px; height: 24px; border-radius: calc(var(--rad) * 0.5); border: 2px solid rgba(255,255,255,0.20); }
        .swatch.active { border-color: #ffffff; }

        .select-ui {
            width: 100%; min-height: 2.35em; border-radius: calc(var(--rad) * 0.65); background: rgba(18, 22, 32, 0.95);
            color: #f8fafc; border: 1px solid rgba(255, 255, 255, 0.15); padding: 0.35em 0.65em; font-size: 0.92em; outline: none;
        }

        .reset-btn {
            width: 100%; min-height: 2.4em; padding: 0.35em 0.65em; flex-shrink: 0; border-radius: calc(var(--rad) * 0.75);
            border: 1px solid rgba(255, 255, 255, 0.10); background: rgba(255, 255, 255, 0.03);
            color: #94a3b8; font-size: 0.88em; font-weight: 500;
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        }
        .reset-btn:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
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

                        <!-- TAB 2: INTERFACE -->
                        <div class="tab-pane" id="pane-theme">
                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-alpha">Плотность панелей</span><span class="val-text" id="v-alpha">68%</span></div>
                                    <input class="range" id="r-alpha" type="range" min="0.20" max="0.92" step="0.02">
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-autocontrast">Авто-контраст текста</span>
                                        <span class="toggle-sub" id="luma-badge">Анализ яркости фона</span>
                                    </div>
                                    <button class="switch" id="sw-contrast"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-privacy">Скрывать личные данные</span>
                                        <span class="toggle-sub" id="lbl-privacy-sub">Размывает почту как спойлер в Telegram (видно при наведении)</span>
                                    </div>
                                    <button class="switch" id="sw-privacy"></button>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-adapt-acc">Авто-акцент из обоев</span>
                                        <span class="toggle-sub" id="lbl-adapt-acc-sub">Подбирать цвет под фон</span>
                                    </div>
                                    <button class="switch" id="sw-accent"></button>
                                </div>
                                <div class="section">
                                    <div class="label-row">
                                        <span id="lbl-manual-acc">Цвет акцента</span>
                                        <div class="cpicker-wrap" id="cpicker-wrap">
                                            <button type="button" class="cpicker-btn" id="cpicker-btn">
                                                <span class="cpicker-dot" id="cpicker-dot"></span>
                                                <span id="cpicker-hex-lbl">#60a5fa</span>
                                            </button>
                                            <div class="cpicker-pop" id="cpicker-pop">
                                                <div class="section">
                                                    <div class="label-row"><span id="lbl-cp-h">Оттенок</span><span class="val-text" id="v-cp-h">213°</span></div>
                                                    <input class="range cpicker-hue" id="r-cp-h" type="range" min="0" max="360" step="1">
                                                </div>
                                                <div class="section">
                                                    <div class="label-row"><span id="lbl-cp-s">Насыщенность</span><span class="val-text" id="v-cp-s">93%</span></div>
                                                    <input class="range" id="r-cp-s" type="range" min="10" max="100" step="1">
                                                </div>
                                                <div class="section">
                                                    <div class="label-row"><span id="lbl-cp-l">Яркость</span><span class="val-text" id="v-cp-l">68%</span></div>
                                                    <input class="range" id="r-cp-l" type="range" min="25" max="85" step="1">
                                                </div>
                                                <div class="cpicker-hex-row">
                                                    <span class="cpicker-dot" id="cpicker-preview" style="width:24px;height:24px;"></span>
                                                    <input class="cpicker-hex-input" id="c-accent-hex" type="text" maxlength="7" spellcheck="false" value="#60a5fa">
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="swatch-row" id="accent-swatches"></div>
                                </div>
                            </div>

                            <div class="card-box">
                                <div class="section">
                                    <div class="label-row"><span id="lbl-font">Шрифт интерфейса</span></div>
                                    <div class="cselect" id="cs-font">
                                        <button type="button" class="cselect-btn" id="cs-font-btn"><span id="cs-font-lbl">Segoe UI Variable</span>\${SVG.chevronDown}</button>
                                        <div class="cselect-menu" id="cs-font-menu">
                                            <button type="button" class="cselect-opt" data-val="'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif" style="font-family:'Segoe UI Variable','Segoe UI',sans-serif;">Segoe UI Variable</button>
                                            <button type="button" class="cselect-opt" data-val="'Inter', 'Segoe UI', system-ui, sans-serif" style="font-family:'Inter','Segoe UI',sans-serif;">Inter</button>
                                            <button type="button" class="cselect-opt" data-val="'JetBrains Mono', 'Cascadia Code', Consolas, monospace" style="font-family:'JetBrains Mono',Consolas,monospace;">JetBrains Mono</button>
                                            <button type="button" class="cselect-opt" data-val="'Cascadia Code', Consolas, monospace" style="font-family:'Cascadia Code',Consolas,monospace;">Cascadia Code</button>
                                            <button type="button" class="cselect-opt" data-val="Georgia, 'Times New Roman', serif" style="font-family:Georgia,serif;">Georgia</button>
                                        </div>
                                    </div>
                                </div>
                                <div class="grid-2">
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-fsize">Размер шрифта</span><span class="val-text" id="v-fsize">14px</span></div>
                                        <input class="range" id="r-fsize" type="range" min="12" max="18" step="0.5">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-rad">Единое скругление углов</span><span class="val-text" id="v-rad">10px</span></div>
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
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-w-hover-player">Открывать мини-плеер при наведении</span>
                                        <span class="toggle-sub" id="lbl-w-hover-player-sub">Раскрывает виджет при наведении на обложку или название</span>
                                    </div>
                                    <button class="switch" id="sw-w-hover-player"></button>
                                </div>
                                <div class="toggle-row">
                                    <div class="toggle-meta">
                                        <span class="toggle-title" id="lbl-w-lyrics">Строка караоке в шапке</span>
                                        <span class="toggle-sub" id="lbl-w-lyrics-sub">Показывать текущую строку песни</span>
                                    </div>
                                    <button class="switch on" id="sw-w-lyrics"></button>
                                </div>
                                <div class="section">
                                    <div class="label-row"><span id="lbl-w-eqpos">Визуализатор бита</span></div>
                                    <div class="segmented cols-3" id="seg-w-eqpos">
                                        <button class="seg-btn active" data-eqpos="composer" id="lbl-w-eq-composer">Над полем ввода</button>
                                        <button class="seg-btn" data-eqpos="header" id="lbl-w-eq-header">В плеере</button>
                                        <button class="seg-btn" data-eqpos="off" id="lbl-w-eq-off">Скрыть</button>
                                    </div>
                                </div>
                                <div class="section">
                                    <div class="label-row"><span id="lbl-w-vol">Громкость плеера</span><span class="val-text" id="v-w-vol">100%</span></div>
                                    <input class="range" id="r-w-vol" type="range" min="0" max="100" step="1">
                                </div>
                                <div class="grid-2">
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-w-lsize">Шрифт караоке</span><span class="val-text" id="v-w-lsize">26px</span></div>
                                        <input class="range" id="r-w-lsize" type="range" min="18" max="36" step="1">
                                    </div>
                                    <div class="section">
                                        <div class="label-row"><span id="lbl-w-loffset">Сдвиг караоке</span><span class="val-text" id="v-w-loffset">0.00с</span></div>
                                        <input class="range" id="r-w-loffset" type="range" min="-3" max="3" step="0.25">
                                    </div>
                                </div>
                                <div class="section">
                                    <div class="label-row"><span id="lbl-w-lalign">Выравнивание текста караоке</span></div>
                                    <div class="segmented cols-2" id="seg-w-lalign">
                                        <button class="seg-btn active" data-align="center" id="lbl-w-la-center">По центру</button>
                                        <button class="seg-btn" data-align="left" id="lbl-w-la-left">По левому краю</button>
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
                                <div class="toggle-row">
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
            "background:rgba(var(--agy-tint-rgb,14,17,24),var(--agy-surface-modal-alpha,0.90))",
            "border:1px solid rgba(255,255,255,0.13)",
            "box-shadow:0 10px 28px rgba(0,0,0,0.52)",
            "color:#f1f5f9",
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
    const lumaBadge = $("#luma-badge");
    const drawerLabel = $("#drawer-label");
    const mainTabTitle = $("#main-tab-title");

    const swatchBox = $("#accent-swatches");
    ACCENT_SWATCHES.forEach((hex) => {
        const b = document.createElement("button");
        b.className = "swatch";
        b.dataset.hex = hex;
        b.style.background = hex;
        b.onclick = () => {
            state.customAccentHex = hex;
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
        $("#lbl-alpha").textContent = ru ? "Плотность панелей" : "Panel opacity";
        $("#lbl-autocontrast").textContent = ru ? "Авто-контраст текста" : "Auto-contrast protection";
        if ($("#lbl-privacy")) $("#lbl-privacy").textContent = ru ? "Скрывать личные данные" : "Hide personal data";
        if ($("#lbl-privacy-sub")) $("#lbl-privacy-sub").textContent = ru ? "Размывает почту как спойлер в Telegram (видно при наведении)" : "Blurs emails like Telegram spoiler (reveals on hover)";
        $("#lbl-adapt-acc").textContent = ru ? "Авто-акцент из обоев" : "Adaptive wallpaper accent";
        $("#lbl-adapt-acc-sub").textContent = ru ? "Подбирать цвет под фон" : "Match color to wallpaper";
        $("#lbl-manual-acc").textContent = ru ? "Цвет акцента" : "Accent color";
        $("#lbl-font").textContent = ru ? "Шрифт интерфейса" : "Interface font";
        $("#lbl-fsize").textContent = ru ? "Размер шрифта" : "Font size";
        $("#lbl-rad").textContent = ru ? "Единое скругление углов" : "Unified corner radius";
        $("#lbl-lang-sec").textContent = ru ? "Язык интерфейса" : "Language";
        $("#lbl-w-player").textContent = ru ? "Музыкальный плеер" : "Music player";
        $("#lbl-w-player-sub").textContent = ru ? "Панель сверху по центру и караоке" : "Top bar player & karaoke";
        if ($("#lbl-w-hover-player")) $("#lbl-w-hover-player").textContent = ru ? "Открывать мини-плеер при наведении" : "Open mini player on hover";
        if ($("#lbl-w-hover-player-sub")) $("#lbl-w-hover-player-sub").textContent = ru ? "Раскрывает виджет при наведении на обложку или название" : "Expands mini widget when hovering cover or title";
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

    function loadAccountsForTab() {
        const menu = $("#cs-primary-acc-menu");
        const lbl = $("#cs-primary-acc-lbl");
        if (!menu || !lbl) return;
        fetch(BASE_URL + "/accounts/list")
            .then((r) => r.json())
            .then((snap) => {
                const list = Array.isArray(snap?.accounts) ? snap.accounts : [];
                if (!list.length) return;
                menu.innerHTML = "";
                let activeLabel = "";
                for (const acc of list) {
                    const label = acc.name && acc.email
                        ? acc.name + " (" + acc.email + ")"
                        : (acc.name || acc.email || acc.id);
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
                lbl.textContent = activeLabel || (list[0].name || list[0].email || list[0].id);
            })
            .catch(() => {});
    }

    $("#seg-lang").querySelectorAll("button").forEach((b) => { b.onclick = () => setLanguage(b.dataset.lang); });

    function syncPlayerVolumeFromServer() {
        fetch(BASE_URL + "/media/rich")
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
        if (!isOpen) {
            try { previewVideo.pause(); previewVideo.removeAttribute("src"); previewVideo.load(); } catch {}
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

    function syncControlsFromState() {
        const ru = isRu();
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
        setR("#r-alpha", "#v-alpha", state.panelAlpha, Math.round(state.panelAlpha * 100) + "%");
        setR("#r-speed", "#v-speed", state.playbackRate, state.playbackRate.toFixed(2) + "×");
        setR("#r-sat", "#v-sat", state.videoSat, Math.round(state.videoSat * 100) + "%");
        setR("#r-contrast", "#v-contrast", state.videoContrast, Math.round(state.videoContrast * 100) + "%");
        setR("#r-fsize", "#v-fsize", state.fontSizePx, state.fontSizePx + "px");
        setR("#r-rad", "#v-rad", state.radiusPx, state.radiusPx + "px");
        const effWpVol = state.muted ? 0 : state.wallpaperVolume;
        setR("#r-wp-vol", "#v-wp-vol", effWpVol, Math.round(effWpVol * 100) + "%");
        setR("#r-w-vol", "#v-w-vol", state.playerMuted ? 0 : state.playerVolume, (state.playerMuted ? 0 : state.playerVolume) + "%");

        const hexVal = (state.customAccentHex || "#60a5fa").toLowerCase();
        if ($("#c-accent-hex")) $("#c-accent-hex").value = hexVal;
        if ($("#cpicker-hex-lbl")) $("#cpicker-hex-lbl").textContent = hexVal;
        if ($("#cpicker-dot")) $("#cpicker-dot").style.background = hexVal;
        if ($("#cpicker-preview")) $("#cpicker-preview").style.background = hexVal;
        syncColorPickerSliders(hexVal);
        swatchBox.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", !state.adaptiveAccent && s.dataset.hex.toLowerCase() === hexVal));
        const fontMenu = $("#cs-font-menu");
        if (fontMenu) {
            let matchedLbl = "Segoe UI Variable";
            fontMenu.querySelectorAll(".cselect-opt").forEach((o) => {
                const isAct = o.dataset.val === state.uiFontChoice;
                o.classList.toggle("active", isAct);
                if (isAct) matchedLbl = o.textContent;
            });
            if ($("#cs-font-lbl")) $("#cs-font-lbl").textContent = matchedLbl;
        }

        $("#sw-contrast")?.classList.toggle("on", state.autoContrast);
        $("#sw-privacy")?.classList.toggle("on", !!state.privacyMode);
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
            $("#sw-w-player")?.classList.toggle("on", !!ex.showPlayer);
        $("#sw-w-hover-player")?.classList.toggle("on", !!ex.hoverOpenPlayer);
            $("#sw-w-lyrics")?.classList.toggle("on", !!ex.showLyricsInBar);
            const eqPos = ex.eqPosition || "composer";
            $("#seg-w-eqpos")?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.eqpos === eqPos));
            $("#sw-w-ctx")?.classList.toggle("on", !!ex.showContextRing);
            const ctxPercentSwitch = $("#sw-w-ctx-pct");
            if (ctxPercentSwitch) {
                const enabled = !!ex.showContextPercent;
                ctxPercentSwitch.classList.toggle("on", enabled);
                ctxPercentSwitch.setAttribute("aria-checked", String(enabled));
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

    function analyzeCurrentWallpaperOnce() {
        if (!sampleCtx || !activeMediaEl) return;
        if (activeMediaEl.tagName === "VIDEO" && (activeMediaEl.readyState < 2 || activeMediaEl.videoWidth === 0)) return;
        if (activeMediaEl.tagName === "IMG" && (!activeMediaEl.complete || activeMediaEl.naturalWidth === 0)) return;
        try {
            sampleCtx.drawImage(activeMediaEl, 0, 0, 32, 18);
            const data = sampleCtx.getImageData(0, 0, 32, 18).data;
            const lumaSamples = [];
            let accR = 0, accG = 0, accB = 0, accW = 0;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                lumaSamples.push(luma);
                const sat = Math.max(r, g, b) - Math.min(r, g, b);
                if (sat > 18 && luma > 28 && luma < 235) {
                    const w = sat / 255;
                    accR += r * w; accG += g * w; accB += b * w; accW += w;
                }
            }
            lumaSamples.sort((a, b) => a - b);
            const brightLuma = lumaSamples[Math.floor((lumaSamples.length - 1) * 0.85)] || 0;
            state.wallpaperBrightLuma = brightLuma;
            if (state.autoContrast) {
                state.lumaBoost = getContrastBoost(brightLuma, state.dim);
                if (lumaBadge) lumaBadge.textContent = brightLuma > 112 ? (isRu() ? "Светлые области затемнены для читаемости" : "Bright areas dimmed for legibility") : (isRu() ? "Контраст достаточный" : "Contrast is sufficient");
            } else {
                state.lumaBoost = 0;
                if (lumaBadge) lumaBadge.textContent = isRu() ? "Выключен" : "Disabled";
            }
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
        } catch {}
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
        updateTitleDisplay(item, isRu() ? "Загрузка: " : "Loading: ");

        const src = BASE_URL + "/stream/" + item.index;
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

        if (isStatic) {
            sceneImg.onload = () => {
                sceneImg.onload = null; sceneImg.onerror = null;
                updateTitleDisplay(item, "");
                sceneImg.style.opacity = "1"; bgVideo.style.opacity = "0";
                try { bgVideo.pause(); } catch {}
                activeMediaEl = sceneImg;
                syncPreviewMedia();
                setTimeout(analyzeCurrentWallpaperOnce, 80);
            };
            sceneImg.onerror = () => { if (retries < 10) pickRandom(retries + 1); };
            sceneImg.src = src;
            return;
        }

        applyVideoAudio();
        bgVideo.playbackRate = state.playbackRate;
        bgVideo.onerror = () => { if (retries < 10) pickRandom(retries + 1); else updateTitleDisplay(item, "Error: "); };
        let videoRevealed = false;
        const revealVideo = () => {
            if (videoRevealed) return;
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
        if (state.playMode !== "lock" && state.timerMinutes > 0) {
            state.timerHandle = setInterval(() => {
                if (!state.paused && document.visibilityState !== "hidden") {
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
        const v = Math.max(0, Math.min(1, parseFloat(e.target.value) || 0));
        state.wallpaperVolume = v;
        state.muted = v <= 0.001;
        applyVideoAudio();
        $("#v-wp-vol").textContent = Math.round(v * 100) + "%";
        if ($("#c-mute")) $("#c-mute").innerHTML = state.muted ? SVG.volOff : SVG.volOn;
        saveState();
    };

    let wVolTimer = null;
    $("#r-w-vol").oninput = (e) => {
        const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        state.playerVolume = v;
        state.playerMuted = v === 0;
        $("#v-w-vol").textContent = v + "%";
        clearTimeout(wVolTimer);
        wVolTimer = setTimeout(() => {
            fetch(BASE_URL + "/media/volume", {
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
        fetch(BASE_URL + "/list?refresh=1").then((r) => r.json()).then((data) => { state.allVideos = Array.isArray(data.videos) ? data.videos : []; applyFiltersAndReload(); }).catch(() => {});
    };
    $("#sw-mature").onclick = () => { state.hideMature = !state.hideMature; applyFiltersAndReload(); };
    $("#sw-lowres").onclick = () => { state.hideLowRes = !state.hideLowRes; applyFiltersAndReload(); };
    $("#seg-fit").querySelectorAll("button").forEach((b) => { b.onclick = () => { state.videoFit = b.dataset.fit === "contain" ? "contain" : "cover"; applyVisualVars(); syncControlsFromState(); saveState(true); }; });

    $("#r-dim").oninput = (e) => { state.dim = parseFloat(e.target.value); $("#v-dim").textContent = Math.round(state.dim * 100) + "%"; applyVisualVars(); saveState(); };
    $("#r-vblur").oninput = (e) => { state.videoBlur = parseInt(e.target.value, 10); $("#v-vblur").textContent = state.videoBlur + "px"; applyVisualVars(); saveState(); };
    $("#r-sat").oninput = (e) => { state.videoSat = parseFloat(e.target.value); $("#v-sat").textContent = Math.round(state.videoSat * 100) + "%"; applyVisualVars(); saveState(); };
    $("#r-contrast").oninput = (e) => { state.videoContrast = parseFloat(e.target.value); $("#v-contrast").textContent = Math.round(state.videoContrast * 100) + "%"; applyVisualVars(); saveState(); };
    $("#r-speed").oninput = (e) => {
        state.playbackRate = parseFloat(e.target.value);
        $("#v-speed").textContent = state.playbackRate.toFixed(2) + "×";
        bgVideo.playbackRate = state.playbackRate;
        if (previewVideo && backdrop.classList.contains("open")) previewVideo.playbackRate = state.playbackRate;
        saveState();
    };
    $("#r-alpha").oninput = (e) => { state.panelAlpha = parseFloat(e.target.value); $("#v-alpha").textContent = Math.round(state.panelAlpha * 100) + "%"; applyVisualVars(); saveState(); };
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
        if ($("#r-cp-s")) $("#r-cp-s").value = String(Math.max(10, Math.min(100, s)));
        if ($("#v-cp-s")) $("#v-cp-s").textContent = s + "%";
        if ($("#r-cp-l")) $("#r-cp-l").value = String(Math.max(25, Math.min(85, l)));
        if ($("#v-cp-l")) $("#v-cp-l").textContent = l + "%";
    }
    function applyCustomColorHex(hex) {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
        state.customAccentHex = hex.toLowerCase();
        state.adaptiveAccent = false;
        applyVisualVars();
        syncControlsFromState();
        saveState();
    }
    const onHslSlider = () => {
        const h = parseInt($("#r-cp-h")?.value || "213", 10);
        const s = parseInt($("#r-cp-s")?.value || "90", 10);
        const l = parseInt($("#r-cp-l")?.value || "65", 10);
        applyCustomColorHex(hslToHex(h, s, l));
    };
    if ($("#r-cp-h")) $("#r-cp-h").oninput = onHslSlider;
    if ($("#r-cp-s")) $("#r-cp-s").oninput = onHslSlider;
    if ($("#r-cp-l")) $("#r-cp-l").oninput = onHslSlider;
    if ($("#c-accent-hex")) {
        $("#c-accent-hex").oninput = (e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) applyCustomColorHex(v);
        };
    }
    if ($("#cpicker-btn")) {
        $("#cpicker-btn").onclick = (e) => {
            e.stopPropagation();
            shadow.querySelectorAll(".cselect.open").forEach((el) => el.classList.remove("open"));
            $("#cpicker-wrap")?.classList.toggle("open");
        };
    }
    if ($("#cpicker-pop")) $("#cpicker-pop").onclick = (e) => e.stopPropagation();

    if ($("#cs-font-btn")) {
        $("#cs-font-btn").onclick = (e) => {
            e.stopPropagation();
            $("#cpicker-wrap")?.classList.remove("open");
            $("#cs-primary-acc")?.classList.remove("open");
            $("#cs-font")?.classList.toggle("open");
        };
    }
    $("#cs-font-menu")?.querySelectorAll(".cselect-opt").forEach((opt) => {
        opt.onclick = (e) => {
            e.stopPropagation();
            state.uiFontChoice = opt.dataset.val;
            $("#cs-font")?.classList.remove("open");
            applyVisualVars();
            syncControlsFromState();
            saveState(true);
        };
    });
    if ($("#cs-primary-acc-btn")) {
        $("#cs-primary-acc-btn").onclick = (e) => {
            e.stopPropagation();
            $("#cpicker-wrap")?.classList.remove("open");
            $("#cs-font")?.classList.remove("open");
            $("#cs-primary-acc")?.classList.toggle("open");
        };
    }
    panel.addEventListener("click", () => {
        shadow.querySelectorAll(".cselect.open").forEach((el) => el.classList.remove("open"));
        $("#cpicker-wrap")?.classList.remove("open");
    });
    $("#r-fsize").oninput = (e) => { state.fontSizePx = parseFloat(e.target.value); $("#v-fsize").textContent = state.fontSizePx + "px"; applyVisualVars(); saveState(); };
    $("#r-rad").oninput = (e) => { state.radiusPx = parseInt(e.target.value, 10); $("#v-rad").textContent = state.radiusPx + "px"; applyVisualVars(); saveState(); };

    $("#sw-contrast").onclick = () => { state.autoContrast = !state.autoContrast; syncControlsFromState(); analyzeCurrentWallpaperOnce(); saveState(true); };
    if ($("#sw-privacy")) {
        $("#sw-privacy").onclick = () => { state.privacyMode = !state.privacyMode; applyVisualVars(); syncControlsFromState(); saveState(true); };
    }
    $("#sw-accent").onclick = () => { state.adaptiveAccent = !state.adaptiveAccent; syncControlsFromState(); if (state.adaptiveAccent) analyzeCurrentWallpaperOnce(); else applyVisualVars(); saveState(true); };

    $("#sw-w-player").onclick = (e) => { const next = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", next); window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { showPlayer: next } })); };
    if ($("#sw-w-hover-player")) {
        $("#sw-w-hover-player").onclick = (e) => { const next = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", next); window.dispatchEvent(new CustomEvent("agy-extras-pref", { detail: { hoverOpenPlayer: next } })); };
    }
    if ($("#btn-open-custom-wp")) {
        $("#btn-open-custom-wp").onclick = () => {
            fetch(BASE_URL + "/custom-wallpapers/open", { method: "POST" }).catch(() => {});
        };
    }
    if ($("#btn-add-custom-wp")) {
        $("#btn-add-custom-wp").onclick = () => {
            fetch(BASE_URL + "/custom-wallpapers/add", { method: "POST" })
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

    $("#sw-p-noblur").onclick = () => { state.reduceBackdropBlur = !state.reduceBackdropBlur; applyVisualVars(); syncControlsFromState(); saveState(true); };
    $("#sw-p-pause-modal").onclick = () => { state.pauseVideoInModal = !state.pauseVideoInModal; syncControlsFromState(); syncVideoPlaybackState(); saveState(true); };
    $("#sw-p-pause-blur").onclick = () => { state.pauseVideoOnBlur = !state.pauseVideoOnBlur; syncControlsFromState(); syncVideoPlaybackState(); saveState(true); };
    $("#sw-p-static").onclick = () => { state.staticWallpaperMode = !state.staticWallpaperMode; syncControlsFromState(); syncVideoPlaybackState(); saveState(true); };
    $("#sw-p-motion").onclick = () => { state.reduceMotion = !state.reduceMotion; applyVisualVars(); syncControlsFromState(); saveState(true); };
    $("#seg-acc-startup")?.querySelectorAll("button").forEach((b) => {
        b.onclick = () => { state.accountStartupMode = b.dataset.startup; syncControlsFromState(); saveState(true); };
    });
    if ($("#s-primary-acc")) {
        $("#s-primary-acc").onchange = (e) => { state.primaryAccountId = e.target.value; saveState(true); };
    }
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
            fetch(BASE_URL + "/accounts/open-picker", { method: "POST" }).catch(() => {});
        };
    }

    $("#btn-reset").onclick = () => {
        Object.assign(state, DEFAULTS, { hiddenIds: [] });
        rebuildFilteredList();
        bgVideo.playbackRate = state.playbackRate;
        applyVideoAudio();
        applyPanelTranslations();
        applyVisualVars();
        syncControlsFromState();
        renderVideoList(searchInput?.value || "");
        analyzeCurrentWallpaperOnce();
        resetTimer();
        saveState(true);
        window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang } }));
    };

    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.altKey && (e.key === "w" || e.key === "W")) { e.preventDefault(); pickRandom(); resetTimer(); }
    });

    // Pause live video decoding when hidden, unfocused, static, or while settings modal is open
    let tabVisible = true;
    let windowFocused = true;
    const initTs = Date.now();
    function syncVideoPlaybackState() {
        const modalOpen = backdrop && backdrop.classList.contains("open");
        const shouldPauseBg = !tabVisible
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
            if (!tabVisible || state.paused || state.staticWallpaperMode) {
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
        if (activeMediaEl !== bgVideo || !bgVideo.src) return;
        const modalOpen = backdrop && backdrop.classList.contains("open");
        const shouldPauseBg = !tabVisible
            || document.hidden
            || state.paused
            || state.staticWallpaperMode
            || (state.pauseVideoInModal && modalOpen)
            || (state.pauseVideoOnBlur && !windowFocused);
        if (!shouldPauseBg) {
            setTimeout(() => {
                if (bgVideo.paused && activeMediaEl === bgVideo && tabVisible && !state.paused && !state.staticWallpaperMode) {
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
        if (activeMediaEl === bgVideo && bgVideo.src && bgVideo.paused && tabVisible && !document.hidden && !state.paused && !state.staticWallpaperMode) {
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
        const wpEs = window.__agySharedEventSource || (window.__agySharedEventSource = new EventSource(BASE_URL + "/events"));
        wpEs.addEventListener("config", (ev) => {
            try {
                if (Date.now() - (window.__agyLastWpSaveTs || 0) < 450) return;
                const diskCfg = JSON.parse(ev.data);
                if (!diskCfg || typeof diskCfg !== "object") return;
                const prevId = state.currentId;
                hydrateFromObject(diskCfg);
                applyPanelTranslations();
                applyVisualVars();
                syncControlsFromState();
                bgVideo.playbackRate = state.playbackRate;
                applyVideoAudio();
                window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang, persist: false } }));
                if (state.currentId && state.currentId !== prevId && state.videos.length > 0) {
                    const idx = state.videos.findIndex((v) => v.id === state.currentId);
                    if (idx >= 0) {
                        playVideoAtIndex(idx);
                        if (!tabVisible) { try { bgVideo.pause(); } catch {} }
                    }
                }
            } catch {}
        });
    } catch {}

    Promise.all([
        fetch(BASE_URL + "/config").then((r) => r.json()).catch(() => ({})),
        fetch(BASE_URL + "/list").then((r) => r.json()),
    ])
        .then(([diskCfg, data]) => {
            hydrateFromObject(diskCfg);
            applyPanelTranslations();
            applyVisualVars();
            window.dispatchEvent(new CustomEvent("agy-set-lang", { detail: { lang: state.lang, persist: false } }));

            state.allVideos = Array.isArray(data.videos) ? data.videos : [];
            rebuildFilteredList();
            syncControlsFromState();
            if (state.videos.length > 0) {
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
        if (!serverPort && attempt < 25) {
            setTimeout(() => waitAndInject(attempt + 1), 100);
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
        const js = buildInjectedJs(profile, BASE_THEME, serverPort);
        const exJs = buildExtrasClientJs(profile, serverPort);
        Promise.resolve(hubContents.executeJavaScript(exJs, true)).catch((e) => console.error("[WallpaperEngine] exJs error:", e?.message || e));
        Promise.resolve(hubContents.executeJavaScript(js, true)).catch((e) => console.error("[WallpaperEngine] wpJs error:", e?.message || e));
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
    IMAGE_EXTS,
    VIDEO_EXTS,
};
