"use strict";
const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");
const { mediaDaemon, fetchLyrics, getCoverByHash } = require("./agyMediaDaemon");
const accounts = require("./agyAccounts");
const pathsMod = require("./paths");
const { buildI18nClientJs } = require("./agyI18n");
const {
    parseRgb,
    relativeLuminance,
    contrastRatio,
    blendRgbOver,
    rgbToHex,
    getAccessibleTextPalette,
    ensureReadableAccentOnSurface,
    getAdaptiveThemeTokens,
} = require("./agyUiContrast");

function readJsonBody(req, maxBytes = 200000) {
    return new Promise((resolve) => {
        let body = "";
        let done = false;
        const finish = (val) => { if (done) return; done = true; resolve(val); };
        req.on("data", (c) => {
            body += c;
            if (body.length > maxBytes) { req.destroy(); finish({}); }
        });
        req.on("end", () => { try { finish(JSON.parse(body || "{}")); } catch { finish({}); } });
        req.on("error", () => finish({}));
    });
}

function getTabManager() {
    try { return require("./agyTabManager"); } catch { return null; }
}

function getExtrasConfigPath() {
    const dir = pathsMod && typeof pathsMod.getSharedConfigDir === "function"
        ? pathsMod.getSharedConfigDir()
        : app.getPath("userData");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return path.join(dir, "agy_extras_settings.json");
}

function hasPriorOnboardingInAppStorage() {
    try {
        const storagePath = pathsMod && typeof pathsMod.getAppStoragePath === "function"
            ? pathsMod.getAppStoragePath()
            : path.join(app.getPath("userData"), "app_storage.json");
        if (!storagePath || !fs.existsSync(storagePath)) return false;
        const parsed = JSON.parse(fs.readFileSync(storagePath, "utf8"));
        if (!parsed || typeof parsed !== "object") return false;
        return Boolean(
            (typeof parsed["agy.onboarding.lastLoginUsername"] === "string" && parsed["agy.onboarding.lastLoginUsername"].trim()) ||
            (typeof parsed["jetski.onboarding.lastLoginUsername"] === "string" && parsed["jetski.onboarding.lastLoginUsername"].trim())
        );
    } catch {
        return false;
    }
}

function readExtrasConfigSync() {
    let data = {};
    try {
        const cfgPath = getExtrasConfigPath();
        if (fs.existsSync(cfgPath)) {
            const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                data = parsed;
            }
        }
    } catch {}
    if (!data.onboardingAcceptedV2 && (data.onboardingDismissed === true || hasPriorOnboardingInAppStorage())) {
        data = { ...data, onboardingDismissed: true, onboardingAcceptedV2: true };
    }
    return data;
}

function mergeExtrasConfig(existing, incoming) {
    const prev = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    const next = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
    const merged = { ...prev, ...next };

    // Never allow an unhydrated tab/startup sync to overwrite an already-accepted onboarding flag back to false
    const prevProfiles = prev.onboardingDismissedProfiles && typeof prev.onboardingDismissedProfiles === "object"
        ? prev.onboardingDismissedProfiles
        : {};
    const nextProfiles = next.onboardingDismissedProfiles && typeof next.onboardingDismissedProfiles === "object"
        ? next.onboardingDismissedProfiles
        : {};
    const mergedProfiles = { ...prevProfiles, ...nextProfiles };
    if (Object.keys(mergedProfiles).length > 0) {
        merged.onboardingDismissedProfiles = mergedProfiles;
    }

    const wasAccepted = prev.onboardingDismissed === true || prev.onboardingAcceptedV2 === true;
    const nowAccepted = next.onboardingDismissed === true || next.onboardingAcceptedV2 === true || Object.values(mergedProfiles).some(Boolean);
    if (wasAccepted || nowAccepted) {
        merged.onboardingDismissed = true;
        merged.onboardingAcceptedV2 = true;
    }
    return merged;
}

function sendJson(res, status, obj) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(obj));
}

function handleExtrasRequest(reqUrl, req, res, _serverPort, broadcastSseEvent) {
    const p = reqUrl.pathname;

    // ===== Media SMTC, Volume, Hi-Res Cover & Lyrics =====
    if (p === "/media/rich") {
        const force = reqUrl.searchParams.get("force") === "1";
        mediaDaemon.getStatus(force).then((data) => sendJson(res, 200, data));
        return true;
    }

    if (p === "/media/cover") {
        const key = reqUrl.searchParams.get("key") || "";
        const entry = getCoverByHash(key);
        if (!entry || !entry.buf) {
            res.writeHead(404);
            res.end();
            return true;
        }
        res.writeHead(200, {
            "Content-Type": entry.mime || "image/jpeg",
            "Content-Length": String(entry.buf.length),
            "Cache-Control": "no-cache",
        });
        res.end(entry.buf);
        return true;
    }

    if (p === "/media/playpause" || p === "/media/next" || p === "/media/prev") {
        const cmd = p.slice("/media/".length);
        mediaDaemon.control(cmd).then((r) => sendJson(res, 200, r || { ok: true }));
        return true;
    }

    if (p === "/media/seek" && req.method === "POST") {
        readJsonBody(req).then((body) => {
            const sec = Number(body.sec);
            if (!Number.isFinite(sec) || sec < 0) {
                sendJson(res, 400, { ok: false, error: "invalid_sec" });
                return;
            }
            mediaDaemon.control("seek", { sec }).then((r) => sendJson(res, 200, r || { ok: true }));
        });
        return true;
    }

    if (p === "/media/volume" && req.method === "POST") {
        readJsonBody(req).then((body) => {
            mediaDaemon.setVolume({
                volume: body.volume,
                muted: typeof body.muted === "boolean" ? body.muted : undefined,
            }).then((r) => sendJson(res, 200, r || { ok: false }));
        });
        return true;
    }

    if (p === "/media/select-session" && req.method === "POST") {
        readJsonBody(req).then((body) => sendJson(res, 200, mediaDaemon.selectSession(body.app || "")));
        return true;
    }

    if (p === "/media/lyrics") {
        const artist = reqUrl.searchParams.get("artist") || "";
        const title = reqUrl.searchParams.get("title") || "";
        const duration = Number(reqUrl.searchParams.get("duration") || 0);
        fetchLyrics(artist, title, duration).then((data) => sendJson(res, 200, data));
        return true;
    }

    // ===== Seamless Multi-Account Management (Isolated Windows Users + WebContentsView Tabs) =====
    if (p === "/accounts/list") {
        sendJson(res, 200, accounts.getAccountsSnapshot());
        return true;
    }

    if (p === "/accounts/sync-current" && req.method === "POST") {
        readJsonBody(req).then((body) => {
            const targetId = (body && typeof body.accountId === "string" && body.accountId.trim())
                ? body.accountId.trim()
                : accounts.getActiveProfileId();
            accounts.syncCurrentAccount(targetId, body || {});
            sendJson(res, 200, { ok: true, ...accounts.getAccountsSnapshot() });
        });
        return true;
    }

    if (p === "/accounts/add" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const result = await accounts.addAccount(body.label || body.name || "", !!body.openInNewWindow);
            sendJson(res, result.ok ? 200 : 500, result);
        });
        return true;
    }

    if (p === "/accounts/repair-isolation" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const result = await accounts.repairAccountIsolation(body.id);
            sendJson(res, result.ok ? 200 : 500, result);
        });
        return true;
    }

    if (p === "/accounts/grant-folder" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            try {
                const tm = getTabManager();
                const owner = tm?.getMainWindow?.() || undefined;
                const dlgOpts = {
                    properties: ["openDirectory"],
                    title: "Select project folder to grant account access",
                };
                const pickedRes = owner
                    ? await dialog.showOpenDialog(owner, dlgOpts)
                    : await dialog.showOpenDialog(dlgOpts);
                if (pickedRes.canceled || !pickedRes.filePaths?.length) {
                    sendJson(res, 200, { ok: false, canceled: true });
                    return;
                }
                const folder = pickedRes.filePaths[0];
                const grantRes = await accounts.grantFolderAccessForAccount(body.id, folder);
                sendJson(res, grantRes.ok ? 200 : 500, { ...grantRes, folder });
            } catch (err) {
                sendJson(res, 500, { ok: false, message: String(err?.message || err) });
            }
        });
        return true;
    }

    if (p === "/accounts/rename" && req.method === "POST") {
        readJsonBody(req).then((body) => {
            const result = accounts.renameAccount(body.id, body.label || body.name || "");
            sendJson(res, result.ok ? 200 : 400, result);
        });
        return true;
    }

    if (p === "/accounts/stop-server" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const result = await accounts.stopAccountServer(body.id, true);
            sendJson(res, result.ok ? 200 : 400, result);
        });
        return true;
    }

    if (p === "/accounts/delete" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const result = await accounts.deleteAccount(body.id, accounts.getActiveProfileId(), body.purgeData !== false);
            sendJson(res, result.ok ? 200 : 400, result);
        });
        return true;
    }

    if (p === "/accounts/switch" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const result = await accounts.switchAccount(body.id, accounts.getActiveProfileId(), !!body.openInNewWindow);
            sendJson(res, result.ok ? 200 : 500, result);
        });
        return true;
    }

    // ===== BaseWindow WebContentsView Tabs Control =====
    if (p === "/tabs/open" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const tm = getTabManager();
            if (!tm || !tm.hasMainWindow?.()) {
                const fallback = await accounts.switchAccount(body.id, accounts.getActiveProfileId(), false);
                sendJson(res, fallback.ok ? 200 : 500, fallback);
                return;
            }
            const resObj = await tm.openOrActivateAccount(body.id);
            sendJson(res, resObj.ok ? 200 : 500, resObj);
        });
        return true;
    }

    if (p === "/tabs/close" && req.method === "POST") {
        readJsonBody(req).then(async (body) => {
            const tm = getTabManager();
            if (!tm || !tm.hasMainWindow?.()) {
                sendJson(res, 400, { ok: false, error: "no_tab_window" });
                return;
            }
            const resObj = await tm.closeAccountTab(body.id, { stopServer: body.stopServer !== false });
            sendJson(res, resObj.ok ? 200 : 400, resObj);
        });
        return true;
    }

    if (p === "/tabs/show-picker" && req.method === "POST") {
        const tm = getTabManager();
        const ok = Boolean(tm && tm.showPicker?.());
        sendJson(res, ok ? 200 : 400, { ok });
        return true;
    }

    if (p === "/tabs/bar-height" && req.method === "POST") {
        readJsonBody(req).then((body) => {
            const tm = getTabManager();
            const h = tm?.setTabBarHeight?.(body.height) || 40;
            sendJson(res, 200, { ok: true, height: h });
        });
        return true;
    }

    // ===== Extras Config Persistence (Shared Across All Tabs) =====
    if (p === "/extras/config") {
        const cfgPath = getExtrasConfigPath();
        if (req.method === "POST") {
            readJsonBody(req).then((body) => {
                try {
                    const existing = readExtrasConfigSync();
                    const merged = mergeExtrasConfig(existing, body);
                    fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2), "utf8");
                    if (typeof broadcastSseEvent === "function") {
                        broadcastSseEvent("extras", merged);
                    }
                    sendJson(res, 200, { ok: true, config: merged });
                } catch {
                    sendJson(res, 500, { ok: false });
                }
            });
            return true;
        }
        sendJson(res, 200, readExtrasConfigSync());
        return true;
    }

    return false;
}

function buildExtrasClientJs(profile, port) {
    const i18nJs = buildI18nClientJs();
    const initialDiskConfig = readExtrasConfigSync();
    const contrastHelpers = [
        parseRgb,
        relativeLuminance,
        contrastRatio,
        blendRgbOver,
        rgbToHex,
        getAccessibleTextPalette,
        ensureReadableAccentOnSurface,
        getAdaptiveThemeTokens,
    ].map((fn) => fn.toString()).join("\n");

    const mainExtrasJs = `(() => {
    if (window.__agyExtrasInitialized) return;
    window.__agyExtrasInitialized = true;

    const PROFILE = ${JSON.stringify(profile)};
    const BASE_URL = "http://127.0.0.1:" + ${Number(port)};
    const INITIAL_DISK_CONFIG = ${JSON.stringify(initialDiskConfig)};
    ${contrastHelpers}
    const EX_KEY = "agy_extras_v4";

    const exState = {
        lang: "ru",
        showPlayer: true,
        hoverOpenPlayer: false,
        showLyricsInBar: true,
        eqPosition: "composer", // "composer" | "header" | "off"
        showContextRing: true,
        showContextPercent: false,
        lyricsFontSize: 26,
        lyricsAlign: "center",
        lyricsOffsetSec: 0,
        onboardingDismissed: false,
        onboardingAcceptedV2: false,
        onboardingDismissedProfiles: {},
    };

    function applySavedObject(src) {
        if (!src || typeof src !== "object") return;
        if (src.lang === "en" || src.lang === "ru") exState.lang = src.lang;
        if (typeof src.showPlayer === "boolean") exState.showPlayer = src.showPlayer;
        if (typeof src.hoverOpenPlayer === "boolean") exState.hoverOpenPlayer = src.hoverOpenPlayer;
        if (typeof src.showLyricsInBar === "boolean") exState.showLyricsInBar = src.showLyricsInBar;
        if (src.eqPosition === "composer" || src.eqPosition === "header" || src.eqPosition === "off") exState.eqPosition = src.eqPosition;
        if (typeof src.showContextRing === "boolean") exState.showContextRing = src.showContextRing;
        if (typeof src.showContextPercent === "boolean") exState.showContextPercent = src.showContextPercent;
        if (Number.isFinite(Number(src.lyricsFontSize))) exState.lyricsFontSize = Math.max(18, Math.min(36, Math.round(Number(src.lyricsFontSize))));
        if (src.lyricsAlign === "left" || src.lyricsAlign === "center") exState.lyricsAlign = src.lyricsAlign;
        if (Number.isFinite(Number(src.lyricsOffsetSec))) exState.lyricsOffsetSec = Math.max(-5, Math.min(5, Math.round(Number(src.lyricsOffsetSec) * 4) / 4));
        if (src.onboardingDismissed === true) exState.onboardingDismissed = true;
        if (src.onboardingAcceptedV2 === true) {
            exState.onboardingAcceptedV2 = true;
            exState.onboardingDismissed = true;
        }
        if (src.onboardingDismissedProfiles && typeof src.onboardingDismissedProfiles === "object") {
            exState.onboardingDismissedProfiles = Object.assign({}, exState.onboardingDismissedProfiles, src.onboardingDismissedProfiles);
        }
    }

    try {
        const saved = JSON.parse(localStorage.getItem(EX_KEY) || "{}");
        if (saved && typeof saved === "object") {
            if (typeof saved.showContextPercent === "boolean") exState.showContextPercent = saved.showContextPercent;
            applySavedObject(saved);
        }
    } catch {}
    // Disk config is shared across all dynamic ports and takes precedence
    applySavedObject(INITIAL_DISK_CONFIG);

    function isOnboardingAccepted() {
        return Boolean(
            exState.onboardingDismissed ||
            exState.onboardingAcceptedV2 ||
            (exState.onboardingDismissedProfiles && exState.onboardingDismissedProfiles[PROFILE])
        );
    }

    function markOnboardingAccepted() {
        exState.onboardingDismissed = true;
        exState.onboardingAcceptedV2 = true;
        if (!exState.onboardingDismissedProfiles || typeof exState.onboardingDismissedProfiles !== "object") {
            exState.onboardingDismissedProfiles = {};
        }
        exState.onboardingDismissedProfiles[PROFILE] = true;
        saveEx();
    }

    function saveEx() {
        try { localStorage.setItem(EX_KEY, JSON.stringify(exState)); } catch {}
        try {
            fetch(BASE_URL + "/extras/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(exState),
            }).catch(() => {});
        } catch {}
    }

    const isRu = () => exState.lang !== "en";
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    if (window.__agyI18n) window.__agyI18n.setLang(exState.lang);

    window.addEventListener("agy-set-lang", (e) => {
        const next = e.detail?.lang === "en" ? "en" : "ru";
        const changed = next !== exState.lang;
        exState.lang = next;
        if (window.__agyI18n) window.__agyI18n.setLang(next);
        if (e.detail?.persist !== false && changed) {
            saveEx();
        }
        refreshAllCustomLabels();
    });

    window.addEventListener("agy-extras-pref", (e) => {
        const d = e.detail || {};
        if (typeof d.showPlayer === "boolean") exState.showPlayer = d.showPlayer;
        if (typeof d.hoverOpenPlayer === "boolean") {
            exState.hoverOpenPlayer = d.hoverOpenPlayer;
            if (!exState.hoverOpenPlayer && typeof closeHoverOpenedCard === "function") {
                closeHoverOpenedCard();
            }
        }
        if (typeof d.showLyricsInBar === "boolean") exState.showLyricsInBar = d.showLyricsInBar;
        if (d.eqPosition === "composer" || d.eqPosition === "header" || d.eqPosition === "off") exState.eqPosition = d.eqPosition;
        if (typeof d.showContextRing === "boolean") exState.showContextRing = d.showContextRing;
        if (typeof d.showContextPercent === "boolean") exState.showContextPercent = d.showContextPercent;
        if (Number.isFinite(Number(d.lyricsFontSize))) exState.lyricsFontSize = Math.max(18, Math.min(36, Math.round(Number(d.lyricsFontSize))));
        if (d.lyricsAlign === "left" || d.lyricsAlign === "center") exState.lyricsAlign = d.lyricsAlign;
        if (Number.isFinite(Number(d.lyricsOffsetSec))) exState.lyricsOffsetSec = Math.max(-5, Math.min(5, Math.round(Number(d.lyricsOffsetSec) * 4) / 4));
        if (typeof applyLyricsPrefs === "function") applyLyricsPrefs();
        saveEx();
        applyExtrasVisibility();
        mountAndSyncComposerEq();
        updateContextRingUi();
    });

    window.__agyGetExtrasState = () => Object.assign({}, exState);

    // ===== React Fiber / Redux Live Introspection =====
    let cachedStore = null;

    function getReactFiber(domEl) {
        if (!domEl) return null;
        for (const k of Object.keys(domEl)) {
            if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return domEl[k];
        }
        return null;
    }

    function findReduxStore() {
        if (cachedStore && typeof cachedStore.getState === "function") return cachedStore;
        const root = document.getElementById("root");
        const start = getReactFiber(root) || getReactFiber(root && root.firstElementChild);
        if (!start) return null;
        const stack = [start];
        let visited = 0;
        while (stack.length && visited < 400) {
            const f = stack.pop();
            visited++;
            if (!f) continue;
            const val = f.memoizedProps?.value;
            if (val && typeof val === "object") {
                if (val.store && typeof val.store.getState === "function") { cachedStore = val.store; return cachedStore; }
                if (typeof val.getState === "function" && typeof val.dispatch === "function") { cachedStore = val; return cachedStore; }
            }
            if (f.memoizedProps?.store && typeof f.memoizedProps.store.getState === "function") { cachedStore = f.memoizedProps.store; return cachedStore; }
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
        }
        return null;
    }

    function findCascadeContextFromDom() {
        const anchor = document.querySelector('[data-testid="voice-live-pill"]') || document.querySelector('button[data-testid="send-button"]') || document.querySelector('[data-main-content-body]') || document.getElementById("root");
        let f = getReactFiber(anchor);
        let hops = 0;
        while (f && hops < 120) {
            hops++;
            const val = f.memoizedProps?.value;
            if (val && typeof val === "object" && val.cascadeContext && val.cascadeContext.state) return val;
            if (f.memoizedProps && f.memoizedProps.cascadeContext && f.memoizedProps.cascadeContext.state) return f.memoizedProps;
            f = f.return;
        }
        return null;
    }

    function inferModelMaxTokens(modelLabel) {
        const s = String(modelLabel || "").toLowerCase();
        if (s.includes("1m") || s.includes("1,000,000")) return 1000000;
        if (s.includes("2m")) return 2000000;
        if (s.includes("gemini")) return 1000000;
        if (s.includes("claude")) return 200000;
        if (s.includes("gpt-4.1") || s.includes("gpt-5")) return 1000000;
        if (s.includes("gpt-4o") || s.includes("o1") || s.includes("o3") || s.includes("o4")) return 200000;
        if (s.includes("deepseek")) return 128000;
        return 200000;
    }

    function extractUserTelemetryFromUserStatus(us) {
        if (!us || typeof us !== "object") return null;
        const displayName = String(us.name || "").trim();
        const email = String(us.email || "").trim();
        const avatar = String(us.profilePictureUrl || "").trim();

        let tier = null;
        const ut = us.userTier;
        const ps = us.planStatus;
        const pi = ps?.planInfo || us.planInfo;
        const tierName = String(ut?.name || pi?.planName || pi?.teamsTier || "").trim();
        const planName = String(pi?.planName || ut?.name || "").trim();
        if (tierName || planName) {
            tier = {
                id: String(ut?.id || "").trim(),
                name: tierName || planName,
                planName: planName || tierName,
                promptCreditsUsed: ps?.usedPromptCredits ?? null,
                promptCreditsAvail: ps?.availablePromptCredits ?? null,
                flowCreditsUsed: ps?.usedFlowCredits ?? null,
                flowCreditsAvail: ps?.availableFlowCredits ?? null,
            };
        }

        const normalizeResetTime = (raw) => {
            if (!raw) return "";
            if (typeof raw === "string") return raw.trim();
            if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString();
            if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
                const ms = raw < 1e12 ? raw * 1000 : raw;
                return new Date(ms).toISOString();
            }
            if (typeof raw === "object") {
                const sec = Number(raw.seconds ?? raw.sec ?? raw.unixSeconds ?? 0);
                const nanos = Number(raw.nanos ?? raw.nanoseconds ?? 0);
                if (Number.isFinite(sec) && sec > 0) {
                    const ms = sec * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
                    return new Date(ms).toISOString();
                }
                if (typeof raw.iso === "string") return raw.iso.trim();
                if (typeof raw.value === "string") return raw.value.trim();
            }
            return "";
        };

        // Group models dynamically by their actual shared quota pool (remainingFraction + resetTime)
        // so models sharing a single pool (e.g. Gemini Models, Claude & GPT) are shown once,
        // while models with independent limits (e.g. Gemini 4 Argon or per-model tiers) stay separate.
        const rawEntries = [];
        const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
        if (Array.isArray(configs)) {
            for (const c of configs) {
                if (!c || typeof c !== "object") continue;
                const label = String(c.label || c.modelOrAlias?.value || c.modelId || "").trim();
                if (!label) continue;
                const qi = c.quotaInfo;
                if (!qi || typeof qi !== "object") continue;
                const frac = Number(qi.remainingFraction ?? qi.remaining_fraction);
                const resetTime = normalizeResetTime(qi.resetTime ?? qi.reset_time);
                if (!Number.isFinite(frac) && !resetTime) continue;
                rawEntries.push({
                    modelId: String(c.modelOrAlias?.value || c.modelId || label),
                    label,
                    remainingFraction: Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : -1,
                    resetTime,
                });
            }
        }

        const classifyFamily = (lbl) => {
            const s = lbl.toLowerCase();
            if (s.includes("argon")) return "argon";
            if (s.includes("gemini")) return "gemini";
            if (s.includes("claude") || s.includes("sonnet") || s.includes("opus") || s.includes("haiku") || s.includes("gpt") || /\bo[134]\b/.test(s)) return "claude_gpt";
            return "other:" + s;
        };

        const poolMap = new Map();
        for (const item of rawEntries) {
            const fam = classifyFamily(item.label);
            const fracKey = item.remainingFraction >= 0 ? Math.round(item.remainingFraction * 1000) : -1;
            const poolKey = fam + "|" + fracKey + "|" + item.resetTime;
            let group = poolMap.get(poolKey);
            if (!group) {
                group = { fam, items: [], remainingFraction: item.remainingFraction, resetTime: item.resetTime };
                poolMap.set(poolKey, group);
            }
            group.items.push(item);
        }

        const quotas = [];
        for (const group of poolMap.values()) {
            let poolLabel = group.items[0].label;
            if (group.items.length > 1) {
                if (group.fam === "gemini") poolLabel = "Gemini Models";
                else if (group.fam === "claude_gpt") {
                    const hasClaude = group.items.some((x) => /claude|sonnet|opus|haiku/i.test(x.label));
                    const hasGpt = group.items.some((x) => /gpt|\bo[134]\b/i.test(x.label));
                    if (hasClaude && hasGpt) poolLabel = "Claude & GPT";
                    else if (hasClaude) poolLabel = "Claude Models";
                    else if (hasGpt) poolLabel = "GPT Models";
                }
            }
            quotas.push({
                modelId: group.items[0].modelId,
                label: poolLabel,
                remainingFraction: group.remainingFraction,
                resetTime: group.resetTime,
            });
        }

        if (!displayName && !email && !tier && quotas.length === 0) return null;
        return { displayName, email, avatar, tier, quotas };
    }

    function detectAgentAttentionState(st) {
        let waitingForUser = false;
        let runningCount = null;
        try {
            const summaries = st?.cascade?.summaries || st?.trajectories?.summaries || st?.conversations?.byId || st?.conversations?.items || null;
            if (summaries && typeof summaries === "object") {
                let active = 0;
                const vals = Array.isArray(summaries) ? summaries : Object.values(summaries);
                for (const s of vals) {
                    if (!s || typeof s !== "object") continue;
                    const statusStr = String(s.status || s.runStatus || s.state || "").toUpperCase();
                    if (statusStr.includes("WAITING") || statusStr.includes("PENDING_USER") || statusStr.includes("NEEDS_INPUT") || s.waitingForUser === true || s.needsUserAttention === true) {
                        waitingForUser = true;
                    }
                    if (statusStr.includes("RUNNING") || statusStr.includes("IN_PROGRESS") || s.isRunning === true) {
                        active++;
                    }
                }
                if (active > 0) runningCount = active;
            }
        } catch {}
        if (!waitingForUser) {
            try {
                // Detect visible approval / proceed prompts in DOM
                const waitingEl = document.querySelector('[data-testid*="approval"], [data-testid*="permission-prompt"], [data-status="waiting"]');
                if (waitingEl) waitingForUser = true;
            } catch {}
        }
        return { waitingForUser, runningCount };
    }

    function getLiveUserInfo() {
        try {
            const store = findReduxStore();
            const st = store?.getState?.();
            const parsed = extractUserTelemetryFromUserStatus(st?.userStatus);
            if (parsed) {
                const attn = detectAgentAttentionState(st);
                return {
                    ...parsed,
                    waitingForUser: attn.waitingForUser,
                    ...(attn.runningCount !== null ? { activeAgentCount: attn.runningCount } : {}),
                };
            }
        } catch {}
        try {
            const ctx = findCascadeContextFromDom();
            const parsed = extractUserTelemetryFromUserStatus(ctx?.userStatus);
            if (parsed) {
                return { ...parsed, waitingForUser: false };
            }
        } catch {}
        return null;
    }

    function getLiveContextInfo() {
        let usedTokens = 0, maxTokens = 0, isExact = false, modelLabel = "", tokenGroups = [];
        try {
            const ctx = findCascadeContextFromDom();
            const asp = ctx?.cascadeContext?.state?.agentStateProvider;
            const aState = asp && typeof asp.getState === "function" ? asp.getState() : null;
            const cwu = aState?.contextWindowUsage;
            if (cwu) {
                const u = Number(cwu.estimatedTokensUsed || cwu.estimated_tokens_used || 0);
                const m = Number(cwu.maxContextTokens || cwu.max_context_tokens || 0);
                if (u > 0) { usedTokens = u; isExact = true; }
                if (m > 0) maxTokens = m;
                if (Array.isArray(cwu.tokenGroups) && cwu.tokenGroups.length) {
                    tokenGroups = cwu.tokenGroups.filter((g) => Number(g.numTokens) > 0);
                }
            }
            const selModel = ctx?.cascadeContext?.state?.selectedModel;
            if (selModel) {
                modelLabel = typeof selModel === "string" ? selModel : (selModel.label || selModel.customLabel || "");
            }
        } catch {}

        try {
            const store = findReduxStore();
            const st = store?.getState?.();
            if (st) {
                const configs = st.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
                const ms = st.modelSelection;
                const byConv = ms?.byConversation || {};
                const activeConvKey = Object.keys(byConv).find((k) => {
                    const row = document.querySelector('[data-selected="true"]');
                    return row && row.getAttribute("data-conversation-id") === k;
                });
                const activeSel = (activeConvKey && byConv[activeConvKey]) || ms?.default;
                if (activeSel) {
                    const cfgMatch = configs.find((c) => c.modelOrAlias?.value === activeSel.model || c.modelId === activeSel.model);
                    if (!modelLabel) modelLabel = activeSel.customLabel || cfgMatch?.label || "";
                    if (!maxTokens && activeSel.contextWindow) {
                        const parsed = parseInt(String(activeSel.contextWindow).replace(/[^0-9]/g, ""), 10);
                        if (String(activeSel.contextWindow).toLowerCase().includes("m") && parsed > 0 && parsed <= 10) maxTokens = parsed * 1000000;
                        else if (String(activeSel.contextWindow).toLowerCase().includes("k") && parsed > 0) maxTokens = parsed * 1000;
                    }
                }
            }
        } catch {}

        if (!modelLabel) {
            const modelBtn = Array.from(document.querySelectorAll('.surface-composer button, [data-testid*="model"]'))
                .find((b) => /gemini|claude|gpt|deepseek|sonnet|opus|flash|pro|neon/i.test(b.textContent || ""));
            if (modelBtn) modelLabel = (modelBtn.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
        }

        if (!maxTokens) maxTokens = inferModelMaxTokens(modelLabel);

        const main = document.querySelector("[data-main-content-body]");
        const rawText = main ? (main.innerText || "").trim() : "";
        const chars = rawText.length;
        const words = rawText ? rawText.split(/\\s+/).length : 0;

        if (!usedTokens && chars > 0) {
            const cyrCount = (rawText.match(/[\\u0400-\\u04FF]/g) || []).length;
            const otherCount = Math.max(0, chars - cyrCount);
            usedTokens = Math.round(cyrCount / 2.8 + otherCount / 4.0);
        }

        const leftTokens = Math.max(0, maxTokens - usedTokens);
        const pct = maxTokens > 0 ? Math.min(100, Math.max(0, (usedTokens / maxTokens) * 100)) : 0;

        return { usedTokens, maxTokens, leftTokens, pct, isExact, modelLabel: modelLabel || "Default", tokenGroups, chars, words };
    }

    // ===== 1. Minimalist Top Music Bar + Player Card + Volume + Fullscreen Karaoke =====
    const ICONS = {
        note: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        prev: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
        next: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
        play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
        volOn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
        volOff: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
        expand: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
        collapse: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    };

    const host = document.createElement("div");
    host.id = "agy-extras-shadow-host";
    host.style.setProperty("-webkit-app-region", "no-drag");
    const sh = host.attachShadow({ mode: "open" });

    let extrasWrapEl = null;

    function syncAdaptiveTextColors() {
        const root = document.documentElement;
        if (!root) return;
        const computed = getComputedStyle(root);
        const tintVal = computed.getPropertyValue("--agy-tint-rgb") || "12, 14, 20";
        const accentVal = computed.getPropertyValue("--agy-accent-rgb") || "96, 165, 250";
        const tokens = getAdaptiveThemeTokens(tintVal, accentVal, 0.24);
        const next = {
            "--agy-extras-text-primary": tokens.surface.primary,
            "--agy-extras-text-muted": tokens.surface.secondary,
            "--agy-extras-text-subtle": tokens.surface.subtle,
            "--agy-extras-border": tokens.surface.border,
            "--agy-extras-ring-track": tokens.surface.ringTrack,
            "--agy-extras-on-solid-accent": tokens.onSolidAccent,
            "--agy-extras-on-tinted-accent": tokens.onTintedAccent,
            "--agy-extras-on-accent": tokens.onTintedAccent,
            "--agy-extras-accent-text": tokens.accentText,
        };
        for (const [name, value] of Object.entries(next)) {
            if (root.style.getPropertyValue(name).trim() !== value) root.style.setProperty(name, value);
        }
        const noBlur = root.getAttribute("data-agy-no-blur") === "1";
        if (extrasWrapEl) extrasWrapEl.classList.toggle("no-blur", noBlur);
        const ctxPop = document.getElementById("agy-ctx-pop");
        if (ctxPop) ctxPop.style.backdropFilter = noBlur ? "none" : "blur(22px)";
    }

    syncAdaptiveTextColors();
    window.addEventListener("agy-visual-sync", syncAdaptiveTextColors);
    const contrastObserver = new MutationObserver(syncAdaptiveTextColors);
    if (document.documentElement) contrastObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-agy-no-blur"] });

    const st = document.createElement("style");
    st.textContent = \`
        :host {
            --acc: var(--agy-accent-rgb, 96, 165, 250);
            --rad: var(--agy-radius, 10px);
            --card-alpha: var(--agy-surface-card-alpha, 0.80);
            --modal-alpha: var(--agy-surface-modal-alpha, 0.88);
            font-family: var(--agy-ui-font, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif);
            font-size: var(--agy-base-font-size, 14px);
            color: var(--agy-extras-text-primary, #f1f5f9);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        button { font-family: inherit; cursor: pointer; border: none; background: transparent; color: inherit; }

        .player-wrap {
            position: fixed;
            top: 4px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 2147483645;
            display: flex;
            flex-direction: column;
            align-items: center;
            -webkit-app-region: no-drag;
            app-region: no-drag;
            pointer-events: auto;
            user-select: none;
        }
        .player-bar, .player-bar *, .player-card, .player-card * {
            -webkit-app-region: no-drag;
            app-region: no-drag;
        }
        .player-bar {
            position: relative;
            height: 32px;
            min-width: 268px;
            max-width: min(760px, 60vw);
            padding: 0 6px 0 5px;
            border-radius: var(--rad);
            background: rgba(var(--agy-tint-rgb, 14, 17, 24), var(--card-alpha));
            backdrop-filter: blur(18px);
            border: 1px solid var(--agy-extras-border, rgba(255, 255, 255, 0.12));
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: auto;
            transition: background 0.14s ease, border-color 0.14s ease;
        }
        .player-bar:hover {
            background: rgba(var(--agy-tint-rgb, 20, 24, 34), var(--modal-alpha));
            border-color: rgba(255, 255, 255, 0.24);
        }
        .bar-info-zone {
            flex: 1;
            min-width: 0;
            height: 100%;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
        }
        .bar-controls {
            display: inline-flex;
            align-items: center;
            gap: 1px;
            flex-shrink: 0;
            padding-left: 4px;
            border-left: 1px solid rgba(255, 255, 255, 0.08);
        }
        .bar-vol-wrap {
            position: relative;
            display: inline-flex;
            align-items: center;
        }
        .bar-vol-pop {
            position: absolute;
            top: 50%;
            left: calc(100% + 8px);
            transform: translateY(-50%) translateX(-4px);
            height: 32px;
            padding: 0 10px;
            border-radius: var(--rad);
            background: rgba(var(--agy-tint-rgb, 18, 20, 26), 0.96);
            backdrop-filter: blur(20px);
            border: 1px solid var(--agy-extras-border, rgba(255, 255, 255, 0.16));
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.62);
            display: flex;
            align-items: center;
            gap: 8px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.14s ease, transform 0.14s ease;
            z-index: 30;
        }
        .bar-vol-pop::before {
            content: "";
            position: absolute;
            top: 0;
            bottom: 0;
            left: -10px;
            width: 10px;
        }
        .bar-vol-wrap.flip-left .bar-vol-pop {
            left: auto;
            right: calc(100% + 8px);
            transform: translateY(-50%) translateX(4px);
        }
        .bar-vol-wrap.flip-left .bar-vol-pop::before {
            left: auto;
            right: -10px;
        }
        .bar-vol-wrap.open .bar-vol-pop,
        .bar-vol-wrap.dragging .bar-vol-pop {
            opacity: 1;
            pointer-events: auto;
            transform: translateY(-50%) translateX(0);
        }
        .bar-vol-htrack {
            position: relative;
            width: 82px;
            height: 18px;
            display: flex;
            align-items: center;
            cursor: pointer;
        }
        .bar-vol-hrail {
            position: relative;
            width: 100%;
            height: 5px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.22);
            overflow: hidden;
        }
        .bar-vol-hfill {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 0;
            width: 100%;
            border-radius: 3px;
            background: rgb(var(--acc));
        }
        .bar-vol-pct {
            min-width: 24px;
            text-align: right;
            font-size: 10.5px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            color: var(--agy-extras-text-muted, #cbd5e1);
        }
        .no-blur .player-bar,
        .no-blur .player-card,
        .no-blur .vol-pop-card,
        .no-blur .bar-vol-pop {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
        .cover-thumb {
            width: 22px;
            height: 22px;
            border-radius: calc(var(--rad) * 0.55);
            background: rgba(255, 255, 255, 0.08);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            flex-shrink: 0;
            color: var(--agy-extras-text-muted, #cbd5e1);
            position: relative;
        }
        .cover-thumb img { width: 100%; height: 100%; object-fit: cover; display: none; position: absolute; inset: 0; }
        .bar-text {
            flex: 1;
            min-width: 0;
            font-size: 12.5px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--agy-extras-text-primary, #f8fafc);
        }
        .bar-btn {
            width: 24px;
            height: 24px;
            border-radius: calc(var(--rad) * 0.55);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: var(--agy-extras-text-muted, #cbd5e1);
            flex-shrink: 0;
            transition: background 0.14s ease, color 0.14s ease, transform 0.1s ease;
        }
        .bar-btn:hover { background: rgba(255, 255, 255, 0.10); color: var(--agy-extras-text-primary, #fff); }
        .bar-btn:active { transform: scale(0.92); }
        .bar-btn svg { width: 13px; height: 13px; }
        .eq { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 11px; flex-shrink: 0; }
        .eq span { width: 2px; border-radius: 1px; background: rgb(var(--acc)); height: 2px; }
        .eq.playing span:nth-child(1) { animation: eq1 0.65s infinite alternate; }
        .eq.playing span:nth-child(2) { animation: eq2 0.50s infinite alternate; }
        .eq.playing span:nth-child(3) { animation: eq3 0.75s infinite alternate; }
        .eq.playing span:nth-child(4) { animation: eq1 0.55s infinite alternate 0.15s; }
        @keyframes eq1 { from { height: 2px; } to { height: 11px; } }
        @keyframes eq2 { from { height: 3px; } to { height: 9px; } }
        @keyframes eq3 { from { height: 2px; } to { height: 10px; } }

        @keyframes cardGlideIn {
            from { opacity: 0; transform: translateY(-6px) scale(0.985); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .player-card {
            position: relative;
            margin-top: 6px;
            width: 306px;
            padding: 13px;
            border-radius: var(--rad);
            background: rgba(var(--agy-tint-rgb, 14, 17, 24), var(--modal-alpha));
            backdrop-filter: blur(22px);
            border: 1px solid var(--agy-extras-border, rgba(255, 255, 255, 0.13));
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.68);
            display: none;
            flex-direction: column;
            gap: 11px;
        }
        .player-card::before {
            content: "";
            position: absolute;
            top: -10px;
            left: 0;
            right: 0;
            height: 10px;
        }
        .player-card.open {
            display: flex;
            animation: cardGlideIn 0.18s cubic-bezier(0.22, 1, 0.36, 1) both;
        }

        .card-cover-box {
            position: relative;
            width: 100%;
            aspect-ratio: 1 / 1;
            border-radius: calc(var(--rad) * 0.8);
            overflow: hidden;
            background: rgba(255, 255, 255, 0.04);
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255, 255, 255, 0.28);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .card-cover-box img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: none; }
        .expand-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 32px;
            height: 32px;
            border-radius: calc(var(--rad) * 0.65);
            background: rgba(12, 14, 20, 0.72);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.15s ease, background 0.15s ease;
            z-index: 2;
        }
        .card-cover-box:hover .expand-btn { opacity: 1; }
        .expand-btn:hover { background: rgba(12, 14, 20, 0.92); border-color: rgba(255, 255, 255, 0.32); }

        .meta-row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
        .meta-title { font-size: 14px; font-weight: 600; color: var(--agy-extras-text-primary, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meta-artist { font-size: 12px; color: var(--agy-extras-text-muted, #94a3b8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        .meta-app { font-size: 11px; font-weight: 500; color: var(--agy-extras-text-muted, #94a3b8); flex-shrink: 0; white-space: nowrap; }

        .sessions-bar { display: none; flex-wrap: wrap; gap: 5px; }
        .sessions-bar.show { display: flex; }
        .sess-btn {
            font-size: 11px;
            font-weight: 500;
            padding: 3px 9px;
            border-radius: calc(var(--rad) * 0.6);
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--agy-extras-border, rgba(255, 255, 255, 0.10));
            color: var(--agy-extras-text-muted, #cbd5e1);
        }
        .sess-btn:hover { background: rgba(255, 255, 255, 0.12); color: var(--agy-extras-text-primary, #ffffff); }
        .sess-btn.active {
            background: rgba(var(--acc), 0.24);
            border-color: rgba(var(--acc), 0.56);
            color: var(--agy-extras-on-tinted-accent, #ffffff);
            font-weight: 600;
        }

        .seek-wrap { position: relative; padding: 6px 0; cursor: pointer; }
        .seek-wrap.disabled { cursor: default; }
        .prog-bar {
            position: relative;
            width: 100%;
            height: 4px;
            border-radius: 2px;
            background: var(--agy-extras-ring-track, rgba(255, 255, 255, 0.16));
            overflow: visible;
            transition: transform 0.12s ease;
        }
        .seek-wrap:not(.disabled):hover .prog-bar { transform: scaleY(1.5); }
        .prog-fill {
            position: relative;
            height: 100%;
            border-radius: 2px;
            background: rgb(var(--acc));
            width: 0%;
        }
        .prog-thumb {
            position: absolute;
            right: -5px;
            top: 50%;
            transform: translateY(-50%) scale(0);
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #fff;
            transition: transform 0.12s ease;
        }
        .seek-wrap:not(.disabled):hover .prog-thumb,
        .seek-wrap.dragging .prog-thumb { transform: translateY(-50%) scale(1); }
        .seek-tip {
            position: absolute;
            bottom: 14px;
            transform: translateX(-50%);
            padding: 2px 6px;
            border-radius: calc(var(--rad) * 0.5);
            background: rgba(var(--agy-tint-rgb, 14, 17, 24), 0.96);
            border: 1px solid var(--agy-extras-border, rgba(255, 255, 255, 0.16));
            font-size: 10px;
            font-variant-numeric: tabular-nums;
            color: var(--agy-extras-text-primary, #fff);
            pointer-events: none;
            display: none;
        }
        .time-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--agy-extras-text-muted, #94a3b8); font-variant-numeric: tabular-nums; margin-top: 2px; }
        .controls-row {
            position: relative;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 14px;
        }
        .ctrl-btn {
            width: 34px;
            height: 34px;
            border-radius: calc(var(--rad) * 0.75);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--agy-extras-text-primary, #e2e8f0);
            transition: background 0.14s ease, color 0.14s ease;
        }
        .ctrl-btn:hover { background: rgba(255, 255, 255, 0.10); color: var(--agy-extras-text-primary, #fff); }
        .ctrl-btn:active { transform: scale(0.93); }
        .ctrl-btn.primary {
            width: 40px;
            height: 40px;
            background: rgba(255, 255, 255, 0.12);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: var(--agy-extras-text-primary, #fff);
        }
        .ctrl-btn.primary:hover { background: rgba(var(--acc), 0.30); border-color: rgba(var(--acc), 0.65); }

        /* Yandex Music-style upward vertical volume popup on hover, pinned right so prev/play/next stay centered */
        .vol-pop-wrap {
            position: absolute;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .vol-pop {
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%) translateY(4px);
            padding-bottom: 8px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.14s ease, transform 0.14s ease;
            z-index: 20;
        }
        .vol-pop-wrap:hover .vol-pop,
        .vol-pop-wrap.dragging .vol-pop {
            opacity: 1;
            pointer-events: auto;
            transform: translateX(-50%) translateY(0);
        }
        .vol-pop-card {
            width: 38px;
            padding: 10px 0 11px;
            border-radius: var(--rad);
            background: rgba(var(--agy-tint-rgb, 18, 20, 26), 0.96);
            backdrop-filter: blur(20px);
            border: 1px solid var(--agy-extras-border, rgba(255, 255, 255, 0.16));
            box-shadow: 0 14px 36px rgba(0, 0, 0, 0.68);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 7px;
        }
        .vol-pct {
            font-size: 10px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            color: var(--agy-extras-text-muted, #cbd5e1);
            line-height: 1;
        }
        .vol-vtrack {
            position: relative;
            width: 18px;
            height: 112px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .vol-vrail {
            position: relative;
            width: 6px;
            height: 100%;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.22);
            overflow: hidden;
        }
        .vol-vfill {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 100%;
            border-radius: 3px;
            background: #f8fafc;
        }

        /* Fullscreen Karaoke Modal (Wide, Clean Top-Aligned Layout, Gentle Mask) */
        .fs-modal {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            display: none;
            background: #080a0f;
            overflow: hidden;
            -webkit-app-region: no-drag;
        }
        .fs-modal.open { display: flex; align-items: center; justify-content: center; }
        .fs-bg {
            position: absolute;
            inset: -60px;
            background-size: cover;
            background-position: center;
            filter: blur(64px) brightness(0.30) saturate(1.30);
            transform: scale(1.08);
            z-index: 0;
        }
        .fs-close {
            position: absolute;
            top: 18px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 3;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 14px;
            border-radius: var(--rad);
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.14);
            font-size: 0.88em;
            font-weight: 500;
            color: #f1f5f9;
        }
        .fs-close:hover { background: rgba(255, 255, 255, 0.16); }

        .fs-grid {
            position: relative;
            z-index: 2;
            width: min(1380px, 94vw);
            height: min(86vh, 780px);
            display: grid;
            grid-template-columns: minmax(300px, 380px) 1fr;
            gap: clamp(36px, 5vw, 84px);
            align-items: center;
        }
        .fs-left {
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            gap: 16px;
            width: 100%;
        }
        .fs-left > * { width: 100%; max-width: 360px; box-sizing: border-box; }
        .fs-left .meta-row { flex-direction: column; align-items: center; justify-content: center; gap: 4px; text-align: center; }
        .fs-left .meta-title,
        .fs-left .meta-artist { text-align: center; width: 100%; }
        .fs-left .meta-app { opacity: 0.6; font-size: 11px; }
        .fs-left .pop-prog { width: 100%; }
        .fs-left .pop-controls { justify-content: center; width: 100%; }
        .fs-cover-box {
            width: 100%;
            max-width: 360px;
            aspect-ratio: 1 / 1;
            border-radius: var(--rad);
            overflow: hidden;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.12);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65);
            position: relative;
        }
        .fs-cover-box img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: none; }
        .fs-lyrics {
            position: relative;
            height: 100%;
            box-sizing: border-box;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 26vh 32px 42vh 24px;
            display: flex;
            flex-direction: column;
            gap: 22px;
            text-align: var(--agy-lyrics-align, center);
            -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 10%, #000 88%, transparent 100%);
            mask-image: linear-gradient(to bottom, transparent 0%, #000 10%, #000 88%, transparent 100%);
        }
        .fs-lyrics.at-top {
            -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 88%, transparent 100%);
            mask-image: linear-gradient(to bottom, #000 0%, #000 88%, transparent 100%);
        }
        .fs-lyrics::-webkit-scrollbar { width: 4px; }
        .fs-lyrics::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.20); border-radius: 2px; }
        .lyric-line {
            font-size: var(--agy-lyrics-size, 26px);
            font-weight: 700;
            line-height: 1.38;
            color: rgba(255, 255, 255, 0.28);
            overflow-wrap: break-word;
            word-break: normal;
            transition: color 0.22s ease, opacity 0.22s ease;
        }
        .lyric-line.synced { cursor: pointer; }
        .lyric-line.synced:hover { color: rgba(255, 255, 255, 0.72); }
        .lyric-line.past { color: rgba(255, 255, 255, 0.44); }
        .lyric-line.active { color: #ffffff; }
        .lyric-plain { font-size: 18px; font-weight: 500; line-height: 1.55; color: rgba(241, 245, 249, 0.88); }
        .lyric-empty { font-size: 16px; color: rgba(203, 213, 225, 0.86); display: flex; flex-direction: column; gap: 10px; align-items: flex-start; padding-top: 4px; }
        .retry-btn {
            display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
            border-radius: var(--rad); background: rgba(255,255,255,0.10);
            border: 1px solid rgba(255,255,255,0.16); font-size: 12px; color: #f8fafc;
        }
        .retry-btn:hover { background: rgba(255,255,255,0.18); }

        .switch-overlay {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: rgba(var(--agy-tint-rgb, 8, 10, 15), 0.92);
            backdrop-filter: blur(12px);
            display: none;
            align-items: center;
            justify-content: center;
            flex-direction: column;
            gap: 12px;
            color: var(--agy-extras-text-primary, #f8fafc);
            font-size: 13.5px;
            font-weight: 500;
        }
        .switch-overlay.show { display: flex; }
        .spinner {
            width: 22px; height: 22px; border-radius: 50%;
            border: 2px solid rgba(255,255,255,0.18);
            border-top-color: rgb(var(--acc));
            animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    \`;

    const wrap = document.createElement("div");
    extrasWrapEl = wrap;
    if (document.documentElement && document.documentElement.getAttribute("data-agy-no-blur") === "1") {
        wrap.classList.add("no-blur");
    }
    wrap.innerHTML = \`
        <div class="player-wrap" id="player-wrap">
            <div class="player-bar" id="player-bar">
                <div class="bar-info-zone" id="bar-info-zone">
                    <div class="cover-thumb">\${ICONS.note}<img id="i-cover" alt=""></div>
                    <span class="bar-text" id="i-text">Музыка</span>
                    <div class="eq" id="i-eq"><span></span><span></span><span></span><span></span></div>
                </div>
                <div class="bar-controls" id="bar-controls">
                    <button class="bar-btn" id="i-quick-prev" title="Предыдущий">\${ICONS.prev}</button>
                    <button class="bar-btn" id="i-quick-play" title="Пауза / Старт">\${ICONS.play}</button>
                    <button class="bar-btn" id="i-quick-next" title="Следующий">\${ICONS.next}</button>
                    <div class="bar-vol-wrap" id="i-vol-wrap">
                        <button class="bar-btn" id="i-vol-mute" title="Громкость">\${ICONS.volOn}</button>
                        <div class="bar-vol-pop" id="i-vol-pop">
                            <div class="bar-vol-htrack" id="i-vol-track"><div class="bar-vol-hrail"><div class="bar-vol-hfill" id="i-vol-fill"></div></div></div>
                            <span class="bar-vol-pct" id="i-vol-pct">100</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="player-card" id="player-card">
                <div class="card-cover-box">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                    <img id="c-cover" alt="">
                    <button class="expand-btn" id="c-expand" title="На весь экран">\${ICONS.expand}</button>
                </div>
                <div class="meta-row">
                    <div style="min-width:0;flex:1;">
                        <div class="meta-title" id="c-title">Нет активного трека</div>
                        <div class="meta-artist" id="c-artist">—</div>
                    </div>
                    <span class="meta-app" id="c-app"></span>
                </div>
                <div class="sessions-bar" id="c-sessions"></div>
                <div>
                    <div class="seek-wrap" id="c-seek-wrap">
                        <div class="seek-tip" id="c-seek-tip">0:00</div>
                        <div class="prog-bar" id="c-prog-bar"><div class="prog-fill" id="c-prog"><div class="prog-thumb"></div></div></div>
                    </div>
                    <div class="time-row"><span id="c-pos">0:00</span><span id="c-dur">0:00</span></div>
                </div>
                <div class="controls-row">
                    <button class="ctrl-btn" id="p-prev" title="Предыдущий">\${ICONS.prev}</button>
                    <button class="ctrl-btn primary" id="p-play" title="Пауза / Старт">\${ICONS.play}</button>
                    <button class="ctrl-btn" id="p-next" title="Следующий">\${ICONS.next}</button>
                    <div class="vol-pop-wrap" id="c-vol-wrap">
                        <div class="vol-pop">
                            <div class="vol-pop-card">
                                <span class="vol-pct" id="c-vol-pct">100</span>
                                <div class="vol-vtrack" id="c-vol-track"><div class="vol-vrail"><div class="vol-vfill" id="c-vol-fill"></div></div></div>
                            </div>
                        </div>
                        <button class="ctrl-btn" id="c-vol-mute" title="Громкость">\${ICONS.volOn}</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="fs-modal" id="fs-modal">
            <div class="fs-bg" id="fs-bg"></div>
            <button class="fs-close" id="fs-close">\${ICONS.collapse}<span id="fs-close-lbl">Свернуть</span></button>
            <div class="fs-grid">
                <div class="fs-left">
                    <div class="fs-cover-box">
                        <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                        <img id="fs-cover" alt="">
                    </div>
                    <div class="meta-row">
                        <div style="min-width:0;flex:1;">
                            <div class="meta-title" style="font-size:20px;" id="fs-title">—</div>
                            <div class="meta-artist" style="font-size:14px;" id="fs-artist">—</div>
                        </div>
                        <span class="meta-app" id="fs-app"></span>
                    </div>
                    <div>
                        <div class="seek-wrap" id="fs-seek-wrap">
                            <div class="seek-tip" id="fs-seek-tip">0:00</div>
                            <div class="prog-bar" id="fs-prog-bar"><div class="prog-fill" id="fs-prog"><div class="prog-thumb"></div></div></div>
                        </div>
                        <div class="time-row"><span id="fs-pos">0:00</span><span id="fs-dur">0:00</span></div>
                    </div>
                    <div class="controls-row">
                        <button class="ctrl-btn" id="fs-prev">\${ICONS.prev}</button>
                        <button class="ctrl-btn primary" id="fs-play" style="width:44px;height:44px;">\${ICONS.play}</button>
                        <button class="ctrl-btn" id="fs-next">\${ICONS.next}</button>
                        <div class="vol-pop-wrap" id="fs-vol-wrap">
                            <div class="vol-pop">
                                <div class="vol-pop-card">
                                    <span class="vol-pct" id="fs-vol-pct">100</span>
                                    <div class="vol-vtrack" id="fs-vol-track"><div class="vol-vrail"><div class="vol-vfill" id="fs-vol-fill"></div></div></div>
                                </div>
                            </div>
                            <button class="ctrl-btn" id="fs-vol-mute" title="Громкость">\${ICONS.volOn}</button>
                        </div>
                    </div>
                </div>
                <div class="fs-lyrics at-top" id="fs-lyrics">
                    <div class="lyric-empty">Ожидание трека...</div>
                </div>
            </div>
        </div>

        <div class="switch-overlay" id="switch-overlay">
            <div class="spinner"></div>
            <span id="switch-overlay-text">Переключение аккаунта...</span>
        </div>
    \`;

    sh.append(st, wrap);
    if (document.body) document.body.appendChild(host);

    // Custom tooltips matching Antigravity's styled [role="tooltip"] (replaces native OS title popups)
    (() => {
        const tipEl = document.createElement("div");
        tipEl.setAttribute("role", "tooltip");
        tipEl.style.cssText = [
            "position:fixed", "z-index:2147483647", "pointer-events:none",
            "opacity:0", "transition:opacity 0.12s ease", "visibility:hidden",
            "padding:5px 9px", "max-width:min(320px,85vw)", "line-height:1.35",
            "border-radius:var(--agy-radius-sm,7px)",
            "background:rgba(var(--agy-tint-rgb,14,17,24),var(--agy-surface-modal-alpha,0.90))",
            "border:1px solid var(--agy-extras-border,rgba(255,255,255,0.13))",
            "box-shadow:0 10px 28px rgba(0,0,0,0.52)",
            "color:var(--agy-extras-text-primary,#f1f5f9)",
            "font-family:var(--agy-ui-font,'Segoe UI Variable','Segoe UI',system-ui,sans-serif)",
            "font-size:calc(var(--agy-base-font-size,14px) * 0.84)",
            "font-weight:500", "white-space:normal", "word-break:break-word",
        ].join(";");
        sh.appendChild(tipEl);

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
        const findTipTarget = (start, onlyOwnIds) => {
            let cur = start;
            while (cur && cur.nodeType === 1) {
                if (onlyOwnIds && !(cur.id === "agy-accounts-side-btn" || cur.id === "agy-style-side-btn")) {
                    cur = cur.parentElement;
                    continue;
                }
                const nativeTitle = cur.getAttribute("title");
                if (nativeTitle) {
                    cur.setAttribute("data-agy-tip", nativeTitle);
                    cur.removeAttribute("title");
                    return cur;
                }
                if (cur.getAttribute("data-agy-tip")) return cur;
                cur = cur.parentElement;
            }
            return null;
        };
        const bindRoot = (root, onlyOwnIds) => {
            root.addEventListener("pointerover", (e) => {
                const target = findTipTarget(e.target, onlyOwnIds);
                if (!target) { if (activeEl && !onlyOwnIds) hideTip(); return; }
                if (target === activeEl) return;
                hideTip();
                activeEl = target;
                tipTimer = setTimeout(() => showTipFor(target), 240);
            }, true);
            root.addEventListener("pointerout", (e) => {
                if (!activeEl) return;
                const rel = e.relatedTarget;
                if (rel && activeEl.contains && activeEl.contains(rel)) return;
                hideTip();
            }, true);
            root.addEventListener("pointerdown", hideTip, true);
        };
        bindRoot(sh, false);
        bindRoot(document, true);
        window.addEventListener("blur", hideTip);
        window.addEventListener("scroll", hideTip, true);
        window.addEventListener("keydown", hideTip, true);
    })();

    const $s = (q) => sh.querySelector(q);
    const fmt = (s) => {
        s = Math.max(0, Math.floor(Number(s) || 0));
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    };

    function alignTopPlayerBar() {
        const pw = $s("#player-wrap");
        if (!pw) return;
        const bar = document.querySelector('[data-testid="title-menu-bar"]');
        if (bar) {
            const h = bar.getBoundingClientRect().height;
            if (h >= 34 && h <= 64) {
                pw.style.top = Math.max(3, Math.round((h - 32) / 2)) + "px";
                return;
            }
        }
        pw.style.top = "4px";
    }

    const mediaState = {
        trackKey: "",
        coverUrl: "",
        data: {},
        anchorPos: 0,
        anchorTs: 0,
        draggingSeek: false,
        draggingVol: false,
        dragSec: 0,
        volume: 100,
        muted: false,
        lyrics: [],
        lyricsMode: "none",
        manualScrollUntil: 0,
        lastActiveIdx: -2,
        barHoverFrozen: false,
        pendingBarText: null,
    };

    function setBarTextSafe(text) {
        mediaState.pendingBarText = text;
        if (mediaState.barHoverFrozen) return;
        const el = $s("#i-text");
        if (el && el.textContent !== text) el.textContent = text;
    }

    function updateVolumeUi(vol, muted) {
        const v = Math.max(0, Math.min(100, Math.round(Number(vol) || 0)));
        const isMuted = !!muted || v === 0;
        mediaState.volume = v;
        mediaState.muted = isMuted;
        const displayVal = isMuted ? 0 : v;
        for (const [fId, pId, mId] of [["#c-vol-fill", "#c-vol-pct", "#c-vol-mute"], ["#fs-vol-fill", "#fs-vol-pct", "#fs-vol-mute"]]) {
            const fill = $s(fId);
            const pct = $s(pId);
            const mb = $s(mId);
            if (fill) fill.style.height = displayVal + "%";
            if (pct) pct.textContent = String(displayVal);
            if (mb) mb.innerHTML = isMuted ? ICONS.volOff : ICONS.volOn;
        }
        const bFill = $s("#i-vol-fill");
        const bPct = $s("#i-vol-pct");
        const bMute = $s("#i-vol-mute");
        if (bFill) bFill.style.width = displayVal + "%";
        if (bPct) bPct.textContent = String(displayVal);
        if (bMute) bMute.innerHTML = isMuted ? ICONS.volOff : ICONS.volOn;
    }

    let volDebounce = null;
    function pushMediaVolume(vol, muted) {
        clearTimeout(volDebounce);
        volDebounce = setTimeout(() => {
            const payload = {};
            if (vol !== undefined) payload.volume = Math.max(0, Math.min(100, Math.round(vol)));
            if (typeof muted === "boolean") payload.muted = muted;
            fetch(BASE_URL + "/media/volume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }).catch(() => {});
        }, 45);
    }

    function bindVerticalVolume(wrapSel, trackSel, muteSel) {
        const wrapEl = $s(wrapSel);
        const track = $s(trackSel);
        const mb = $s(muteSel);
        if (!wrapEl || !track || !mb) return;
        const calcVol = (clientY) => {
            const rect = track.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (rect.bottom - clientY) / Math.max(1, rect.height)));
            return Math.round(ratio * 100);
        };
        track.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            mediaState.draggingVol = true;
            wrapEl.classList.add("dragging");
            const applyEv = (ev) => {
                const val = calcVol(ev.clientY);
                updateVolumeUi(val, val === 0);
                pushMediaVolume(val, val === 0);
            };
            applyEv(e);
            const onMove = (ev) => applyEv(ev);
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                mediaState.draggingVol = false;
                wrapEl.classList.remove("dragging");
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
        wrapEl.addEventListener("wheel", (e) => {
            e.preventDefault();
            const cur = mediaState.muted ? 0 : mediaState.volume;
            const next = Math.max(0, Math.min(100, cur + (e.deltaY < 0 ? 5 : -5)));
            updateVolumeUi(next, next === 0);
            pushMediaVolume(next, next === 0);
        }, { passive: false });
        mb.addEventListener("click", (e) => {
            e.stopPropagation();
            const nextMuted = !mediaState.muted;
            const nextVol = (!nextMuted && mediaState.volume <= 0) ? 50 : mediaState.volume;
            updateVolumeUi(nextVol, nextMuted);
            pushMediaVolume(nextVol, nextMuted);
        });
    }
    bindVerticalVolume("#c-vol-wrap", "#c-vol-track", "#c-vol-mute");
    bindVerticalVolume("#fs-vol-wrap", "#fs-vol-track", "#fs-vol-mute");

    function getInterpolatedPos() {
        const d = mediaState.data;
        if (!d || !d.title) return 0;
        if (mediaState.draggingSeek) return mediaState.dragSec;
        let pos = mediaState.anchorPos;
        if (d.status === "Playing" && mediaState.anchorTs > 0) {
            pos += (performance.now() - mediaState.anchorTs) / 1000;
        }
        if (d.dur > 0) pos = Math.min(d.dur, pos);
        return Math.max(0, pos);
    }

    function parseLrc(lrc) {
        const out = [];
        for (const rawLine of String(lrc || "").split(/\\r?\\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            const tags = [...line.matchAll(/\\[(\\d+):(\\d+(?:\\.\\d+)?)\\]/g)];
            if (!tags.length) continue;
            const txt = line.replace(/\\[\\d+:\\d+(?:\\.\\d+)?\\]/g, "").trim();
            if (!txt) continue;
            for (const m of tags) {
                out.push({ sec: parseInt(m[1], 10) * 60 + parseFloat(m[2]), txt });
            }
        }
        out.sort((a, b) => a.sec - b.sec);
        return out;
    }

    const lyricsBox = $s("#fs-lyrics");
    function applyLyricsPrefs() {
        if (!host) return;
        host.style.setProperty("--agy-lyrics-size", (exState.lyricsFontSize || 26) + "px");
        host.style.setProperty("--agy-lyrics-align", exState.lyricsAlign === "left" ? "left" : "center");
    }
    applyLyricsPrefs();
    function updateLyricsMask() {
        if (!lyricsBox) return;
        lyricsBox.classList.toggle("at-top", lyricsBox.scrollTop <= 6);
    }
    lyricsBox.addEventListener("scroll", updateLyricsMask, { passive: true });
    lyricsBox.addEventListener("wheel", () => {
        mediaState.manualScrollUntil = Date.now() + 3500;
    }, { passive: true });

    function scrollLyricLineToFocus(lineEl, smooth = true) {
        if (!lyricsBox || !lineEl) return;
        const maxScroll = Math.max(0, lyricsBox.scrollHeight - lyricsBox.clientHeight);
        const focusOffset = Math.round(lyricsBox.clientHeight * 0.28);
        const targetTop = Math.max(0, Math.min(maxScroll, lineEl.offsetTop - focusOffset));
        lyricsBox.scrollTo({ top: targetTop, behavior: smooth ? "smooth" : "auto" });
        updateLyricsMask();
    }

    function updateProgressUi(forceInstantScroll = false) {
        const d = mediaState.data;
        const pos = getInterpolatedPos();
        const dur = Number(d.dur) || 0;
        const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;

        const cardOpen = $s("#player-card").classList.contains("open");
        const fsOpen = $s("#fs-modal").classList.contains("open");

        if (cardOpen || forceInstantScroll) {
            $s("#c-prog").style.width = pct.toFixed(2) + "%";
            $s("#c-pos").textContent = fmt(pos);
            $s("#c-dur").textContent = fmt(dur);
        }
        if (fsOpen || forceInstantScroll) {
            $s("#fs-prog").style.width = pct.toFixed(2) + "%";
            $s("#fs-pos").textContent = fmt(pos);
            $s("#fs-dur").textContent = fmt(dur);
        }

        if (mediaState.lyricsMode === "synced" && mediaState.lyrics.length) {
            const adjPos = pos + 0.25 + (Number(exState.lyricsOffsetSec) || 0);
            let activeIdx = -1;
            for (let i = 0; i < mediaState.lyrics.length; i++) {
                if (mediaState.lyrics[i].sec <= adjPos) activeIdx = i;
                else break;
            }
            if (activeIdx !== mediaState.lastActiveIdx || forceInstantScroll) {
                mediaState.lastActiveIdx = activeIdx;
                if (fsOpen || forceInstantScroll) {
                    const nodes = lyricsBox.querySelectorAll(".lyric-line");
                    let activeNode = null;
                    nodes.forEach((n, idx) => {
                        const isAct = idx === activeIdx;
                        n.classList.toggle("active", isAct);
                        n.classList.toggle("past", activeIdx >= 0 && idx < activeIdx);
                        if (isAct) activeNode = n;
                    });
                    if (fsOpen && Date.now() > mediaState.manualScrollUntil) {
                        if (activeNode) {
                            scrollLyricLineToFocus(activeNode, !forceInstantScroll);
                        } else if (activeIdx < 0) {
                            lyricsBox.scrollTo({ top: 0, behavior: forceInstantScroll ? "auto" : "smooth" });
                            updateLyricsMask();
                        }
                    }
                }
                if (exState.showLyricsInBar && activeIdx >= 0 && d.status === "Playing") {
                    setBarTextSafe(mediaState.lyrics[activeIdx].txt);
                } else if (d.title) {
                    setBarTextSafe((d.artist ? d.artist + " — " : "") + d.title);
                }
            }
        }
    }

    function setCoverImg(el, url) {
        if (!el) return;
        if (url) {
            if (el.src !== url) el.src = url;
            el.style.display = "block";
        } else {
            el.removeAttribute("src");
            el.style.display = "none";
        }
    }

    function seekTo(sec) {
        const d = mediaState.data;
        if (!d || !d.dur || !d.canSeek) return;
        const clamped = Math.max(0, Math.min(d.dur, sec));
        mediaState.anchorPos = clamped;
        mediaState.anchorTs = performance.now();
        updateProgressUi();
        fetch(BASE_URL + "/media/seek", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sec: clamped }),
        }).then(() => setTimeout(() => refreshMedia(true), 240)).catch(() => {});
    }

    function bindSeekBar(wrapSel, barSel, tipSel) {
        const w = $s(wrapSel), bar = $s(barSel), tip = $s(tipSel);
        const calcSec = (clientX) => {
            const rect = bar.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
            return { ratio, sec: ratio * (Number(mediaState.data.dur) || 0) };
        };
        w.addEventListener("mousemove", (e) => {
            if (!mediaState.data.dur || !mediaState.data.canSeek) { tip.style.display = "none"; return; }
            const { ratio, sec } = calcSec(e.clientX);
            tip.style.display = "block";
            tip.style.left = (ratio * 100).toFixed(1) + "%";
            tip.textContent = fmt(sec);
        });
        w.addEventListener("mouseleave", () => { if (!mediaState.draggingSeek) tip.style.display = "none"; });
        w.addEventListener("mousedown", (e) => {
            if (!mediaState.data.dur || !mediaState.data.canSeek) return;
            e.preventDefault(); e.stopPropagation();
            mediaState.draggingSeek = true;
            w.classList.add("dragging");
            const update = (ev) => {
                const { ratio, sec } = calcSec(ev.clientX);
                mediaState.dragSec = sec;
                tip.style.display = "block";
                tip.style.left = (ratio * 100).toFixed(1) + "%";
                tip.textContent = fmt(sec);
                updateProgressUi();
            };
            update(e);
            const onMove = (ev) => update(ev);
            const onUp = (ev) => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                w.classList.remove("dragging");
                tip.style.display = "none";
                const { sec } = calcSec(ev.clientX);
                mediaState.draggingSeek = false;
                seekTo(sec);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
    }
    bindSeekBar("#c-seek-wrap", "#c-prog-bar", "#c-seek-tip");
    bindSeekBar("#fs-seek-wrap", "#fs-prog-bar", "#fs-seek-tip");

    function loadTrackLyrics(d) {
        lyricsBox.innerHTML = '<div class="lyric-empty">' + (isRu() ? "Поиск текста..." : "Searching lyrics...") + "</div>";
        lyricsBox.scrollTop = 0;
        updateLyricsMask();
        const qs = "artist=" + encodeURIComponent(d.artist || "") + "&title=" + encodeURIComponent(d.title || "") + "&duration=" + encodeURIComponent(Math.round(d.dur || 0));
        fetch(BASE_URL + "/media/lyrics?" + qs)
            .then((r) => r.json())
            .then((ly) => {
                if ((d.artist || "") + "||" + (d.title || "") !== mediaState.trackKey) return;
                mediaState.lyrics = [];
                mediaState.lastActiveIdx = -2;
                if (ly && ly.synced) {
                    const parsed = parseLrc(ly.synced);
                    if (parsed.length) {
                        mediaState.lyrics = parsed;
                        mediaState.lyricsMode = "synced";
                        lyricsBox.innerHTML = "";
                        parsed.forEach((line) => {
                            const el = document.createElement("div");
                            el.className = "lyric-line synced";
                            el.textContent = line.txt;
                            el.onclick = () => { mediaState.manualScrollUntil = 0; seekTo(line.sec); };
                            lyricsBox.appendChild(el);
                        });
                        lyricsBox.scrollTop = 0;
                        updateProgressUi(true);
                        return;
                    }
                }
                if (ly && ly.plain) {
                    mediaState.lyricsMode = "plain";
                    lyricsBox.innerHTML = ly.plain.split(/\\r?\\n/).map((l) => l.trim() ? '<div class="lyric-plain">' + esc(l) + "</div>" : '<div style="height:10px;"></div>').join("");
                    lyricsBox.scrollTop = 0;
                    updateLyricsMask();
                    return;
                }
                mediaState.lyricsMode = "none";
                lyricsBox.innerHTML = '<div class="lyric-empty"><span>' + (isRu() ? "Текст песни не найден" : "Lyrics not found") + '</span><button class="retry-btn" id="ly-retry">' + ICONS.refresh + "<span>" + (isRu() ? "Повторить" : "Retry") + "</span></button></div>";
                lyricsBox.scrollTop = 0;
                updateLyricsMask();
                const rb = lyricsBox.querySelector("#ly-retry");
                if (rb) rb.onclick = () => loadTrackLyrics(d);
            })
            .catch(() => {});
    }

    function renderSessionChips(d) {
        const bar = $s("#c-sessions");
        const list = Array.isArray(d.sessions) ? d.sessions : [];
        if (list.length <= 1) {
            bar.classList.remove("show");
            bar.innerHTML = "";
            return;
        }
        bar.classList.add("show");
        bar.innerHTML = "";
        for (const s of list) {
            const btn = document.createElement("button");
            btn.className = "sess-btn" + (s.app === d.app ? " active" : "");
            btn.textContent = s.appName;
            btn.title = (s.artist ? s.artist + " — " : "") + s.title;
            btn.onclick = (e) => {
                e.stopPropagation();
                fetch(BASE_URL + "/media/select-session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ app: s.app }),
                }).then(() => refreshMedia(true)).catch(() => {});
            };
            bar.appendChild(btn);
        }
    }

    function refreshMedia(force = false) {
        if (!exState.showPlayer || document.visibilityState === "hidden") return;
        alignTopPlayerBar();
        fetch(BASE_URL + "/media/rich" + (force ? "?force=1" : ""))
            .then((r) => r.json())
            .then((d) => {
                if (!d || !d.title) {
                    mediaState.data = {};
                    mediaState.trackKey = "";
                    mediaState.coverUrl = "";
                    mediaState.lyrics = [];
                    mediaState.lyricsMode = "none";
                    setBarTextSafe(isRu() ? "Музыка" : "Music");
                    $s("#i-eq").classList.remove("playing");
                    syncEqVisualState(false);
                    $s("#i-quick-play").innerHTML = ICONS.play;
                    $s("#c-title").textContent = isRu() ? "Нет активного трека" : "Nothing playing";
                    $s("#c-artist").textContent = "—";
                    $s("#c-app").textContent = "";
                    setCoverImg($s("#i-cover"), "");
                    setCoverImg($s("#c-cover"), "");
                    setCoverImg($s("#fs-cover"), "");
                    $s("#fs-bg").style.backgroundImage = "none";
                    $s("#c-prog").style.width = "0%";
                    $s("#fs-prog").style.width = "0%";
                    return;
                }

                mediaState.data = d;
                if (!mediaState.draggingSeek) {
                    mediaState.anchorPos = Number(d.pos) || 0;
                    mediaState.anchorTs = performance.now();
                }
                if (!mediaState.draggingVol && Number.isFinite(Number(d.volume))) {
                    updateVolumeUi(d.volume, !!d.muted);
                }

                const playing = d.status === "Playing";
                const tk = (d.artist || "") + "||" + d.title;
                $s("#i-eq").classList.toggle("playing", playing);
                syncEqVisualState(playing);
                $s("#i-quick-play").innerHTML = playing ? ICONS.pause : ICONS.play;
                $s("#p-play").innerHTML = playing ? ICONS.pause : ICONS.play;
                $s("#fs-play").innerHTML = playing ? ICONS.pause : ICONS.play;

                $s("#c-title").textContent = d.title;
                $s("#c-artist").textContent = d.artist || (isRu() ? "Неизвестный исполнитель" : "Unknown artist");
                $s("#c-app").textContent = d.appName || "";
                $s("#fs-title").textContent = d.title;
                $s("#fs-artist").textContent = d.artist || "";
                $s("#fs-app").textContent = d.appName || "";

                $s("#c-seek-wrap").classList.toggle("disabled", !d.canSeek);
                $s("#fs-seek-wrap").classList.toggle("disabled", !d.canSeek);

                const nextCoverUrl = d.coverKey ? (BASE_URL + "/media/cover?key=" + encodeURIComponent(d.coverKey) + "&rev=" + encodeURIComponent(d.coverRev || "lo")) : "";
                if (nextCoverUrl !== mediaState.coverUrl) {
                    mediaState.coverUrl = nextCoverUrl;
                    setCoverImg($s("#i-cover"), nextCoverUrl);
                    setCoverImg($s("#c-cover"), nextCoverUrl);
                    setCoverImg($s("#fs-cover"), nextCoverUrl);
                    $s("#fs-bg").style.backgroundImage = nextCoverUrl ? 'url("' + nextCoverUrl + '")' : "none";
                }

                renderSessionChips(d);

                if (tk !== mediaState.trackKey) {
                    mediaState.trackKey = tk;
                    mediaState.lyrics = [];
                    mediaState.lyricsMode = "none";
                    mediaState.lastActiveIdx = -2;
                    setBarTextSafe((d.artist ? d.artist + " — " : "") + d.title);
                    loadTrackLyrics(d);
                } else if (mediaState.lyricsMode !== "synced" || !playing || !exState.showLyricsInBar) {
                    setBarTextSafe((d.artist ? d.artist + " — " : "") + d.title);
                }
                updateProgressUi();
            })
            .catch(() => {});
    }

    // Zero-conflict state machine for collapsed controls, sideways volume, hover-expand mini-widget & karaoke freeze
    let cardPinned = false;
    let cardHoverOpen = false;
    let barVolOpen = false;
    let hoverOpenTimer = null;
    let hoverCloseTimer = null;
    let barVolCloseTimer = null;

    const playerBarEl = $s("#player-bar");
    const barInfoZone = $s("#bar-info-zone");
    const barControlsEl = $s("#bar-controls");
    const playerCardEl = $s("#player-card");
    const barVolWrap = $s("#i-vol-wrap");
    const barVolTrack = $s("#i-vol-track");
    const barVolMute = $s("#i-vol-mute");

    function clearCardTimers() {
        clearTimeout(hoverOpenTimer); hoverOpenTimer = null;
        clearTimeout(hoverCloseTimer); hoverCloseTimer = null;
    }

    function openPlayerCard(asPinned) {
        if (asPinned) cardPinned = true;
        else cardHoverOpen = true;
        if (!playerCardEl.classList.contains("open")) {
            playerCardEl.classList.add("open");
            updateProgressUi(true);
        }
    }

    function closePlayerCard(forceAll) {
        clearCardTimers();
        if (forceAll) {
            cardPinned = false;
            cardHoverOpen = false;
        } else {
            cardHoverOpen = false;
            if (cardPinned) return;
        }
        playerCardEl.classList.remove("open");
    }

    function closeHoverOpenedCard() {
        if (cardHoverOpen && !cardPinned) closePlayerCard(false);
    }

    function scheduleCardHoverOpen() {
        if (!exState.hoverOpenPlayer || barVolOpen || $s("#fs-modal").classList.contains("open")) return;
        clearTimeout(hoverCloseTimer); hoverCloseTimer = null;
        if (playerCardEl.classList.contains("open")) {
            if (!cardPinned) cardHoverOpen = true;
            return;
        }
        clearTimeout(hoverOpenTimer);
        hoverOpenTimer = setTimeout(() => {
            hoverOpenTimer = null;
            if (!exState.hoverOpenPlayer || barVolOpen || $s("#fs-modal").classList.contains("open")) return;
            openPlayerCard(false);
        }, 140);
    }

    function scheduleCardHoverClose(delayMs = 200) {
        clearTimeout(hoverOpenTimer); hoverOpenTimer = null;
        if (cardPinned || !cardHoverOpen) return;
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(() => {
            hoverCloseTimer = null;
            if (cardPinned || mediaState.draggingSeek || mediaState.draggingVol) return;
            closePlayerCard(false);
        }, delayMs);
    }

    function setBarHoverFreeze(frozen) {
        if (frozen === mediaState.barHoverFrozen) return;
        mediaState.barHoverFrozen = frozen;
        if (frozen) {
            const w = Math.ceil(playerBarEl.getBoundingClientRect().width);
            if (w > 0) playerBarEl.style.minWidth = w + "px";
        } else {
            playerBarEl.style.minWidth = "";
            if (mediaState.pendingBarText !== null) {
                const el = $s("#i-text");
                if (el && el.textContent !== mediaState.pendingBarText) {
                    el.textContent = mediaState.pendingBarText;
                }
            }
        }
    }

    playerBarEl.addEventListener("mouseenter", () => {
        setBarHoverFreeze(true);
    });
    playerBarEl.addEventListener("mouseleave", () => {
        if (!mediaState.draggingVol) setBarHoverFreeze(false);
    });

    // Only the non-button info zone triggers click-toggle and hover-expand
    barInfoZone.addEventListener("mouseenter", () => {
        scheduleCardHoverOpen();
    });
    barInfoZone.addEventListener("mouseleave", () => {
        scheduleCardHoverClose(200);
    });
    barInfoZone.addEventListener("click", (e) => {
        e.stopPropagation();
        clearCardTimers();
        if (cardPinned) {
            closePlayerCard(true);
        } else if (cardHoverOpen && playerCardEl.classList.contains("open")) {
            cardPinned = true;
            cardHoverOpen = false;
        } else {
            openPlayerCard(true);
        }
    });

    // Entering interactive controls cancels hover-open so buttons & volume never fight the mini-widget
    barControlsEl.addEventListener("mouseenter", () => {
        clearTimeout(hoverOpenTimer); hoverOpenTimer = null;
        if (cardHoverOpen && !cardPinned) scheduleCardHoverClose(140);
    });
    barControlsEl.addEventListener("click", (e) => e.stopPropagation());

    playerCardEl.addEventListener("mouseenter", () => {
        clearTimeout(hoverCloseTimer); hoverCloseTimer = null;
    });
    playerCardEl.addEventListener("mouseleave", () => {
        scheduleCardHoverClose(220);
    });

    // Sideways volume popup on collapsed bar
    function openBarVol() {
        clearTimeout(barVolCloseTimer); barVolCloseTimer = null;
        barVolOpen = true;
        clearTimeout(hoverOpenTimer); hoverOpenTimer = null;
        if (cardHoverOpen && !cardPinned) closePlayerCard(false);
        const r = barVolWrap.getBoundingClientRect();
        barVolWrap.classList.toggle("flip-left", window.innerWidth - r.right < 155);
        barVolWrap.classList.add("open");
    }
    function closeBarVol(delayMs = 180) {
        clearTimeout(barVolCloseTimer);
        barVolCloseTimer = setTimeout(() => {
            if (mediaState.draggingVol) return;
            barVolOpen = false;
            barVolWrap.classList.remove("open");
            if (!playerBarEl.matches(":hover")) setBarHoverFreeze(false);
        }, delayMs);
    }

    if (barVolWrap && barVolTrack && barVolMute) {
        const calcHVol = (clientX) => {
            const rect = barVolTrack.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
            return Math.round(ratio * 100);
        };
        barVolWrap.addEventListener("mouseenter", openBarVol);
        barVolWrap.addEventListener("mouseleave", () => closeBarVol(180));
        barVolTrack.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            mediaState.draggingVol = true;
            barVolWrap.classList.add("dragging");
            openBarVol();
            const apply = (ev) => {
                const val = calcHVol(ev.clientX);
                updateVolumeUi(val, val === 0);
                pushMediaVolume(val, val === 0);
            };
            apply(e);
            const onMove = (ev) => apply(ev);
            const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                mediaState.draggingVol = false;
                barVolWrap.classList.remove("dragging");
                if (!barVolWrap.matches(":hover")) closeBarVol(160);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
        barVolWrap.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            const step = e.deltaY < 0 ? 5 : -5;
            const cur = mediaState.muted ? 0 : mediaState.volume;
            const next = Math.max(0, Math.min(100, cur + step));
            updateVolumeUi(next, next === 0);
            pushMediaVolume(next, next === 0);
        }, { passive: false });
        barVolMute.addEventListener("click", (e) => {
            e.stopPropagation();
            const nextMuted = !mediaState.muted;
            const nextVol = (!nextMuted && mediaState.volume <= 0) ? 50 : mediaState.volume;
            updateVolumeUi(nextVol, nextMuted);
            pushMediaVolume(nextVol, nextMuted);
        });
    }

    $s("#i-quick-prev").addEventListener("click", (e) => { e.stopPropagation(); sendMediaCmd("prev"); });
    $s("#i-quick-play").addEventListener("click", (e) => { e.stopPropagation(); sendMediaCmd("playpause"); });
    $s("#i-quick-next").addEventListener("click", (e) => { e.stopPropagation(); sendMediaCmd("next"); });
    $s("#c-expand").addEventListener("click", (e) => {
        e.stopPropagation();
        closePlayerCard(true);
        $s("#fs-modal").classList.add("open");
        mediaState.manualScrollUntil = 0;
        mediaState.lastActiveIdx = -2;
        requestAnimationFrame(() => updateProgressUi(true));
    });
    $s("#fs-close").addEventListener("click", () => $s("#fs-modal").classList.remove("open"));
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            if ($s("#fs-modal").classList.contains("open")) $s("#fs-modal").classList.remove("open");
            if (playerCardEl.classList.contains("open")) closePlayerCard(true);
            if (barVolOpen) closeBarVol(0);
            if ($s("#switch-overlay").classList.contains("show")) hideSwitchOverlay();
        }
    });
    document.addEventListener("mousedown", (e) => {
        const p = e.composedPath ? e.composedPath() : [];
        if (!p.includes($s(".player-wrap"))) {
            closePlayerCard(true);
            if (barVolOpen) closeBarVol(0);
        }
    });

    function sendMediaCmd(cmd) {
        fetch(BASE_URL + "/media/" + cmd, { method: "POST" }).then(() => setTimeout(() => refreshMedia(true), 220)).catch(() => {});
    }
    $s("#p-prev").onclick = $s("#fs-prev").onclick = () => sendMediaCmd("prev");
    $s("#p-play").onclick = $s("#fs-play").onclick = () => sendMediaCmd("playpause");
    $s("#p-next").onclick = $s("#fs-next").onclick = () => sendMediaCmd("next");

    refreshMedia(true);
    setInterval(() => refreshMedia(false), 1800);
    setInterval(() => { if (mediaState.data.status === "Playing") updateProgressUi(); }, 250);

    // ===== 2. Seamless In-Window Multi-Account Manager + Sidebar Controls + Context Ring =====
    let accountsList = [];
    const thisTabAccountId = PROFILE;
    let activeAccountId = PROFILE;
    let lastSyncedUserKey = "";
    let lastSyncTs = 0;
    let editingAccId = null;
    let confirmDelId = null;
    let switchOverlayTimer = null;

    function showSwitchOverlay(msg) {
        clearTimeout(switchOverlayTimer);
        $s("#switch-overlay-text").textContent = msg;
        $s("#switch-overlay").classList.add("show");
        switchOverlayTimer = setTimeout(() => hideSwitchOverlay(), 25000);
    }
    function hideSwitchOverlay() {
        clearTimeout(switchOverlayTimer);
        $s("#switch-overlay").classList.remove("show");
    }

    function showAccountFeedback(message) {
        const feedback = document.getElementById("agy-acc-feedback");
        if (!feedback) return;
        feedback.textContent = message || "";
        feedback.style.display = message ? "block" : "none";
    }

    function formatAccountActionMessage(result) {
        const code = String(result?.code || result?.error || "");
        if (code === "invalid_account_id" || code === "not_found") {
            return isRu() ? "Профиль больше недоступен. Обновите список и попробуйте снова." : "That profile is no longer available. Refresh and try again.";
        }
        if (code === "uac_cancelled") {
            return isRu() ? "Запрос UAC отменён." : "UAC prompt cancelled.";
        }
        if (code === "profile_start_failed" || code === "switch_failed") {
            return isRu() ? "Не удалось запустить сервер профиля. Текущая сессия сохранена." : "Could not start the profile server. Your current session was preserved.";
        }
        if (result && result.message) return String(result.message);
        return isRu() ? "Не удалось выполнить действие с профилем." : "The profile action could not be completed.";
    }

    function fetchAccountsList(onDone) {
        fetch(BASE_URL + "/accounts/list")
            .then((r) => r.json())
            .then((res) => {
                if (res && Array.isArray(res.accounts)) accountsList = res.accounts;
                activeAccountId = thisTabAccountId;
                if (onDone) onDone();
            })
            .catch(() => {});
    }
    fetchAccountsList();

    function syncRealUserToServer() {
        const u = getLiveUserInfo();
        if (!u) return;
        const quotaSig = (u.quotas || []).map((q) => q.label + ":" + Math.round((q.remainingFraction || 0) * 100)).join(",");
        const tierSig = u.tier ? (u.tier.planName || u.tier.name || "") : "";
        const key = thisTabAccountId + "|" + u.displayName + "|" + u.email + "|" + u.avatar + "|" + tierSig + "|" + quotaSig + "|" + (u.waitingForUser ? "W" : "0") + "|" + (u.activeAgentCount ?? "");
        const now = Date.now();
        if (key === lastSyncedUserKey && now - lastSyncTs < 20000) return;
        lastSyncedUserKey = key;
        lastSyncTs = now;
        fetch(BASE_URL + "/accounts/sync-current", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...u, accountId: thisTabAccountId }),
        })
            .then((r) => r.json())
            .then((res) => {
                if (res && Array.isArray(res.accounts)) {
                    accountsList = res.accounts;
                    updateAccountButtonUi();
                    renderAccountsMenu();
                }
            })
            .catch(() => {});
    }

    function getAccountPrimaryTitle(acc) {
        if (!acc) return isRu() ? "Вход..." : "Signing in...";
        if (acc.customLabel) return acc.customLabel;
        if (acc.displayName) return acc.displayName;
        if (acc.email) return acc.email;
        return acc.id === "default" ? (isRu() ? "Основной аккаунт" : "Primary account") : (isRu() ? "Новый профиль" : "New profile");
    }

    function getAccountSubtitle(acc) {
        if (!acc) return "";
        if (acc.email) {
            if (acc.customLabel && acc.displayName && acc.customLabel !== acc.displayName) return acc.displayName + " — " + acc.email;
            return acc.email;
        }
        if (acc.id === "default") return isRu() ? "Основная сессия" : "Primary session";
        return acc.running ? (isRu() ? "Работает в фоне" : "Running in background") : (isRu() ? "Изолированный профиль" : "Isolated profile");
    }

    function getInitials(acc) {
        const s = (acc?.displayName || acc?.customLabel || acc?.email || "A").trim();
        const parts = s.split(/\\s+/);
        return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : s.slice(0, 2).toUpperCase();
    }

    function updateAccountButtonUi() {
        const curName = document.getElementById("agy-acc-cur-name");
        const curSub = document.getElementById("agy-acc-cur-sub");
        const curAv = document.getElementById("agy-acc-cur-av");
        if (!curName || !curSub || !curAv) return;

        const live = getLiveUserInfo();
        const saved = accountsList.find((a) => a.id === activeAccountId) || { id: activeAccountId };
        const liveOwnedByOther = live && live.email && accountsList.some((a) => a.id !== activeAccountId && a.email && a.email.toLowerCase() === live.email.toLowerCase());
        const useLive = live && (!liveOwnedByOther || !saved.email);
        const merged = {
            id: activeAccountId,
            customLabel: saved.customLabel || "",
            displayName: (useLive && live.displayName) || saved.displayName || "",
            email: (useLive && live.email) || saved.email || "",
            avatar: (useLive && live.avatar) || saved.avatar || "",
        };

        curName.textContent = getAccountPrimaryTitle(merged);
        curSub.textContent = getAccountSubtitle(merged);
        if (merged.avatar) {
            curAv.innerHTML = '<img src="' + esc(merged.avatar) + '" style="width:100%;height:100%;object-fit:cover;display:block;" alt="">';
        } else {
            curAv.textContent = getInitials(merged);
        }
    }

    function renderAccountsMenu() {
        const itemsEl = document.getElementById("agy-acc-items");
        if (!itemsEl) return;
        const ru = isRu();
        itemsEl.innerHTML = "";

        const list = accountsList.length ? accountsList : [{ id: activeAccountId, running: true }];
        for (const acc of list) {
            const isActive = acc.id === activeAccountId;
            const isRunningBg = !isActive && acc.running === true;
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:var(--agy-radius-sm, 7px);background:" + (isActive ? "rgba(var(--agy-accent-rgb),0.20)" : "transparent") + ";border:1px solid " + (isActive ? "rgba(var(--agy-accent-rgb),0.48)" : "transparent") + ";transition:background 0.12s ease;";
            row.onmouseenter = () => { if (!isActive) row.style.background = "rgba(255,255,255,0.06)"; };
            row.onmouseleave = () => { if (!isActive) row.style.background = "transparent"; };

            const av = document.createElement("div");
            av.style.cssText = "position:relative;width:30px;height:30px;border-radius:var(--agy-radius-sm, 7px);flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.10);color:var(--agy-extras-text-primary,#fff);font-size:0.78em;font-weight:600;overflow:visible;";
            if (acc.avatar) av.innerHTML = '<img src="' + esc(acc.avatar) + '" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit;" alt="">';
            else av.textContent = getInitials(acc);
            if (isRunningBg) {
                const dot = document.createElement("span");
                dot.title = ru ? "Открыт в фоновой вкладке" : "Open in background tab";
                dot.style.cssText = "position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;border-radius:2px;background:rgb(var(--agy-accent-rgb));border:1.5px solid rgba(var(--agy-tint-rgb,14,17,24),0.95);";
                av.appendChild(dot);
            }

            const info = document.createElement("div");
            info.style.cssText = "flex:1;min-width:0;cursor:" + (isActive ? "default" : "pointer") + ";";
            if (editingAccId === acc.id) {
                const inp = document.createElement("input");
                inp.type = "text";
                inp.value = acc.customLabel || acc.displayName || "";
                inp.placeholder = ru ? "Название..." : "Label...";
                inp.style.cssText = "width:100%;min-height:28px;padding:0 7px;border-radius:calc(var(--agy-radius, 10px) * 0.6);border:1px solid rgba(var(--agy-accent-rgb),0.65);background:rgba(var(--agy-tint-rgb,14,17,24),0.96);color:var(--agy-extras-text-primary,#fff);font-size:0.90em;outline:none;";
                const commit = () => {
                    editingAccId = null;
                    fetch(BASE_URL + "/accounts/rename", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, label: inp.value }),
                    }).then((r) => r.json()).then((res) => {
                        if (res.list) accountsList = res.list;
                        updateAccountButtonUi();
                        renderAccountsMenu();
                    }).catch(() => renderAccountsMenu());
                };
                inp.onkeydown = (ev) => {
                    if (ev.key === "Enter") commit();
                    if (ev.key === "Escape") { editingAccId = null; renderAccountsMenu(); }
                };
                inp.onblur = commit;
                info.appendChild(inp);
                setTimeout(() => inp.focus(), 10);
            } else {
                info.innerHTML =
                    '<div style="font-size:0.93em;font-weight:600;line-height:1.25;color:var(--agy-extras-text-primary,#f8fafc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(getAccountPrimaryTitle(acc)) + '</div>' +
                    '<div style="font-size:0.78em;line-height:1.25;color:var(--agy-extras-text-muted,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">' + esc(getAccountSubtitle(acc)) + '</div>';
                if (!isActive) {
                    info.title = ru ? "Открыть/переключиться на вкладку этого аккаунта" : "Open or switch to this account tab";
                    info.onclick = () => {
                        const menu = document.getElementById("agy-acc-menu");
                        if (menu) menu.style.display = "none";
                        if (!acc.tabOpen) {
                            showSwitchOverlay(ru ? ("Запуск вкладки " + getAccountPrimaryTitle(acc) + "...") : ("Opening tab " + getAccountPrimaryTitle(acc) + "..."));
                        }
                        fetch(BASE_URL + "/tabs/open", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: acc.id }),
                        }).then((r) => r.json()).then((res) => {
                            hideSwitchOverlay();
                            if (!res || !res.ok) {
                                showAccountFeedback(formatAccountActionMessage(res));
                                const openMenu = document.getElementById("agy-acc-menu");
                                if (openMenu) openMenu.style.display = "flex";
                            }
                        }).catch((error) => {
                            hideSwitchOverlay();
                            showAccountFeedback(formatAccountActionMessage(error));
                            const openMenu = document.getElementById("agy-acc-menu");
                            if (openMenu) openMenu.style.display = "flex";
                        });
                    };
                }
            }

            const acts = document.createElement("div");
            acts.style.cssText = "display:flex;align-items:center;gap:3px;flex-shrink:0;";

            if (isRunningBg) {
                const stopBtn = document.createElement("button");
                stopBtn.title = ru ? "Остановить фоновый процесс этого профиля" : "Stop background server for this profile";
                stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
                stopBtn.style.cssText = "width:26px;height:26px;border-radius:var(--agy-radius-sm, 5px);border:none;background:transparent;color:var(--agy-extras-text-muted,#94a3b8);cursor:pointer;display:flex;align-items:center;justify-content:center;";
                stopBtn.onclick = (e) => {
                    e.stopPropagation();
                    fetch(BASE_URL + "/accounts/stop-server", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id }),
                    }).then((r) => r.json()).then((res) => {
                        if (res.list) accountsList = res.list;
                        renderAccountsMenu();
                    }).catch(() => {});
                };
                acts.appendChild(stopBtn);
            }

            if (!isActive) {
                const winBtn = document.createElement("button");
                winBtn.title = ru ? "Открыть в отдельном окне" : "Open in new window";
                winBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
                winBtn.style.cssText = "width:26px;height:26px;border-radius:var(--agy-radius-sm, 5px);border:none;background:transparent;color:var(--agy-extras-text-muted,#94a3b8);cursor:pointer;display:flex;align-items:center;justify-content:center;";
                winBtn.onclick = (e) => {
                    e.stopPropagation();
                    const menu = document.getElementById("agy-acc-menu");
                    if (menu) menu.style.display = "none";
                    fetch(BASE_URL + "/accounts/switch", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, openInNewWindow: true }),
                    }).catch(() => {});
                };
                acts.appendChild(winBtn);
            }

            const renBtn = document.createElement("button");
            renBtn.title = ru ? "Переименовать" : "Rename";
            renBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
            renBtn.style.cssText = "width:26px;height:26px;border-radius:var(--agy-radius-sm, 5px);border:none;background:transparent;color:var(--agy-extras-text-muted,#94a3b8);cursor:pointer;display:flex;align-items:center;justify-content:center;";
            renBtn.onclick = (e) => { e.stopPropagation(); confirmDelId = null; editingAccId = acc.id; renderAccountsMenu(); };
            acts.appendChild(renBtn);

            if (!isActive && acc.id !== "default") {
                const delBtn = document.createElement("button");
                const confirming = confirmDelId === acc.id;
                delBtn.title = confirming ? (ru ? "Подтвердить удаление" : "Confirm delete") : (ru ? "Удалить" : "Delete");
                delBtn.innerHTML = confirming
                    ? '<span style="font-size:0.78em;font-weight:600;padding:0 4px;">' + (ru ? "Да?" : "Del?") + "</span>"
                    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
                delBtn.style.cssText = "height:26px;min-width:26px;border-radius:var(--agy-radius-sm, 5px);border:none;background:" + (confirming ? "rgba(239,68,68,0.28)" : "transparent") + ";color:" + (confirming ? "#fecaca" : "#f87171") + ";cursor:pointer;display:flex;align-items:center;justify-content:center;";
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!confirming) { confirmDelId = acc.id; renderAccountsMenu(); return; }
                    confirmDelId = null;
                    fetch(BASE_URL + "/accounts/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, purgeData: true }),
                    }).then((r) => r.json()).then((res) => {
                        if (res.list) accountsList = res.list;
                        renderAccountsMenu();
                    }).catch(() => {});
                };
                acts.appendChild(delBtn);
            }

            row.append(av, info, acts);
            itemsEl.appendChild(row);
        }

        const addBtn = document.getElementById("agy-acc-add");
        if (addBtn) addBtn.textContent = ru ? "+ Добавить" : "+ Add";
        const addInp = document.getElementById("agy-acc-new-name");
        if (addInp) addInp.placeholder = ru ? "Метка аккаунта..." : "Account label...";
        const pickerBtn = document.getElementById("agy-acc-open-picker");
        if (pickerBtn) pickerBtn.textContent = ru ? "Экран аккаунтов и лимитов" : "Accounts & Quotas Screen";
    }

    let lastMediaPlaying = false;

    function ensureComposerEqStyles() {
        if (document.getElementById("agy-composer-eq-style")) return;
        const s = document.createElement("style");
        s.id = "agy-composer-eq-style";
        s.textContent = \`
            #agy-composer-eq {
                display: flex;
                align-items: flex-end;
                justify-content: center;
                gap: 3px;
                width: 100%;
                height: 0;
                margin: 0;
                padding: 0 14px;
                overflow: hidden;
                pointer-events: none;
                user-select: none;
                opacity: 0;
                transition: height 0.2s ease, opacity 0.24s ease, margin-bottom 0.2s ease;
            }
            #agy-composer-eq.active {
                height: 10px;
                margin-bottom: 4px;
                opacity: 0.46;
            }
            #agy-composer-eq span {
                width: 2.5px;
                height: 9px;
                border-radius: 1.5px;
                background: rgb(var(--agy-accent-rgb, 96, 165, 250));
                transform-origin: bottom center;
                transform: scaleY(0.22);
                will-change: transform;
            }
            #agy-composer-eq.active span {
                animation: agyBeatWave var(--d, 0.9s) ease-in-out var(--dl, 0s) infinite alternate;
            }
            html[data-agy-reduce-motion="1"] #agy-composer-eq.active span {
                animation: none !important;
                transform: scaleY(0.45);
            }
            @keyframes agyBeatWave {
                0%   { transform: scaleY(0.20); opacity: 0.55; }
                50%  { transform: scaleY(0.88); opacity: 0.95; }
                100% { transform: scaleY(0.32); opacity: 0.65; }
            }
        \`;
        (document.head || document.documentElement).appendChild(s);
    }

    function createComposerEqElement() {
        ensureComposerEqStyles();
        const el = document.createElement("div");
        el.id = "agy-composer-eq";
        el.setAttribute("data-agy-no-i18n", "1");
        el.setAttribute("aria-hidden", "true");
        // Subtle symmetric 16-bar beat wave (calm timings, low visual noise)
        const timings = [
            [1.15, 0.00], [0.88, 0.14], [0.76, 0.28], [0.98, 0.08],
            [0.72, 0.35], [0.84, 0.18], [0.68, 0.42], [0.92, 0.06],
            [0.92, 0.22], [0.68, 0.12], [0.84, 0.38], [0.72, 0.16],
            [0.98, 0.30], [0.76, 0.10], [0.88, 0.26], [1.15, 0.04],
        ];
        for (const [dur, delay] of timings) {
            const bar = document.createElement("span");
            bar.style.setProperty("--d", dur + "s");
            bar.style.setProperty("--dl", delay + "s");
            el.appendChild(bar);
        }
        return el;
    }

    function findComposerEqInsertTarget() {
        const composer = document.querySelector(".surface-composer");
        if (!composer || !composer.parentElement) return null;
        // Walk upward over any sibling attachment / live-dock / queue strip sitting directly above .surface-composer
        let target = composer;
        let prev = target.previousElementSibling;
        while (prev) {
            if (prev.id === "agy-composer-eq") {
                prev = prev.previousElementSibling;
                continue;
            }
            const cls = String(prev.className || "");
            const tid = prev.getAttribute("data-testid") || "";
            const isComposerAttachmentOrDock =
                cls.includes("agy-live-dock-slot") ||
                cls.includes("attachment") ||
                tid.includes("live-dock") ||
                tid.includes("attachment") ||
                tid.includes("queue") ||
                prev.querySelector?.('[data-testid*="attachment"], [data-testid="live-docked"]');
            if (isComposerAttachmentOrDock) {
                target = prev;
                prev = target.previousElementSibling;
            } else {
                break;
            }
        }
        return target;
    }

    function mountAndSyncComposerEq() {
        const headerEq = $s("#i-eq");
        const mode = exState.eqPosition || "composer";
        if (headerEq) {
            headerEq.style.display = (exState.showPlayer && mode === "header") ? "inline-flex" : "none";
        }
        let eqEl = document.getElementById("agy-composer-eq");
        if (!exState.showPlayer || mode !== "composer") {
            if (eqEl) eqEl.classList.remove("active");
            return;
        }
        const target = findComposerEqInsertTarget();
        if (!target || !target.parentElement) return;
        if (!eqEl) {
            eqEl = createComposerEqElement();
            target.parentElement.insertBefore(eqEl, target);
        } else if (eqEl.parentElement !== target.parentElement || eqEl.nextElementSibling !== target) {
            target.parentElement.insertBefore(eqEl, target);
        }
        eqEl.classList.toggle("active", Boolean(lastMediaPlaying));
    }

    function syncEqVisualState(playing) {
        lastMediaPlaying = Boolean(playing);
        mountAndSyncComposerEq();
    }

    function applyExtrasVisibility() {
        const pw = $s("#player-wrap");
        if (pw) pw.style.display = exState.showPlayer ? "flex" : "none";
        mountAndSyncComposerEq();
        const ring = document.getElementById("agy-ctx-ring");
        if (ring) {
            ring.style.display = exState.showContextRing ? "inline-flex" : "none";
            if (!exState.showContextRing) {
                ctxPinned = false;
                const pop = document.getElementById("agy-ctx-pop");
                if (pop) pop.style.display = "none";
            }
        }
    }

    function refreshAllCustomLabels() {
        const ru = isRu();
        const sBtn = document.getElementById("agy-style-side-btn-lbl");
        if (sBtn) sBtn.textContent = ru ? "Персонализация" : "Personalization";
        const sBtnWrap = document.getElementById("agy-style-side-btn");
        if (sBtnWrap) sBtnWrap.title = ru ? "Персонализация, обои и оптимизация" : "Personalization, wallpapers & performance";
        const aBtn = document.getElementById("agy-accounts-side-btn-lbl");
        if (aBtn) aBtn.textContent = ru ? "Аккаунты" : "Accounts";
        const aBtnWrap = document.getElementById("agy-accounts-side-btn");
        if (aBtnWrap) aBtnWrap.title = ru ? "Аккаунты и лимиты" : "Accounts & Quotas";
        const fsClose = $s("#fs-close-lbl");
        if (fsClose) fsClose.textContent = ru ? "Свернуть" : "Minimize";
        updateAccountButtonUi();
        renderAccountsMenu();
        mountAndSyncComposerEq();
        updateContextRingUi();
    }

    let ctxPinned = false;
    let ctxHoverTimer = null;

    function findContextRingAnchor() {
        const voicePill = document.querySelector('[data-testid="voice-live-pill"]');
        if (voicePill && voicePill.parentElement) return voicePill;
        const sendBtn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[data-testid="input-cancel-button"]');
        if (sendBtn && sendBtn.parentElement) return sendBtn;
        const composerSend = document.querySelector('.surface-composer button[type="submit"]');
        if (composerSend && composerSend.parentElement) return composerSend;
        return null;
    }

    function ensureContextPopover(ring) {
        let pop = document.getElementById("agy-ctx-pop");
        if (!pop) {
            pop = document.createElement("div");
            pop.id = "agy-ctx-pop";
            pop.setAttribute("data-agy-no-i18n", "1");
            pop.style.cssText = "display:none;position:fixed;width:min(410px, 24.5em);padding:13px 15px;border-radius:var(--agy-radius, 10px);background:rgba(var(--agy-tint-rgb,14,17,24),var(--agy-surface-modal-alpha,0.92));backdrop-filter:blur(22px);border:1px solid var(--agy-extras-border,rgba(255,255,255,0.14));box-shadow:0 18px 46px rgba(0,0,0,0.56);color:var(--agy-extras-text-primary,#f1f5f9);font-size:var(--agy-base-font-size, 14px);line-height:1.45;z-index:2147483646;pointer-events:auto;";
            document.body.appendChild(pop);
            pop.addEventListener("mouseenter", () => { clearTimeout(ctxHoverTimer); });
            pop.addEventListener("mouseleave", () => {
                if (ctxPinned) return;
                clearTimeout(ctxHoverTimer);
                ctxHoverTimer = setTimeout(() => { if (!ctxPinned) pop.style.display = "none"; }, 180);
            });
        }
        if (ring && ring.isConnected) {
            const rect = ring.getBoundingClientRect();
            const bottomPx = Math.max(12, window.innerHeight - rect.top + 10);
            const rightPx = Math.max(12, window.innerWidth - rect.right - 8);
            pop.style.bottom = bottomPx + "px";
            pop.style.right = rightPx + "px";
        }
        return pop;
    }

    function createContextRingElement() {
        const ring = document.createElement("div");
        ring.id = "agy-ctx-ring";
        ring.setAttribute("data-agy-no-i18n", "1");
        ring.style.cssText = "display:" + (exState.showContextRing ? "inline-flex" : "none") + ";align-items:center;justify-content:center;align-self:center;flex-shrink:0;width:30px;height:30px;margin-right:4px;border-radius:var(--agy-radius-sm, 7px);cursor:pointer;position:relative;vertical-align:middle;transition:background 0.14s ease;";
        ring.setAttribute("role", "button");
        ring.setAttribute("tabindex", "0");
        ring.setAttribute("aria-label", isRu() ? "Окно контекста" : "Context window");
        ring.innerHTML = \`
            <svg width="22" height="22" viewBox="0 0 24 24" style="transform:rotate(-90deg);overflow:visible;display:block;">
                <circle cx="12" cy="12" r="9.7" fill="none" stroke="var(--agy-extras-ring-track,rgba(255,255,255,0.24))" stroke-width="2.3"/>
                <circle id="agy-ctx-arc" cx="12" cy="12" r="9.7" fill="none" stroke="rgb(var(--agy-accent-rgb))" stroke-width="2.3" stroke-dasharray="60.95" stroke-dashoffset="60.95" stroke-linecap="round" style="transition:stroke-dashoffset 0.3s ease, stroke 0.2s ease;"/>
            </svg>
            <span id="agy-ctx-mini" style="display:none;position:absolute;font-size:8.5px;font-weight:700;line-height:1;color:var(--agy-extras-text-primary,#f1f5f9);font-variant-numeric:tabular-nums;pointer-events:none;"></span>
        \`;
        ensureContextPopover(ring);
        const showPop = () => { clearTimeout(ctxHoverTimer); const pop = ensureContextPopover(ring); if (pop) pop.style.display = "block"; };
        const hidePopDelayed = () => {
            if (ctxPinned) return;
            clearTimeout(ctxHoverTimer);
            ctxHoverTimer = setTimeout(() => { const pop = document.getElementById("agy-ctx-pop"); if (pop && !ctxPinned) pop.style.display = "none"; }, 180);
        };
        ring.addEventListener("mouseenter", () => { ring.style.background = "rgba(255,255,255,0.09)"; updateContextRingUi(); showPop(); });
        ring.addEventListener("mouseleave", () => { ring.style.background = "transparent"; hidePopDelayed(); });
        ring.addEventListener("click", (e) => {
            e.stopPropagation();
            ctxPinned = !ctxPinned;
            const pop = ensureContextPopover(ring);
            if (pop) { updateContextRingUi(); pop.style.display = ctxPinned ? "block" : "none"; }
        });
        ring.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            ring.click();
        });
        document.addEventListener("mousedown", (e) => {
            const pop = document.getElementById("agy-ctx-pop");
            if (ctxPinned && !ring.contains(e.target) && (!pop || !pop.contains(e.target))) {
                ctxPinned = false;
                if (pop) pop.style.display = "none";
            }
        });
        return ring;
    }

    function toggleSidebarAccountsPopover(anchorBtn) {
        const existing = document.getElementById("agy-acc-side-popover");
        if (existing) { existing.remove(); return; }
        const ru = isRu();
        const rect = anchorBtn.getBoundingClientRect();
        const pop = document.createElement("div");
        pop.id = "agy-acc-side-popover";
        pop.setAttribute("data-agy-no-i18n", "1");
        pop.style.cssText =
            "position:fixed;z-index:2147483645;min-width:250px;max-width:300px;padding:8px;display:flex;flex-direction:column;gap:4px;" +
            "border-radius:var(--agy-radius, 10px);background:rgba(var(--agy-tint-rgb, 14, 17, 24), 0.96);" +
            "border:1px solid rgba(255,255,255,0.14);box-shadow:0 16px 40px rgba(0,0,0,0.68);" +
            "color:#f1f5f9;font-family:var(--agy-ui-font,system-ui,sans-serif);font-size:var(--agy-base-font-size,14px);-webkit-app-region:no-drag;";
        pop.style.left = Math.max(8, Math.round(rect.left)) + "px";
        pop.style.bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8)) + "px";
        pop.innerHTML = '<div style="padding:4px 8px;font-size:0.8em;color:#94a3b8;font-weight:600;">' + (ru ? "Аккаунты" : "Accounts") + "</div>";
        const listWrap = document.createElement("div");
        listWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;";
        listWrap.innerHTML = '<div style="padding:8px;font-size:0.85em;color:#94a3b8;">' + (ru ? "Загрузка..." : "Loading...") + "</div>";
        const sep = document.createElement("div");
        sep.style.cssText = "height:1px;background:rgba(255,255,255,0.10);margin:4px 0;";
        const footer = document.createElement("div");
        footer.style.cssText = "display:flex;gap:4px;";
        const mkAction = (label, onClick) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.style.cssText =
                "flex:1;padding:6px 8px;border-radius:var(--agy-radius-sm,7px);border:1px solid rgba(255,255,255,0.10);" +
                "background:rgba(255,255,255,0.05);color:#f1f5f9;font-size:0.82em;font-weight:500;cursor:pointer;white-space:nowrap;";
            b.onmouseenter = () => { b.style.background = "rgba(var(--agy-accent-rgb,96,165,250),0.22)"; };
            b.onmouseleave = () => { b.style.background = "rgba(255,255,255,0.05)"; };
            b.onclick = (e) => { e.stopPropagation(); pop.remove(); onClick(); };
            return b;
        };
        footer.append(
            mkAction(ru ? "+ Добавить" : "+ Add", () => fetch(BASE_URL + "/accounts/open-picker", { method: "POST" }).catch(() => {})),
            mkAction(ru ? "Все аккаунты" : "All accounts", () => fetch(BASE_URL + "/accounts/open-picker", { method: "POST" }).catch(() => {}))
        );
        pop.append(listWrap, sep, footer);
        document.body.appendChild(pop);

        const closeOnOutside = (e) => {
            if (!pop.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
                pop.remove();
                document.removeEventListener("mousedown", closeOnOutside, true);
            }
        };
        setTimeout(() => document.addEventListener("mousedown", closeOnOutside, true), 0);

        fetch(BASE_URL + "/accounts/list")
            .then((r) => r.json())
            .then((snap) => {
                const accounts = Array.isArray(snap?.accounts) ? snap.accounts : [];
                const activeId = snap?.activeId || "";
                listWrap.innerHTML = "";
                for (const acc of accounts) {
                    const isAct = acc.id === activeId;
                    const row = document.createElement("button");
                    row.type = "button";
                    row.style.cssText =
                        "display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:var(--agy-radius-sm,7px);" +
                        "border:1px solid " + (isAct ? "rgba(var(--agy-accent-rgb,96,165,250),0.5)" : "transparent") + ";" +
                        "background:" + (isAct ? "rgba(var(--agy-accent-rgb,96,165,250),0.20)" : "transparent") + ";" +
                        "color:#f1f5f9;text-align:left;cursor:pointer;";
                    row.onmouseenter = () => { if (!isAct) row.style.background = "rgba(255,255,255,0.08)"; };
                    row.onmouseleave = () => { if (!isAct) row.style.background = "transparent"; };
                    const title = acc.displayName || acc.label || acc.name || acc.email || acc.id;
                    const sub = acc.email && acc.email !== title ? acc.email : "";
                    const avHtml = acc.avatar
                        ? '<img src="' + esc(acc.avatar) + '" alt="" style="width:24px;height:24px;border-radius:5px;object-fit:cover;flex-shrink:0;">'
                        : '<span style="width:24px;height:24px;border-radius:5px;background:rgba(var(--agy-accent-rgb,96,165,250),0.25);display:inline-flex;align-items:center;justify-content:center;font-size:0.78em;font-weight:700;flex-shrink:0;">' + esc(String(title).slice(0, 1).toUpperCase()) + "</span>";
                    row.innerHTML =
                        avHtml +
                        '<span style="min-width:0;flex:1;display:flex;flex-direction:column;">' +
                        '<span style="font-size:0.86em;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(title) + "</span>" +
                        (sub ? '<span style="font-size:0.74em;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(sub) + "</span>" : "") +
                        "</span>";
                    row.onclick = (e) => {
                        e.stopPropagation();
                        pop.remove();
                        fetch(BASE_URL + "/tabs/open", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: acc.id }),
                        }).catch(() => {});
                    };
                    listWrap.appendChild(row);
                }
            })
            .catch(() => {});
    }

    function injectSidebarAndContextWidgets() {
        syncRealUserToServer();
        alignTopPlayerBar();

        const settingsBtn = Array.from(document.querySelectorAll('[aria-label="Sidebar"] button, [aria-label="Sidebar"] a'))
            .find((el) => el.textContent && (el.textContent.includes("Settings") || el.textContent.includes("Настройки")));

        // 1. Accounts (when top tab bar is hidden) & Personalization stacked cleanly above Settings
        if (settingsBtn && settingsBtn.parentElement && !document.getElementById("agy-style-side-btn")) {
            const parent = settingsBtn.parentElement;
            parent.style.setProperty("display", "flex", "important");
            parent.style.setProperty("flex-direction", "column", "important");
            parent.style.setProperty("align-items", "stretch", "important");
            parent.style.setProperty("gap", "2px", "important");
            settingsBtn.style.setProperty("width", "100%", "important");

            const cs = getComputedStyle(settingsBtn);
            const sharedBtnCss =
                "align-items:center;gap:" + (cs.gap || "8px") + ";width:100%;min-height:" + (cs.minHeight && cs.minHeight !== "0px" ? cs.minHeight : (cs.height || "32px")) + ";height:" + (cs.height && cs.height !== "auto" ? cs.height : "auto") + ";padding:" + (cs.padding || "6px 10px") + ";border-radius:var(--agy-radius-sm, 7px);background:transparent;border:none;color:var(--agy-extras-text-primary,#f1f5f9);font-size:" + (cs.fontSize || "var(--agy-base-font-size, 14px)") + ";line-height:" + (cs.lineHeight || "1.4") + ";font-weight:" + (cs.fontWeight || "500") + ";cursor:pointer;text-align:left;opacity:0.86;transition:background 0.14s ease, opacity 0.14s ease;";

            const accBtn = document.createElement("button");
            accBtn.id = "agy-accounts-side-btn";
            accBtn.setAttribute("data-agy-no-i18n", "1");
            accBtn.title = isRu() ? "Аккаунты и лимиты" : "Accounts & Quotas";
            accBtn.innerHTML =
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
                '<span id="agy-accounts-side-btn-lbl" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (isRu() ? "Аккаунты" : "Accounts") + "</span>";
            accBtn.style.cssText = "display:none;" + sharedBtnCss;
            accBtn.onmouseenter = () => { accBtn.style.background = "rgba(255,255,255,0.08)"; accBtn.style.opacity = "1"; };
            accBtn.onmouseleave = () => { accBtn.style.background = "transparent"; accBtn.style.opacity = "0.86"; };
            accBtn.onclick = (e) => {
                e.stopPropagation();
                toggleSidebarAccountsPopover(accBtn);
            };
            if (window.__agyShowTopTabBar === false) accBtn.style.display = "flex";

            const styleBtn = document.createElement("button");
            styleBtn.id = "agy-style-side-btn";
            styleBtn.setAttribute("data-agy-no-i18n", "1");
            styleBtn.title = isRu() ? "Персонализация, обои и оптимизация" : "Personalization, wallpapers & performance";
            styleBtn.innerHTML =
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>' +
                '<span id="agy-style-side-btn-lbl" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (isRu() ? "Персонализация" : "Personalization") + "</span>";
            styleBtn.style.cssText = "display:flex;" + sharedBtnCss;
            styleBtn.onmouseenter = () => { styleBtn.style.background = "rgba(255,255,255,0.08)"; styleBtn.style.opacity = "1"; };
            styleBtn.onmouseleave = () => { styleBtn.style.background = "transparent"; styleBtn.style.opacity = "0.86"; };
            styleBtn.onclick = (e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent("agy-toggle-style-panel"));
            };
            parent.insertBefore(accBtn, settingsBtn);
            parent.insertBefore(styleBtn, settingsBtn);
        }

        // 2. Remove any legacy duplicate sidebar account switcher (accounts live cleanly in the top Tab Bar)
        const legacySideAcc = document.getElementById("agy-sidebar-extras");
        if (legacySideAcc) legacySideAcc.remove();

        // 3. Context Window Ring next to Composer action buttons (proportional size, always visible when enabled)
        const anchor = findContextRingAnchor();
        if (anchor && anchor.parentElement) {
            let ring = document.getElementById("agy-ctx-ring");
            if (!ring) {
                ring = createContextRingElement();
                anchor.parentElement.insertBefore(ring, anchor);
            } else if (ring.parentElement !== anchor.parentElement || ring.nextElementSibling !== anchor) {
                anchor.parentElement.insertBefore(ring, anchor);
            }
            const ah = Math.round(anchor.getBoundingClientRect().height || 30);
            const targetSize = Math.max(28, Math.min(34, ah));
            ring.style.width = targetSize + "px";
            ring.style.height = targetSize + "px";
            ring.style.display = exState.showContextRing ? "inline-flex" : "none";
        }

        mountAndSyncComposerEq();
        updateContextRingUi();
    }

    const TOKEN_GROUP_RU = {
        "system prompt": "Системный промпт",
        "system": "Система",
        "subagents": "Субагенты",
        "skills": "Навыки",
        "plugins": "Плагины",
        "tools": "Инструменты",
        "mcp": "MCP-инструменты",
        "mcp tools": "MCP-инструменты",
        "mcp servers": "MCP-серверы",
        "conversation": "История чата",
        "history": "История чата",
        "messages": "Сообщения",
        "files": "Файлы",
        "knowledge": "Знания",
        "rules": "Правила",
        "memory": "Память",
        "context": "Контекст",
        "attachments": "Вложения",
        "workspace": "Рабочая область",
        "user": "Пользователь",
        "assistant": "Ассистент",
        "other": "Прочее",
        "group": "Группа",
    };

    function translateTokenGroupLabel(raw) {
        const s = String(raw || "Group").trim();
        if (!isRu()) return s;
        if (s.toLowerCase() === "chat messages") return "Сообщения чата";
        return TOKEN_GROUP_RU[s.toLowerCase()] || s;
    }

    function updateContextRingUi() {
        const arc = document.getElementById("agy-ctx-arc");
        const mini = document.getElementById("agy-ctx-mini");
        const popEl = document.getElementById("agy-ctx-pop");
        if (!arc) return;

        const info = getLiveContextInfo();
        const ru = isRu();
        const locale = ru ? "ru-RU" : "en-US";
        const circ = 60.95;
        const visPct = info.usedTokens > 0 ? Math.max(2, info.pct) : 0;
        arc.setAttribute("stroke-dashoffset", (circ * (1 - visPct / 100)).toFixed(1));

        let strokeCol = "rgb(var(--agy-accent-rgb))";
        if (info.pct >= 82) strokeCol = "#ef4444";
        else if (info.pct >= 60) strokeCol = "#f59e0b";
        arc.setAttribute("stroke", strokeCol);
        if (mini) {
            mini.textContent = String(Math.round(info.pct));
            mini.style.display = exState.showContextPercent ? "block" : "none";
        }
        const ring = document.getElementById("agy-ctx-ring");
        if (ring) {
            ring.setAttribute("aria-label", (ru ? "Заполнено " : "Used ") + Math.round(info.pct) + "%");
            ring.setAttribute("aria-expanded", ctxPinned ? "true" : "false");
        }

        if (popEl) {
            const pctStr = info.pct < 10 ? info.pct.toFixed(1) + "%" : Math.round(info.pct) + "%";
            const pref = info.isExact ? "" : "~";
            const srcTag = info.isExact ? (ru ? "точные данные" : "exact telemetry") : (ru ? "оценка чата" : "chat estimate");

            let groupsHtml = "";
            if (info.tokenGroups.length) {
                const rows = info.tokenGroups.slice(0, 4).map((g) =>
                    '<div style="display:flex;justify-content:space-between;gap:10px;font-size:0.82em;color:var(--agy-extras-text-muted,#cbd5e1);"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(translateTokenGroupLabel(g.label || g.name || "Group")) + '</span><span style="white-space:nowrap;font-variant-numeric:tabular-nums;">' + Number(g.numTokens).toLocaleString(locale) + "</span></div>"
                ).join("");
                groupsHtml = '<div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:3px;">' + rows + "</div>";
            }

            popEl.innerHTML =
                '<div style="display:flex;flex-direction:column;gap:2px;margin-bottom:9px;">' +
                    '<span style="font-weight:600;color:var(--agy-extras-text-primary,#fff);font-size:0.95em;line-height:1.25;">' + (ru ? "Контекстное окно" : "Context Window") + '</span>' +
                    '<span style="font-size:0.82em;color:var(--agy-extras-text-muted,#94a3b8);line-height:1.3;word-break:break-word;">' + esc(ru ? String(info.modelLabel || "").replace("(Extra High)", "(Максимальный)").replace("(Low)", "(Низкий)").replace("(Medium)", "(Средний)").replace("(High)", "(Высокий)").replace("(Minimal)", "(Минимальный)") : info.modelLabel) + '</span>' +
                '</div>' +
                '<div style="width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.12);overflow:hidden;margin-bottom:9px;">' +
                    '<div style="height:100%;width:' + Math.min(100, Math.max(info.usedTokens > 0 ? 1.5 : 0, info.pct)).toFixed(1) + '%;background:' + strokeCol + ';border-radius:2px;"></div>' +
                '</div>' +
                '<div style="display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:0.88em;">' +
                    '<span style="color:var(--agy-extras-text-muted,#94a3b8);">' + (ru ? "Заполнено" : "Used") + '</span><b style="color:var(--agy-extras-text-primary,#fff);text-align:right;white-space:nowrap;">' + pctStr + '</b>' +
                    '<span style="color:var(--agy-extras-text-muted,#94a3b8);">' + (ru ? "Использовано" : "Tokens used") + '</span><b style="color:var(--agy-extras-text-primary,#fff);text-align:right;white-space:nowrap;">' + pref + info.usedTokens.toLocaleString(locale) + '</b>' +
                    '<span style="color:var(--agy-extras-text-muted,#94a3b8);">' + (ru ? "Осталось" : "Remaining") + '</span><b style="color:var(--agy-extras-text-primary,#fff);text-align:right;white-space:nowrap;">' + pref + info.leftTokens.toLocaleString(locale) + '</b>' +
                    '<span style="color:var(--agy-extras-text-muted,#94a3b8);">' + (ru ? "Лимит модели" : "Model limit") + '</span><b style="color:var(--agy-extras-text-primary,#fff);text-align:right;white-space:nowrap;">' + info.maxTokens.toLocaleString(locale) + '</b>' +
                '</div>' +
                groupsHtml +
                '<div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:0.76em;color:var(--agy-extras-text-muted,#94a3b8);white-space:nowrap;">' +
                    '<span style="white-space:nowrap;">' + info.chars.toLocaleString(locale) + (ru ? " симв. / " : " chars / ") + info.words.toLocaleString(locale) + (ru ? " сл." : " words") + '</span>' +
                    '<span style="color:var(--agy-extras-text-subtle,#64748b);white-space:nowrap;">' + srcTag + '</span>' +
                '</div>';
        }
    }

    // Hydrate saved extras state from disk on startup
    fetch(BASE_URL + "/extras/config")
        .then((r) => r.json())
        .then((disk) => {
            if (!disk || typeof disk !== "object") return;
            if (typeof disk.showContextPercent === "boolean") exState.showContextPercent = disk.showContextPercent;
            applySavedObject(disk);
            if (window.__agyI18n) window.__agyI18n.setLang(exState.lang);
            applyExtrasVisibility();
            updateContextRingUi();
            refreshAllCustomLabels();
            handleRepeatedOnboardingModal();
        })
        .catch(() => {});

    // Live cross-tab sync for extras settings & accounts via shared SSE
    try {
        const exEs = window.__agySharedEventSource || (window.__agySharedEventSource = new EventSource(BASE_URL + "/events"));
        exEs.addEventListener("extras", (ev) => {
            try {
                const disk = JSON.parse(ev.data);
                if (!disk || typeof disk !== "object") return;
                if (typeof disk.showContextPercent === "boolean") exState.showContextPercent = disk.showContextPercent;
                applySavedObject(disk);
                try { localStorage.setItem(EX_KEY, JSON.stringify(exState)); } catch {}
                if (window.__agyI18n) window.__agyI18n.setLang(exState.lang);
                applyExtrasVisibility();
                updateContextRingUi();
                refreshAllCustomLabels();
                handleRepeatedOnboardingModal();
            } catch {}
        });
        exEs.addEventListener("accounts", (ev) => {
            try {
                const snap = JSON.parse(ev.data);
                if (snap && Array.isArray(snap.accounts)) {
                    accountsList = snap.accounts;
                    updateAccountButtonUi();
                    renderAccountsMenu();
                }
            } catch {}
        });
    } catch {}

    let isTabVisible = true;
    window.addEventListener("agy-tab-visibility", (e) => {
        isTabVisible = Boolean(e.detail?.visible);
        if (isTabVisible) {
            injectSidebarAndContextWidgets();
            handleRepeatedOnboardingModal();
        }
    });

    // Instant reactive DOM mount for sidebar + context ring + onboarding dismissal (zero lag)
    let mountRaf = 0;
    const scheduleMountCheck = () => {
        handleRepeatedOnboardingModal();
        if (!isTabVisible || mountRaf) return;
        mountRaf = requestAnimationFrame(() => {
            mountRaf = 0;
            const needSide = !document.getElementById("agy-style-side-btn");
            const needRing = !document.getElementById("agy-ctx-ring");
            const needEq = exState.showPlayer && (exState.eqPosition || "composer") === "composer" && !document.getElementById("agy-composer-eq");
            if (needSide || needRing || needEq) injectSidebarAndContextWidgets();
            else if (exState.showPlayer && (exState.eqPosition || "composer") === "composer") mountAndSyncComposerEq();
            handleRepeatedOnboardingModal();
        });
    };
    const obsRoot = document.body || document.getElementById("root");
    if (obsRoot) {
        new MutationObserver(scheduleMountCheck).observe(obsRoot, { childList: true, subtree: true });
    }

    function findOnboardingDialogs() {
        const found = new Set();
        const termsBodies = document.querySelectorAll('[data-testid="post-onboarding-terms-body"]');
        for (const bodyEl of termsBodies) {
            const dlg = bodyEl.closest('[role="dialog"], [aria-modal="true"], .fixed') || bodyEl.parentElement?.parentElement;
            if (dlg) found.add(dlg);
        }
        const candidates = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed');
        for (const dlg of candidates) {
            if (found.has(dlg)) continue;
            const txt = dlg.textContent || "";
            if (
                txt.includes("One last thing before getting started") ||
                txt.includes("Terms of Service & Data Use") ||
                txt.includes("Последний шаг перед началом") ||
                txt.includes("Последний штрих перед началом") ||
                txt.includes("Условия и использование данных")
            ) {
                found.add(dlg);
            }
        }
        return Array.from(found);
    }

    function handleRepeatedOnboardingModal() {
        try {
            const dialogs = findOnboardingDialogs();
            if (!dialogs.length) return;
            const accepted = isOnboardingAccepted();
            for (const dlg of dialogs) {
                const btn = Array.from(dlg.querySelectorAll("button")).find((b) => {
                    const t = (b.textContent || "").trim();
                    return t === "Continue" || t === "Продолжить" || t === "Get started" || t === "Начать";
                });
                if (!btn) continue;
                if (accepted) {
                    if (!btn.disabled) {
                        const lastTry = Number(btn.dataset.agyAutoClickTs || 0);
                        const now = Date.now();
                        if (now - lastTry > 800) {
                            btn.dataset.agyAutoClickTs = String(now);
                            // Suppress visual flash while React unmounts the modal
                            dlg.style.opacity = "0";
                            dlg.style.pointerEvents = "none";
                            btn.click();
                        }
                    }
                    return;
                }
                if (!btn.dataset.agyOnboardingHooked) {
                    btn.dataset.agyOnboardingHooked = "1";
                    btn.addEventListener("click", () => {
                        markOnboardingAccepted();
                    }, { capture: true, once: true });
                }
            }
        } catch {}
    }

    const EMAIL_SPOILER_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/;
    function scanPrivacySpoilers() {
        if (document.documentElement?.dataset?.agyPrivacy !== "1" || !document.body) return;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const val = node.nodeValue;
            if (!val || val.indexOf("@") === -1 || val.length > 160) continue;
            if (!EMAIL_SPOILER_RE.test(val)) continue;
            const parent = node.parentElement;
            if (!parent || parent.getAttribute("data-agy-spoiler") === "1") continue;
            if (parent.closest("pre, code, .monaco-editor, .cm-editor, textarea, input")) continue;
            parent.setAttribute("data-agy-spoiler", "1");
        }
    }
    window.addEventListener("agy-privacy-sync", () => {
        if (document.documentElement?.dataset?.agyPrivacy === "1") scanPrivacySpoilers();
    });

    applyExtrasVisibility();
    injectSidebarAndContextWidgets();
    handleRepeatedOnboardingModal();
    setInterval(() => {
        syncRealUserToServer();
        handleRepeatedOnboardingModal();
        if (isTabVisible) {
            injectSidebarAndContextWidgets();
            if (document.documentElement?.dataset?.agyPrivacy === "1") scanPrivacySpoilers();
        }
    }, 2500);
})();`;

    return i18nJs + "\n;\n" + mainExtrasJs;
}

module.exports = {
    handleExtrasRequest,
    buildExtrasClientJs,
};
