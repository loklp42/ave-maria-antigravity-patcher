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

function sanitizeQuotaList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const label = String(item.label || item.modelId || "").trim().slice(0, 80);
        if (!label) continue;
        const modelId = String(item.modelId || label).trim().slice(0, 120);
        let remainingFraction = Number(item.remainingFraction);
        if (!Number.isFinite(remainingFraction)) remainingFraction = -1;
        else remainingFraction = Math.max(0, Math.min(1, remainingFraction));
        const resetTime = typeof item.resetTime === "string" ? item.resetTime.trim().slice(0, 64) : "";
        out.push({ modelId, label, remainingFraction, resetTime });
        if (out.length >= 24) break;
    }
    return out;
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

function serializeAccount(account) {
    const id = sanitizeId(account.id);
    const isDefault = id === "default";
    const isolationMode = isDefault
        ? "native"
        : (process.platform === "win32"
            ? (account.isolationMode === "winuser" || account.winUser ? "winuser" : "winuser")
            : "profile");
    const winUser = isDefault ? "" : (typeof account.winUser === "string" ? account.winUser.trim() : "");
    const geminiDir = isDefault
        ? ""
        : (typeof account.geminiDir === "string" && account.geminiDir.trim()
            ? account.geminiDir.trim()
            : (winUser && winIsolation ? winIsolation.getIsolatedGeminiDir(id) : ""));

    return {
        id,
        customLabel: typeof account.customLabel === "string" ? account.customLabel.trim().slice(0, 48) : "",
        displayName: typeof account.displayName === "string" ? account.displayName.trim().slice(0, 80) : "",
        email: typeof account.email === "string" ? account.email.trim().slice(0, 120) : "",
        avatar: typeof account.avatar === "string" ? account.avatar.trim() : "",
        isolationMode,
        winUser,
        geminiDir,
        tier: sanitizeTier(account.tier),
        quotas: sanitizeQuotaList(account.quotas),
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

    // Derive coherent live status if tab is running and not starting/error
    if (rt.tabOpen && rt.status !== "starting" && rt.status !== "error") {
        const derived = rt.waitingForUser
            ? "waiting"
            : (rt.activeAgentCount > 0 ? "working" : "ready");
        if (rt.status !== derived) {
            rt.status = derived;
            changed = true;
        }
    } else if (!rt.tabOpen && !getRunningProfileSet().has(id) && rt.status !== "starting") {
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

function loadRawAccounts() {
    const file = getAccountsFile();
    let list = [];
    try {
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            if (Array.isArray(parsed)) {
                list = parsed
                    .filter((a) => a && typeof a === "object" && a.id)
                    .map((a) => serializeAccount(a));
            }
        }
    } catch {}

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

function saveAccounts(list) {
    try {
        const file = getAccountsFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list.map(serializeAccount), null, 2), "utf8");
        return true;
    } catch {
        return false;
    }
}

function syncCurrentAccount(profileId, info) {
    const id = sanitizeId(profileId || getActiveProfileId());
    const list = loadRawAccounts();
    let item = list.find((a) => a.id === id);
    if (!item) {
        item = serializeAccount({ id, createdAt: Date.now(), lastUsedAt: Date.now() });
        list.push(item);
    }

    const displayName = String(info?.displayName || "").trim();
    const email = String(info?.email || "").trim();
    const avatar = String(info?.avatar || "").trim();
    const emailOwnedByOther = email && list.some((a) => a.id !== id && a.email && a.email.toLowerCase() === email.toLowerCase());
    let diskChanged = false;

    if (!emailOwnedByOther || !item.email) {
        if (displayName && item.displayName !== displayName) { item.displayName = displayName; diskChanged = true; }
        if (email && item.email !== email) { item.email = email; diskChanged = true; }
        if (avatar && item.avatar !== avatar) { item.avatar = avatar; diskChanged = true; }
    }

    const nextTier = sanitizeTier(info?.tier);
    if (nextTier && JSON.stringify(nextTier) !== JSON.stringify(item.tier)) {
        item.tier = nextTier;
        diskChanged = true;
    }

    const nextQuotas = sanitizeQuotaList(info?.quotas);
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
    if (diskChanged || !fs.existsSync(getAccountsFile())) {
        saveAccounts(list);
    }

    // Update live runtime fields (status / agent count / live quota flag)
    const runtimePatch = {};
    if (nextQuotas.length > 0 || nextTier) runtimePatch.isLiveQuota = true;
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
    return decorateAccounts(list);
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

    list.push(newItem);
    saveAccounts(list);
    emitAccountsChanged("add");

    if (openInNewWindow) {
        try {
            spawnProfileWindow(id);
            return { ok: true, id, target: id, mode: "window", list: loadAccounts() };
        } catch (err) {
            const rolled = list.filter((a) => a.id !== id);
            saveAccounts(rolled);
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
            const rolled = loadRawAccounts().filter((a) => a.id !== id);
            saveAccounts(rolled);
            if (winUser && winIsolation) {
                try { await winIsolation.removeIsolatedAccount(id, winUser); } catch {}
            } else {
                try { if (fs.existsSync(geminiDir)) fs.rmSync(geminiDir, { recursive: true, force: true }); } catch {}
            }
            return { ok: false, error: "profile_start_failed", message: String(err?.message || err), list: decorateAccounts(rolled) };
        }
    }

    try {
        spawnProfileWindow(id);
        return { ok: true, id, target: id, mode: "window", list: loadAccounts() };
    } catch (err) {
        const rolled = list.filter((a) => a.id !== id);
        saveAccounts(rolled);
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
    const list = loadRawAccounts();
    const item = list.find((a) => a.id === id);
    if (!item) return { ok: false, error: "not_found", list: decorateAccounts(list) };

    const prov = await winIsolation.provisionIsolatedAccount(id, item.winUser || "");
    if (!prov.ok) {
        return { ok: false, error: prov.error, message: prov.message, list: decorateAccounts(list) };
    }
    item.winUser = prov.winUser;
    item.geminiDir = prov.geminiDir;
    item.isolationMode = "winuser";
    saveAccounts(list);
    emitAccountsChanged("repair");
    return { ok: true, id, winUser: prov.winUser, list: loadAccounts() };
}

function renameAccount(profileId, newLabel) {
    const id = sanitizeId(profileId);
    const list = loadRawAccounts();
    const item = list.find((a) => a.id === id);
    if (!item) return { ok: false, error: "not_found", list: decorateAccounts(list) };
    item.customLabel = String(newLabel || "").trim().slice(0, 48);
    saveAccounts(list);
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
            if (!rem.ok && rem.error === "uac_cancelled") {
                return { ok: false, error: "uac_cancelled", message: rem.message, list: loadAccounts() };
            }
        } catch {}
    }

    const next = list.filter((a) => a.id !== id);
    saveAccounts(next);
    _runtimeByAccount.delete(id);

    if (purgeData && id.startsWith("acc_")) {
        const userDataDir = path.join(getAppDataRoot(), "Antigravity-Profiles", id);
        const legacyGeminiDir = path.join(os.homedir(), ".gemini-profiles", id);
        for (const dir of [userDataDir, legacyGeminiDir]) {
            try {
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            } catch {}
        }
    }
    emitAccountsChanged("delete");
    return { ok: true, list: loadAccounts() };
}

async function switchAccount(targetProfileId, activeProfileId, openInNewWindow = false) {
    const target = normalizeRequestedId(targetProfileId);
    if (!target) return { ok: false, error: "invalid_account_id" };

    const list = loadRawAccounts();
    const item = list.find((a) => a.id === target);
    if (!item) return { ok: false, error: "not_found", target };

    if (openInNewWindow) {
        try {
            spawnProfileWindow(target);
        } catch {
            return { ok: false, error: "window_start_failed", target };
        }
        item.lastUsedAt = Date.now();
        saveAccounts(list);
        emitAccountsChanged("switch");
        return { ok: true, target, mode: "window", list: loadAccounts() };
    }

    // Prefer seamless BaseWindow + WebContentsView tab switching
    const tm = getTabManager();
    if (tm && typeof tm.hasMainWindow === "function" && tm.hasMainWindow()) {
        item.lastUsedAt = Date.now();
        saveAccounts(list);
        const res = await tm.openOrActivateAccount(target);
        return { ...res, target, mode: "tab", list: loadAccounts() };
    }

    const active = normalizeRequestedId(activeProfileId || getActiveProfileId()) || "default";
    if (target === active) return { ok: true, same: true, target };

    const lsMod = getLsMod();
    if (lsMod && typeof lsMod.switchActiveProfileInPlace === "function") {
        try {
            const sw = await lsMod.switchActiveProfileInPlace(target);
            item.lastUsedAt = Date.now();
            saveAccounts(list);
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
    item.lastUsedAt = Date.now();
    saveAccounts(list);
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
};
