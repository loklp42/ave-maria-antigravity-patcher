"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

let electronApp = null;
let pathsMod = null;
let winIsolation = null;
try { electronApp = require("electron").app; } catch {}
try { pathsMod = require("./paths"); } catch {}
try { winIsolation = require("./agyWinUserIsolation"); } catch {}

function getLsMod() {
    try { return require("./languageServer"); } catch { return null; }
}

function getTabManager() {
    try { return require("./agyTabManager"); } catch { return null; }
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

function getAccountsFile() {
    return path.join(getAppDataRoot(), "agy_accounts.json");
}

function sanitizeId(raw) {
    const s = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return s || "default";
}

function normalizeRequestedId(raw) {
    if (typeof raw !== "string") return null;
    const id = raw.trim().toLowerCase();
    return id && /^[a-z0-9_-]+$/.test(id) ? id : null;
}

function classifyTierType(tier) {
    if (!tier) return "trial";
    const s = [
        typeof tier === "string" ? tier : "",
        tier.id,
        tier.name,
        tier.planName,
        tier.teamsTier,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!s) return "trial";
    if (s.includes("ultra")) return "ultra";
    if (s.includes("pro") || s.includes("plus") || s.includes("paid") || s.includes("business") || s.includes("team") || s.includes("standard")) return "pro";
    return "trial";
}

function cleanModelLabel(label) {
    if (!label || typeof label !== "string") return "";
    let s = label.trim();

    if (/^(?:orchestrator|оркестратор)(?:\s|$|\(|\:|\-)/i.test(s)) {
        s = s.replace(/\s*\((?:neon|неон)\)/gi, "")
             .replace(/\s*-\s*(?:neon|неон)/gi, "")
             .replace(/\s*:\s*(?:neon|неон)/gi, "")
             .replace(/\b(?:gemini\s+4\s+neon|neon|неон)\b/gi, "")
             .trim();
    }

    s = s.replace(/\s*\((?:extra\s+high|ultra\s+high|high|medium|low|максимальный|высокий|средний|низкий)\)/gi, "")
         .replace(/\s*-\s*(?:extra\s+high|ultra\s+high|high|medium|low|максимальный|высокий|средний|низкий)$/gi, "")
         .replace(/\s*:\s*(?:extra\s+high|ultra\s+high|high|medium|low|максимальный|высокий|средний|низкий)$/gi, "")
         .replace(/\s+(?:extra\s+high|ultra\s+high|high|medium|low|максимальный|высокий|средний|низкий)$/gi, "")
         .trim();

    return s.replace(/\s+/g, " ");
}

function classifyFamily(lbl) {
    const s = String(lbl || "").toLowerCase();
    if (s.includes("claude") || s.includes("sonnet") || s.includes("opus") || s.includes("haiku") || s.includes("gpt") || /\bo[134]\b/.test(s)) {
        return "claude_gpt";
    }
    if (
        s.includes("gemini") ||
        s.includes("argon") ||
        s.includes("carbon") ||
        s.includes("hydrogen") ||
        s.includes("neon") ||
        s.includes("orchestrator") ||
        s.includes("оркестратор")
    ) {
        return "gemini";
    }
    return "other:" + s;
}

function normalizeQuotasForTier(quotas, tier) {
    if (!Array.isArray(quotas) || quotas.length === 0) return [];
    const hasTierInfo = Boolean(
        tier &&
        (typeof tier === "string"
            ? tier.trim()
            : [tier.id, tier.name, tier.planName, tier.teamsTier].some((v) => typeof v === "string" && v.trim()))
    );
    const tierType = hasTierInfo ? classifyTierType(tier) : "unknown";
    const out = [];
    const seen = new Set();
    let geminiGroup = null;
    let claudeGroup = null;

    const mergeIntoGroup = (group, q, defaultLabel) => {
        if (!group) return { ...q, label: defaultLabel };
        if (q.remainingFraction >= 0) {
            group.remainingFraction = group.remainingFraction < 0
                ? q.remainingFraction
                : Math.min(group.remainingFraction, q.remainingFraction);
        }
        if (!group.resetTime && q.resetTime) group.resetTime = q.resetTime;
        return group;
    };

    for (const q of quotas) {
        if (!q || typeof q !== "object") continue;
        const lbl = cleanModelLabel(String(q.label || q.modelId || ""));
        if (!lbl) continue;

        // Automatically hide locked/unavailable models (0% with no active resetTime, or 0% on Trial)
        if (q.remainingFraction === 0 && (!q.resetTime || tierType === "trial")) continue;

        const fam = classifyFamily(lbl);
        if (fam === "gemini") {
            geminiGroup = mergeIntoGroup(geminiGroup, q, "Gemini Models");
            continue;
        }
        if (fam === "claude_gpt") {
            claudeGroup = mergeIntoGroup(claudeGroup, q, "Claude & GPT");
            continue;
        }

        const normKey = lbl.toLowerCase();
        if (seen.has(normKey)) {
            const existing = out.find((item) => item.label.toLowerCase() === normKey);
            if (existing && q.remainingFraction >= 0) {
                existing.remainingFraction = existing.remainingFraction < 0
                    ? q.remainingFraction
                    : Math.min(existing.remainingFraction, q.remainingFraction);
            }
            continue;
        }
        seen.add(normKey);
        out.push({ ...q, label: lbl });
    }

    if (claudeGroup) out.push(claudeGroup);
    if (geminiGroup) out.unshift(geminiGroup);
    return out;
}

function sanitizeQuotaList(raw, tier) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const label = cleanModelLabel(String(item.label || item.modelId || "").trim().slice(0, 80));
        if (!label) continue;
        const modelId = String(item.modelId || label).trim().slice(0, 120);
        const rawFrac = item.remainingFraction;
        let remainingFraction = (rawFrac === null || rawFrac === undefined || rawFrac === "") ? NaN : Number(rawFrac);
        if (!Number.isFinite(remainingFraction)) remainingFraction = -1;
        else remainingFraction = Math.max(0, Math.min(1, remainingFraction));
        const resetTime = typeof item.resetTime === "string" ? item.resetTime.trim().slice(0, 64) : "";
        out.push({ modelId, label, remainingFraction, resetTime });
        if (out.length >= 24) break;
    }
    return normalizeQuotasForTier(out, tier);
}

function sanitizeTier(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || raw.planName || "").trim().slice(0, 80);
    const id = String(raw.id || "").trim().slice(0, 80);
    const planName = String(raw.planName || raw.name || "").trim().slice(0, 80);
    if (!name && !id && !planName) return null;
    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    return {
        id,
        name: name || planName,
        planName: planName || name,
        promptCreditsUsed: num(raw.promptCreditsUsed),
        promptCreditsAvail: num(raw.promptCreditsAvail),
        flowCreditsUsed: num(raw.flowCreditsUsed),
        flowCreditsAvail: num(raw.flowCreditsAvail),
    };
}

function sanitizeAvatarUrl(raw) {
    const rawAvatar = typeof raw === "string" ? raw.trim() : "";
    if (!rawAvatar || rawAvatar.length > 65536) return "";
    if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(rawAvatar)) {
        return rawAvatar;
    }
    if (rawAvatar.length <= 1024) {
        try {
            const u = new URL(rawAvatar);
            if (u.protocol === "https:") return u.toString();
        } catch {}
    }
    return "";
}

function serializeAccount(account) {
    const id = sanitizeId(account.id);
    const isDefault = id === "default";
    const isolationMode = isDefault
        ? "native"
        : (process.platform === "win32"
            ? (account.isolationMode === "winuser" || account.winUser
                ? "winuser"
                : (account.isolationMode === "legacy" ? "legacy" : "winuser"))
            : "profile");
    const winUser = isDefault ? "" : (typeof account.winUser === "string" ? account.winUser.trim() : "");
    const geminiDir = isDefault
        ? ""
        : (typeof account.geminiDir === "string" && account.geminiDir.trim()
            ? account.geminiDir.trim()
            : (winUser && winIsolation ? winIsolation.getIsolatedGeminiDir(id) : ""));

    const sanitizedTier = sanitizeTier(account.tier);
    return {
        id,
        customLabel: typeof account.customLabel === "string" ? account.customLabel.trim().slice(0, 48) : "",
        displayName: typeof account.displayName === "string" ? account.displayName.trim().slice(0, 80) : "",
        email: typeof account.email === "string" ? account.email.trim().slice(0, 120) : "",
        avatar: sanitizeAvatarUrl(account.avatar),
        isolationMode,
        winUser,
        geminiDir,
        tier: sanitizedTier,
        quotas: sanitizeQuotaList(account.quotas, sanitizedTier),
        quotaUpdatedAt: Number(account.quotaUpdatedAt) || 0,
        createdAt: Number(account.createdAt) || Date.now(),
        lastUsedAt: Number(account.lastUsedAt) || Date.now(),
    };
}

// In-memory live runtime state per account (never written stale to disk)
const _runtimeByAccount = new Map();
const _changeListeners = new Set();

function onAccountsChanged(listener) {
    if (typeof listener !== "function") return () => {};
    _changeListeners.add(listener);
    return () => _changeListeners.delete(listener);
}

function emitAccountsChanged(reason = "update") {
    const payload = getAccountsSnapshot();
    for (const fn of [..._changeListeners]) {
        try { fn(payload, reason); } catch {}
    }
}

function getRuntimeState(accountId) {
    const id = sanitizeId(accountId);
    let rt = _runtimeByAccount.get(id);
    if (!rt) {
        rt = {
            tabOpen: false,
            status: "stopped", // stopped | starting | ready | working | waiting | error
            activeAgentCount: 0,
            waitingForUser: false,
            isLiveQuota: false,
            lastError: "",
            updatedAt: 0,
        };
        _runtimeByAccount.set(id, rt);
    }
    return rt;
}

function updateRuntimeState(accountId, patch = {}, shouldEmit = true) {
    const id = sanitizeId(accountId);
    const rt = getRuntimeState(id);
    let changed = false;

    if (typeof patch.tabOpen === "boolean" && rt.tabOpen !== patch.tabOpen) {
        rt.tabOpen = patch.tabOpen;
        changed = true;
    }
    if (typeof patch.activeAgentCount === "number" && Number.isFinite(patch.activeAgentCount)) {
        const nextCount = Math.max(0, Math.round(patch.activeAgentCount));
        if (rt.activeAgentCount !== nextCount) {
            rt.activeAgentCount = nextCount;
            changed = true;
        }
    }
    if (typeof patch.waitingForUser === "boolean" && rt.waitingForUser !== patch.waitingForUser) {
        rt.waitingForUser = patch.waitingForUser;
        changed = true;
    }
    if (typeof patch.isLiveQuota === "boolean" && rt.isLiveQuota !== patch.isLiveQuota) {
        rt.isLiveQuota = patch.isLiveQuota;
        changed = true;
    }
    if (typeof patch.lastError === "string" && rt.lastError !== patch.lastError) {
        rt.lastError = patch.lastError;
        changed = true;
    }
    if (typeof patch.status === "string" && rt.status !== patch.status) {
        rt.status = patch.status;
        changed = true;
    }

    // Derive coherent live status if tab or background server is running and not starting/error
    const isLive = rt.tabOpen || getRunningProfileSet().has(id);
    if (isLive && rt.status !== "starting" && rt.status !== "error") {
        const derived = rt.waitingForUser
            ? "waiting"
            : (rt.activeAgentCount > 0 ? "working" : "ready");
        if (rt.status !== derived) {
            rt.status = derived;
            changed = true;
        }
    } else if (!isLive && rt.status !== "starting") {
        if (rt.status !== "stopped" || rt.activeAgentCount !== 0 || rt.waitingForUser || rt.isLiveQuota) {
            rt.status = "stopped";
            rt.activeAgentCount = 0;
            rt.waitingForUser = false;
            rt.isLiveQuota = false;
            changed = true;
        }
    }

    rt.updatedAt = Date.now();
    if (changed && shouldEmit) {
        emitAccountsChanged("runtime");
    }
    return rt;
}

function getActiveProfileId() {
    const tm = getTabManager();
    if (tm && typeof tm.getActiveAccountId === "function") {
        const active = tm.getActiveAccountId();
        if (active) return active;
    }
    if (pathsMod && typeof pathsMod.getActiveProfileName === "function") {
        return pathsMod.getActiveProfileName() || "default";
    }
    return "default";
}

function getRunningProfileSet() {
    const lsMod = getLsMod();
    if (lsMod && typeof lsMod.getRunningProfiles === "function") {
        try {
            return new Set(lsMod.getRunningProfiles());
        } catch {}
    }
    return new Set();
}

function getOpenTabsSet() {
    const tm = getTabManager();
    if (tm && typeof tm.getOpenAccountIds === "function") {
        try {
            return new Set(tm.getOpenAccountIds());
        } catch {}
    }
    return new Set();
}

function decorateAccounts(list) {
    const runningSet = getRunningProfileSet();
    const openTabsSet = getOpenTabsSet();
    return list.map((account) => {
        const rt = getRuntimeState(account.id);
        const lsRunning = runningSet.has(account.id);
        const tabOpen = openTabsSet.has(account.id) || rt.tabOpen;
        const isolationReady = account.id === "default"
            ? true
            : (process.platform === "win32"
                ? Boolean(
                    account.winUser &&
                    winIsolation &&
                    winIsolation.isIsolatedAccountProvisionedSync(account.id, account.winUser)
                )
                : true);
        let status = rt.status;
        if (status !== "starting" && status !== "error") {
            if (!lsRunning && !tabOpen) status = "stopped";
            else if (rt.waitingForUser) status = "waiting";
            else if (rt.activeAgentCount > 0) status = "working";
            else status = "ready";
        }
        return {
            ...account,
            switchable: true,
            running: lsRunning,
            lsRunning,
            tabOpen,
            isolationReady,
            status,
            activeAgentCount: lsRunning || tabOpen ? rt.activeAgentCount : 0,
            waitingForUser: lsRunning || tabOpen ? rt.waitingForUser : false,
            isLiveQuota: Boolean((lsRunning || tabOpen) && rt.isLiveQuota),
            lastError: rt.lastError || "",
        };
    });
}

let _accountsCache = { file: "", mtimeMs: -1, size: -1, list: null };

function readAccountsListFromDisk(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed
        .filter((a) => a && typeof a === "object" && a.id)
        .map((a) => serializeAccount(a));
}

function loadRawAccounts(forceFresh = false) {
    const file = getAccountsFile();
    if (!forceFresh && _accountsCache.file === file && Array.isArray(_accountsCache.list)) {
        try {
            const st = fs.statSync(file);
            if (st.mtimeMs === _accountsCache.mtimeMs && st.size === _accountsCache.size) {
                return _accountsCache.list.map((a) => serializeAccount(a));
            }
        } catch {}
    }

    let list = null;
    try {
        if (fs.existsSync(file)) {
            list = readAccountsListFromDisk(file);
        }
    } catch {
        list = null;
    }

    // Fallback to .bak if primary agy_accounts.json was corrupted mid-write
    if (!list) {
        const bakFile = `${file}.bak`;
        try {
            if (fs.existsSync(bakFile)) {
                list = readAccountsListFromDisk(bakFile);
            }
        } catch {
            list = null;
        }
    }

    if (!Array.isArray(list)) list = [];

    if (!list.some((a) => a.id === "default")) {
        list.unshift(serializeAccount({
            id: "default",
            customLabel: "",
            displayName: "",
            email: "",
            avatar: "",
            isolationMode: "native",
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
        }));
    }

    try {
        if (fs.existsSync(file)) {
            const st = fs.statSync(file);
            _accountsCache = { file, mtimeMs: st.mtimeMs, size: st.size, list: list.map((a) => serializeAccount(a)) };
        } else {
            _accountsCache = { file: "", mtimeMs: -1, size: -1, list: null };
        }
    } catch {
        _accountsCache = { file: "", mtimeMs: -1, size: -1, list: null };
    }
    return list;
}

function loadAccounts() {
    return decorateAccounts(loadRawAccounts());
}

function getAccountById(profileId) {
    const id = sanitizeId(profileId);
    return loadAccounts().find((a) => a.id === id) || null;
}

function getAccountsSnapshot() {
    const tm = getTabManager();
    const viewMode = tm && typeof tm.getViewMode === "function" ? tm.getViewMode() : "tab";
    const activeTabId = tm && typeof tm.getActiveAccountId === "function" ? tm.getActiveAccountId() : getActiveProfileId();
    const openTabOrder = tm && typeof tm.getOpenAccountIds === "function" ? tm.getOpenAccountIds() : [];
    return {
        activeId: activeTabId || "",
        viewMode, // "picker" | "tab"
        openTabOrder,
        accounts: loadAccounts(),
        platform: process.platform,
    };
}

let _saveTmpSeq = 0;

function sleepSyncMs(ms) {
    if (!(ms > 0)) return;
    try {
        if (typeof SharedArrayBuffer === "function" && typeof Atomics === "object" && typeof Atomics.wait === "function") {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
            return;
        }
    } catch {}
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback */ }
}

function renameOverWithRetrySync(src, dst) {
    const delays = [25, 50, 100, 150, 200];
    for (let i = 0; i <= delays.length; i++) {
        try {
            fs.renameSync(src, dst);
            return;
        } catch (err) {
            const code = err && err.code;
            const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
            if (!retryable || i === delays.length) throw err;
            sleepSyncMs(delays[i]);
        }
    }
}

function saveAccounts(list) {
    const file = getAccountsFile();
    const tmp = `${file}.${process.pid}.${Date.now()}.${++_saveTmpSeq}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const serialized = list.map(serializeAccount);
        const payload = JSON.stringify(serialized, null, 2);
        fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
        try {
            if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
        } catch {}
        renameOverWithRetrySync(tmp, file);
        try {
            const st = fs.statSync(file);
            _accountsCache = { file, mtimeMs: st.mtimeMs, size: st.size, list: serialized };
        } catch {
            _accountsCache = { file: "", mtimeMs: -1, size: -1, list: null };
        }
        return true;
    } catch {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        _accountsCache = { file: "", mtimeMs: -1, size: -1, list: null };
        return false;
    }
}

function mutateAccounts(mutator) {
    const fresh = loadRawAccounts(true);
    const next = mutator(fresh) || fresh;
    if (!saveAccounts(next)) {
        throw new Error("Failed to save accounts storage");
    }
    return next;
}

function syncCurrentAccount(profileId, info) {
    const id = sanitizeId(profileId || getActiveProfileId());
    const initialList = loadRawAccounts(true);
    if (!initialList.some((a) => a.id === id) && id !== "default") {
        return { ok: false, error: "unknown_account", accounts: decorateAccounts(initialList) };
    }

    const displayName = String(info?.displayName || "").trim();
    const email = String(info?.email || "").trim();
    const avatar = String(info?.avatar || "").trim();
    const nextTier = sanitizeTier(info?.tier);
    const hasFile = fs.existsSync(getAccountsFile());

    let diskChanged = false;
    let nextQuotasForRuntime = [];
    let finalList = initialList;

    const applySync = (list) => {
        let item = list.find((a) => a.id === id);
        if (!item) {
            if (id !== "default") return list;
            item = serializeAccount({ id, createdAt: Date.now(), lastUsedAt: Date.now() });
            list.push(item);
            diskChanged = true;
        }
        const emailOwnedByOther = email && list.some((a) => a.id !== id && a.email && a.email.toLowerCase() === email.toLowerCase());
        if (!emailOwnedByOther || !item.email) {
            if (displayName && item.displayName !== displayName) { item.displayName = displayName; diskChanged = true; }
            if (email && item.email !== email) { item.email = email; diskChanged = true; }
            if (avatar && item.avatar !== avatar) { item.avatar = avatar; diskChanged = true; }
        }
        if (nextTier && JSON.stringify(nextTier) !== JSON.stringify(item.tier)) {
            item.tier = nextTier;
            diskChanged = true;
        }
        const nextQuotas = sanitizeQuotaList(info?.quotas, nextTier || item.tier);
        nextQuotasForRuntime = nextQuotas;
        if (nextQuotas.length > 0) {
            const prevJson = JSON.stringify(item.quotas || []);
            const nextJson = JSON.stringify(nextQuotas);
            if (prevJson !== nextJson || !item.quotaUpdatedAt) {
                item.quotas = nextQuotas;
                item.quotaUpdatedAt = Date.now();
                diskChanged = true;
            } else if (Date.now() - (item.quotaUpdatedAt || 0) > 60000) {
                item.quotaUpdatedAt = Date.now();
                diskChanged = true;
            }
        }
        item.lastUsedAt = Date.now();
        return list;
    };

    try {
        finalList = mutateAccounts(applySync);
    } catch {
        // Fallback when disk write fails, keep in-memory state consistent without false disk claim
        if (!hasFile) diskChanged = false;
    }

    // Update live runtime fields (status / agent count / live quota flag)
    const runtimePatch = {};
    if (nextQuotasForRuntime.length > 0 || nextTier) runtimePatch.isLiveQuota = true;
    if (typeof info?.waitingForUser === "boolean") runtimePatch.waitingForUser = info.waitingForUser;
    if (typeof info?.activeAgentCount === "number" && Number.isFinite(info.activeAgentCount)) {
        runtimePatch.activeAgentCount = info.activeAgentCount;
    }
    if (Object.keys(runtimePatch).length > 0) {
        updateRuntimeState(id, runtimePatch, false);
    }

    if (diskChanged || Object.keys(runtimePatch).length > 0) {
        emitAccountsChanged("sync");
    }
    return decorateAccounts(finalList);
}

function spawnProfileWindow(profileId) {
    const id = sanitizeId(profileId);
    const args = id === "default" ? [] : ["--agy-profile=" + id];
    const env = Object.assign({}, process.env);
    if (id === "default") delete env.AGY_PROFILE;
    else env.AGY_PROFILE = id;
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        env,
    });
    child.unref();
    return true;
}

async function addAccount(customLabel = "", openInNewWindow = false, opts = {}) {
    const list = loadRawAccounts();
    const id = "acc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    const cleanLabel = String(customLabel || "").trim().slice(0, 48);

    let winUser = "";
    let geminiDir = pathsMod && typeof pathsMod.getGeminiDirForProfile === "function"
        ? pathsMod.getGeminiDirForProfile(id)
        : path.join(os.homedir(), ".gemini-profiles", id);

    // On Windows, provision a real isolated local Windows user (one-time UAC)
    const shouldProvisionWinUser = process.platform === "win32" && winIsolation && opts.skipWinProvision !== true;
    if (shouldProvisionWinUser) {
        const prov = await winIsolation.provisionIsolatedAccount(id);
        if (!prov.ok) {
            return {
                ok: false,
                error: prov.error || "winuser_provision_failed",
                message: prov.message || "Could not create isolated Windows user",
                list: decorateAccounts(list),
            };
        }
        winUser = prov.winUser;
        geminiDir = prov.geminiDir;
    } else {
        try { fs.mkdirSync(geminiDir, { recursive: true }); } catch {}
    }

    const newItem = serializeAccount({
        id,
        customLabel: cleanLabel,
        displayName: "",
        email: "",
        avatar: "",
        isolationMode: winUser ? "winuser" : (process.platform === "win32" ? "legacy" : "profile"),
        winUser,
        geminiDir,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
    });

    try {
        mutateAccounts((fresh) => {
            if (!fresh.some((a) => a.id === id)) fresh.push(newItem);
        });
    } catch (err) {
        if (winUser && winIsolation) {
            try { await winIsolation.removeIsolatedAccount(id, winUser); } catch {}
        } else {
            try { await fs.promises.rm(geminiDir, { recursive: true, force: true }); } catch {}
        }
        return { ok: false, error: "save_failed", message: String(err?.message || err), list: loadAccounts() };
    }
    emitAccountsChanged("add");

    if (openInNewWindow) {
        try {
            spawnProfileWindow(id);
            return { ok: true, id, target: id, mode: "window", list: loadAccounts() };
        } catch (err) {
            const rolled = mutateAccounts((fresh) => fresh.filter((a) => a.id !== id));
            return { ok: false, error: "window_start_failed", message: String(err?.message || err), list: decorateAccounts(rolled) };
        }
    }

    // Prefer opening as a tab in the single BaseWindow when TabManager is active
    const tm = getTabManager();
    if (tm && typeof tm.hasMainWindow === "function" && tm.hasMainWindow()) {
        if (opts.autoOpen === false) {
            return { ok: true, id, target: id, mode: "created", list: loadAccounts() };
        }
        const openRes = await tm.openOrActivateAccount(id);
        return { ...openRes, id, target: id, mode: "tab", list: loadAccounts() };
    }

    const lsMod = getLsMod();
    if (lsMod && typeof lsMod.switchActiveProfileInPlace === "function") {
        try {
            await lsMod.switchActiveProfileInPlace(id);
            return { ok: true, id, target: id, mode: "in-place", list: loadAccounts() };
        } catch (err) {
            const rolled = mutateAccounts((fresh) => fresh.filter((a) => a.id !== id));
            if (winUser && winIsolation) {
                try { await winIsolation.removeIsolatedAccount(id, winUser); } catch {}
            } else {
                try { await fs.promises.rm(geminiDir, { recursive: true, force: true }); } catch {}
            }
            return { ok: false, error: "profile_start_failed", message: String(err?.message || err), list: decorateAccounts(rolled) };
        }
    }

    try {
        spawnProfileWindow(id);
        return { ok: true, id, target: id, mode: "window", list: loadAccounts() };
    } catch (err) {
        const rolled = mutateAccounts((fresh) => fresh.filter((a) => a.id !== id));
        return { ok: false, error: "window_start_failed", message: String(err?.message || err), list: decorateAccounts(rolled) };
    }
}

async function repairAccountIsolation(profileId) {
    const id = normalizeRequestedId(profileId);
    if (!id || id === "default") {
        return { ok: false, error: "invalid_account_id", list: loadAccounts() };
    }
    if (process.platform !== "win32" || !winIsolation) {
        return { ok: false, error: "unsupported_platform", list: loadAccounts() };
    }
    const existing = loadRawAccounts().find((a) => a.id === id);
    if (!existing) return { ok: false, error: "not_found", list: loadAccounts() };

    const prov = await winIsolation.provisionIsolatedAccount(id, existing.winUser || "");
    if (!prov.ok) {
        return { ok: false, error: prov.error, message: prov.message, list: loadAccounts() };
    }
    try {
        mutateAccounts((fresh) => {
            const target = fresh.find((a) => a.id === id);
            if (target) {
                target.winUser = prov.winUser;
                target.geminiDir = prov.geminiDir;
                target.isolationMode = "winuser";
            }
        });
    } catch (err) {
        return { ok: false, error: "save_failed", message: String(err?.message || err), list: loadAccounts() };
    }
    emitAccountsChanged("repair");
    return { ok: true, id, winUser: prov.winUser, list: loadAccounts() };
}

function renameAccount(profileId, newLabel) {
    const id = sanitizeId(profileId);
    let found = false;
    try {
        mutateAccounts((fresh) => {
            const item = fresh.find((a) => a.id === id);
            if (!item) return fresh;
            found = true;
            item.customLabel = String(newLabel || "").trim().slice(0, 48);
            return fresh;
        });
    } catch (err) {
        return { ok: false, error: "save_failed", message: String(err?.message || err), list: loadAccounts() };
    }
    if (!found) return { ok: false, error: "not_found", list: loadAccounts() };
    emitAccountsChanged("rename");
    return { ok: true, list: loadAccounts() };
}

async function stopAccountServer(profileId, allowActive = true) {
    const id = normalizeRequestedId(profileId);
    if (!id) return { ok: false, error: "invalid_account_id", list: loadAccounts() };
    const tm = getTabManager();
    if (tm && typeof tm.closeAccountTab === "function" && tm.hasMainWindow?.()) {
        await tm.closeAccountTab(id, { stopServer: true });
        return { ok: true, stopped: true, list: loadAccounts() };
    }
    const lsMod = getLsMod();
    if (lsMod && typeof lsMod.stopProfileServer === "function") {
        const res = await lsMod.stopProfileServer(id, { allowActive });
        updateRuntimeState(id, { tabOpen: false, status: "stopped", activeAgentCount: 0, waitingForUser: false, isLiveQuota: false });
        return { ...res, list: loadAccounts() };
    }
    return { ok: false, error: "unsupported", list: loadAccounts() };
}

async function deleteAccount(profileId, activeProfileId, purgeData = true) {
    const id = sanitizeId(profileId);
    if (id === "default") return { ok: false, error: "cannot_delete_default" };

    const tm = getTabManager();
    const hasTabs = Boolean(tm && typeof tm.hasMainWindow === "function" && tm.hasMainWindow());
    if (!hasTabs) {
        const active = sanitizeId(activeProfileId || getActiveProfileId());
        if (id === active) return { ok: false, error: "cannot_delete_active" };
    } else if (typeof tm.closeAccountTab === "function") {
        await tm.closeAccountTab(id, { stopServer: true });
    }

    const list = loadRawAccounts();
    const targetItem = list.find((a) => a.id === id);

    const lsMod = getLsMod();
    if (lsMod && typeof lsMod.stopProfileServer === "function") {
        try { await lsMod.stopProfileServer(id, { allowActive: true }); } catch {}
    }

    if (purgeData && targetItem?.winUser && winIsolation) {
        try {
            const rem = await winIsolation.removeIsolatedAccount(id, targetItem.winUser);
            if (!rem.ok && (rem.error === "uac_cancelled" || rem.error === "uac_failed" || rem.error === "uac_action_failed")) {
                return { ok: false, error: rem.error, message: rem.message, list: loadAccounts() };
            }
        } catch {}
    }

    try {
        mutateAccounts((fresh) => fresh.filter((a) => a.id !== id));
    } catch (err) {
        return { ok: false, error: "save_failed", message: String(err?.message || err), list: loadAccounts() };
    }
    _runtimeByAccount.delete(id);

    if (purgeData && id.startsWith("acc_")) {
        try {
            const { session } = require("electron");
            const ses = session?.fromPartition?.(`persist:agy_${id}`);
            if (ses) {
                if (typeof ses.clearStorageData === "function") {
                    await Promise.resolve(ses.clearStorageData()).catch(() => {});
                }
                if (typeof ses.clearCache === "function") {
                    await Promise.resolve(ses.clearCache()).catch(() => {});
                }
            }
        } catch {}
        const userDataDir = path.join(getAppDataRoot(), "Antigravity-Profiles", id);
        const legacyGeminiDir = path.join(os.homedir(), ".gemini-profiles", id);
        let partDir = "";
        try {
            const baseUserData = electronApp?.getPath?.("userData");
            if (baseUserData) partDir = path.join(baseUserData, "Partitions", `agy_${id}`);
        } catch {}
        for (const dir of [userDataDir, legacyGeminiDir, partDir].filter(Boolean)) {
            try {
                await fs.promises.rm(dir, { recursive: true, force: true });
            } catch {}
        }
    }
    emitAccountsChanged("delete");
    return { ok: true, list: loadAccounts() };
}

async function switchAccount(targetProfileId, activeProfileId, openInNewWindow = false) {
    const target = normalizeRequestedId(targetProfileId);
    if (!target) return { ok: false, error: "invalid_account_id" };

    const existing = loadRawAccounts().find((a) => a.id === target);
    if (!existing) return { ok: false, error: "not_found", target };

    const touchLastUsed = () => {
        try {
            mutateAccounts((fresh) => {
                const it = fresh.find((a) => a.id === target);
                if (it) it.lastUsedAt = Date.now();
            });
        } catch {}
    };

    if (openInNewWindow) {
        try {
            spawnProfileWindow(target);
        } catch {
            return { ok: false, error: "window_start_failed", target };
        }
        touchLastUsed();
        emitAccountsChanged("switch");
        return { ok: true, target, mode: "window", list: loadAccounts() };
    }

    // Prefer seamless BaseWindow + WebContentsView tab switching
    const tm = getTabManager();
    if (tm && typeof tm.hasMainWindow === "function" && tm.hasMainWindow()) {
        touchLastUsed();
        const res = await tm.openOrActivateAccount(target);
        return { ...res, target, mode: "tab", list: loadAccounts() };
    }

    const active = normalizeRequestedId(activeProfileId || getActiveProfileId()) || "default";
    if (target === active) return { ok: true, same: true, target };

    const lsMod = getLsMod();
    if (lsMod && typeof lsMod.switchActiveProfileInPlace === "function") {
        try {
            const sw = await lsMod.switchActiveProfileInPlace(target);
            touchLastUsed();
            emitAccountsChanged("switch");
            return { ok: true, target, mode: "in-place", reused: !!sw?.reused, list: loadAccounts() };
        } catch (err) {
            return { ok: false, error: "switch_failed", message: String(err?.message || err), target };
        }
    }

    try {
        spawnProfileWindow(target);
    } catch {
        return { ok: false, error: "window_start_failed", target };
    }
    touchLastUsed();
    return { ok: true, target, mode: "window", list: loadAccounts() };
}

async function grantFolderAccessForAccount(profileId, folderPath) {
    const acc = getAccountById(profileId);
    if (!acc) return { ok: false, error: "not_found" };
    if (acc.id === "default" || !acc.winUser || !winIsolation) {
        return { ok: true, skipped: true };
    }
    return winIsolation.grantWorkspaceAccess(acc.winUser, folderPath);
}

module.exports = {
    getActiveProfileId,
    loadAccounts,
    getAccountById,
    getAccountsSnapshot,
    saveAccounts,
    mutateAccounts,
    syncCurrentAccount,
    updateRuntimeState,
    getRuntimeState,
    onAccountsChanged,
    emitAccountsChanged,
    addAccount,
    repairAccountIsolation,
    renameAccount,
    stopAccountServer,
    deleteAccount,
    switchAccount,
    grantFolderAccessForAccount,
    classifyTierType,
    cleanModelLabel,
    classifyFamily,
    normalizeQuotasForTier,
    sanitizeQuotaList,
    sanitizeTier,
    sanitizeAvatarUrl,
    serializeAccount,
};
