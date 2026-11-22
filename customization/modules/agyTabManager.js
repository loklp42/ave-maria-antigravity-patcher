"use strict";
const path = require("path");
const electron = require("electron");
const { BaseWindow, WebContentsView, View, app, session } = electron;

const constants = require("./constants");
const windowState = require("./windowState");
const utils = require("./utils");
const languageServer = require("./languageServer");
const authBootstrap = require("./authBootstrap");
const customScheme = require("./customScheme");
const externalUrl = require("./externalUrl");
const debugConsole = require("./debugConsole");
const keybindings = require("./keybindings");
const previewViewers = require("./computer/previewViewers");
const wsl = require("./wsl");
const agyAccounts = require("./agyAccounts");
const mainActuator = require("./actuator/mainClient");

const DEFAULT_TAB_BAR_HEIGHT = 40;
const MIN_TAB_BAR_HEIGHT = 34;
const MAX_TAB_BAR_HEIGHT = 56;

let _mainWin = null;
let _storageManager = null;
let _tabBarView = null;
let _pickerView = null;
let _curtainView = null;
let _tabBarHeight = DEFAULT_TAB_BAR_HEIGHT;
let _tabBarVisible = true;
try {
    const _wpInit = getWallpaperEngine();
    const _initCfg = typeof _wpInit.readAppearanceConfig === "function" ? _wpInit.readAppearanceConfig() : {};
    if (typeof _initCfg.showTopTabBar === "boolean") _tabBarVisible = _initCfg.showTopTabBar;
} catch {}
let _viewMode = "picker"; // "picker" | "tab"
let _activeAccountId = "";
let _tabOrder = [];
let _onActiveLsChanged = null;
let _lastOverlaySymbolColor = "#f1f5f9";
let _isQuitting = false;
let _detachResizeListeners = null;

// Map<accountId, TabEntry>
const _tabs = new Map();
// WeakMap<WebContents, accountId> and Map<webContentsId, accountId>
const _accountIdByWc = new WeakMap();
const _accountIdByWcId = new Map();
// Map<accountId, Promise> to serialize tab creation per account
const _openingPromises = new Map();

function safeCloseView(view, hostContentView) {
    if (!view) return;
    if (hostContentView) {
        try {
            hostContentView.removeChildView?.(view);
        } catch {}
    }
    try {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed?.()) {
            wc.close?.();
        }
    } catch {}
}

function teardownAllViews(opts = {}) {
    const isQuit = Boolean(opts.isQuit);
    if (isQuit) _isQuitting = true;

    const detach = _detachResizeListeners;
    _detachResizeListeners = null;
    if (typeof detach === "function") {
        try { detach(); } catch {}
    }

    const win = _mainWin;
    let hostContentView = null;
    if (win && !win.isDestroyed?.()) {
        try { hostContentView = win.contentView || null; } catch {}
    }

    const tabsSnapshot = [..._tabs.entries()];
    const shellViews = [_tabBarView, _pickerView, _curtainView];

    _tabs.clear();
    _tabOrder = [];
    _activeAccountId = "";
    _viewMode = "picker";
    _tabBarView = null;
    _pickerView = null;
    _curtainView = null;
    if (!opts.keepMainWinRef) {
        _mainWin = null;
    }

    for (const [accId, tab] of tabsSnapshot) {
        if (!tab) continue;
        tab.destroyed = true;
        try {
            agyAccounts.updateRuntimeState(accId, { tabOpen: false }, false);
        } catch {}
        if (typeof tab.wcId === "number") {
            _accountIdByWcId.delete(tab.wcId);
        }
        safeCloseView(tab.view, hostContentView);
    }

    for (const v of shellViews) {
        safeCloseView(v, hostContentView);
    }

    if (!isQuit && !_isQuitting) {
        try { agyAccounts.emitAccountsChanged("window-closed"); } catch {}
    }
}

function closeAllViewsForQuit() {
    teardownAllViews({ isQuit: true, keepMainWinRef: true });
}

function getWallpaperEngine() {
    return require("./wallpaperEngine");
}

function hasMainWindow() {
    return Boolean(_mainWin && !_mainWin.isDestroyed?.());
}

function getMainWindow() {
    return hasMainWindow() ? _mainWin : null;
}

function getViewMode() {
    return _viewMode;
}

function getActiveAccountId() {
    return _activeAccountId;
}

function getOpenAccountIds() {
    return _tabOrder.filter((id) => {
        const t = _tabs.get(id);
        return Boolean(t && !t.destroyed && t.view && !t.view.webContents?.isDestroyed?.());
    });
}

function getTabBarHeight() {
    return hasMainWindow() ? _tabBarHeight : 0;
}

function getAccountIdForWebContents(wc) {
    if (!wc || typeof wc !== "object") return "";
    const direct = _accountIdByWc.get(wc);
    if (direct) return direct;
    if (typeof wc.id === "number") {
        const byId = _accountIdByWcId.get(wc.id);
        if (byId) return byId;
    }
    if (wc.hostWebContents && wc.hostWebContents !== wc) {
        return getAccountIdForWebContents(wc.hostWebContents);
    }
    return "";
}

function getTabWebContents(accountId) {
    const tab = _tabs.get(accountId);
    if (!tab || tab.destroyed || !tab.view?.webContents || tab.view.webContents.isDestroyed?.()) {
        return null;
    }
    return tab.view.webContents;
}

function setActiveLsChangedCallback(cb) {
    _onActiveLsChanged = typeof cb === "function" ? cb : null;
}

function getContentBounds() {
    const effDefault = _tabBarVisible ? _tabBarHeight : 0;
    if (!hasMainWindow()) return { width: 1280, height: 800, barH: effDefault, bodyH: 800 - effDefault };
    const [w, h] = _mainWin.getContentSize();
    const width = Math.max(0, Math.round(w || 0));
    const height = Math.max(0, Math.round(h || 0));
    const barH = _tabBarVisible ? Math.min(height, Math.max(MIN_TAB_BAR_HEIGHT, _tabBarHeight)) : 0;
    const bodyH = Math.max(0, height - barH);
    return { width, height, barH, bodyH };
}

function syncAllViewBounds() {
    if (!hasMainWindow()) return;
    let bounds;
    try {
        bounds = getContentBounds();
    } catch {
        return;
    }
    const { width, height, barH, bodyH } = bounds;
    if (width === 0 || height === 0) return;

    if (_tabBarView && !_tabBarView.webContents?.isDestroyed?.()) {
        try {
            _tabBarView.setVisible?.(_tabBarVisible);
            _tabBarView.setBounds(_tabBarVisible ? { x: 0, y: 0, width, height: barH } : { x: 0, y: 0, width: 0, height: 0 });
        } catch {}
    }
    if (_curtainView && !_curtainView.webContents?.isDestroyed?.()) {
        try { _curtainView.setBounds({ x: 0, y: barH, width, height: bodyH }); } catch {}
    }
    if (_pickerView && !_pickerView.webContents?.isDestroyed?.()) {
        try { _pickerView.setBounds({ x: 0, y: barH, width, height: bodyH }); } catch {}
    }
    for (const tab of _tabs.values()) {
        if (!tab.destroyed && tab.view && !tab.view.webContents?.isDestroyed?.()) {
            try { tab.view.setBounds({ x: 0, y: barH, width, height: bodyH }); } catch {}
        }
    }
    if (_tabBarVisible) {
        ensureTabBarOnTop();
    }
}

function ensureTabBarOnTop() {
    if (!hasMainWindow() || !_tabBarView || !_tabBarVisible) return;
    try {
        const cv = _mainWin.contentView;
        const children = cv?.children || [];
        if (children[children.length - 1] !== _tabBarView) {
            if (children.includes(_tabBarView)) {
                cv.removeChildView(_tabBarView);
            }
            cv.addChildView(_tabBarView);
        }
    } catch {}
}

function updateTitleBarOverlay(symbolColor) {
    if (!hasMainWindow() || utils.isMacOS()) return;
    if (symbolColor) _lastOverlaySymbolColor = symbolColor;
    try {
        _mainWin.setTitleBarOverlay({
            color: "#00000000",
            symbolColor: _lastOverlaySymbolColor || "#f1f5f9",
            height: _tabBarVisible ? _tabBarHeight : 32,
        });
    } catch {}
}

function setTabBarHeight(requestedPx) {
    const n = Number(requestedPx);
    if (!Number.isFinite(n)) return _tabBarHeight;
    const clamped = Math.round(Math.max(MIN_TAB_BAR_HEIGHT, Math.min(MAX_TAB_BAR_HEIGHT, n)));
    if (clamped === _tabBarHeight) return _tabBarHeight;
    _tabBarHeight = clamped;
    if (hasMainWindow()) {
        utils.setTabBarHeightForWindow?.(_mainWin, _tabBarVisible ? _tabBarHeight : 0);
        updateTitleBarOverlay();
        syncAllViewBounds();
    }
    return _tabBarHeight;
}

function setTabBarVisible(visible) {
    const next = visible !== false;
    if (next === _tabBarVisible) return _tabBarVisible;
    _tabBarVisible = next;
    if (hasMainWindow()) {
        utils.setTabBarHeightForWindow?.(_mainWin, _tabBarVisible ? _tabBarHeight : 0);
        updateTitleBarOverlay();
        syncAllViewBounds();
    }
    return _tabBarVisible;
}

function updateWindowTitle() {
    if (!hasMainWindow()) return;
    const wslBadge = wsl.getActiveWslDistro?.() ? ` (WSL: ${wsl.getActiveWslDistro()})` : "";
    const baseName = app.getName();
    if (_viewMode === "picker" || !_activeAccountId) {
        _mainWin.setTitle(`${baseName}${wslBadge}`);
        return;
    }
    const acc = agyAccounts.getAccountById(_activeAccountId);
    const label = acc?.customLabel || acc?.displayName || acc?.email || (_activeAccountId === "default" ? "Primary" : _activeAccountId);
    _mainWin.setTitle(`${baseName} — ${label}${wslBadge}`);
}

function notifyTabVisibility(wc, visible) {
    if (!wc || wc.isDestroyed?.()) return;
    try {
        wc.executeJavaScript(
            `try{window.dispatchEvent(new CustomEvent("agy-tab-visibility",{detail:{visible:${Boolean(visible)}}}));}catch{}`,
            true
        ).catch(() => {});
    } catch {}
}

function hideBrowserViewsNotOwnedBy(activeWcId) {
    try {
        const { wcvBrowserRegistry } = require("./wcvBrowserRegistry");
        if (!wcvBrowserRegistry || !wcvBrowserRegistry.entries) return;
        for (const entry of wcvBrowserRegistry.entries.values()) {
            if (!entry || entry.parentWindow !== _mainWin || !entry.view) continue;
            const owned = activeWcId !== null && entry.hubSender?.id === activeWcId;
            if (!owned && entry.visible) {
                entry._agyHiddenByTabSwitch = true;
                entry.view.setVisible?.(false);
            } else if (owned && entry._agyHiddenByTabSwitch) {
                entry._agyHiddenByTabSwitch = false;
                if (entry.visible) entry.view.setVisible?.(true);
            }
        }
    } catch {}
}

function getShellServerBaseUrl() {
    const wp = getWallpaperEngine();
    const port = wp.getLocalServerPort?.() || 0;
    return port > 0 ? `http://127.0.0.1:${port}` : "";
}

async function waitForWallpaperServerPort(maxWaitMs = 5000) {
    const wp = getWallpaperEngine();
    wp.ensureLocalServer?.();
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const port = wp.getLocalServerPort?.() || 0;
        if (port > 0) return port;
        await new Promise((r) => setTimeout(r, 10));
    }
    return wp.getLocalServerPort?.() || 0;
}

function configureAccountSession(accountId) {
    const isDefault = accountId === "default";
    const ses = isDefault ? session.defaultSession : session.fromPartition(`persist:agy_${accountId}`);
    languageServer.setupLocalCertTrustForSession(ses);
    customScheme.registerCustomSchemeHandlersForSession(ses);
    try {
        getWallpaperEngine().attachWallpaperCspToSession?.(ses);
    } catch {}
    return ses;
}

async function createMainTabWindow(storageManager, options = {}) {
    if (hasMainWindow()) {
        if (_mainWin.isMinimized()) _mainWin.restore();
        _mainWin.show();
        _mainWin.focus();
        return _mainWin;
    }

    _isQuitting = false;
    _storageManager = storageManager || _storageManager;
    const wpPort = await waitForWallpaperServerPort();
    const shellBase = `http://127.0.0.1:${wpPort}`;

    const initialWindowState = windowState.resolveInitialWindowState({
        state: options?.initialState,
    });
    const curtainColor = utils.getHubCurtainColor();
    const wslBadge = wsl.getActiveWslDistro?.() ? ` (WSL: ${wsl.getActiveWslDistro()})` : "";

    const baseWin = new BaseWindow({
        ...(initialWindowState.x !== undefined && initialWindowState.y !== undefined
            ? { x: initialWindowState.x, y: initialWindowState.y }
            : {}),
        width: initialWindowState.width,
        height: initialWindowState.height,
        ...(initialWindowState.isFullScreen ? { fullscreen: true } : {}),
        minWidth: windowState.MIN_WINDOW_WIDTH,
        minHeight: windowState.MIN_WINDOW_HEIGHT,
        title: app.getName() + wslBadge,
        icon: path.join(__dirname, "..", "icon.png"),
        titleBarStyle: "hidden",
        titleBarOverlay: utils.isMacOS()
            ? false
            : {
                color: "#00000000",
                symbolColor: "#f1f5f9",
                height: _tabBarVisible ? _tabBarHeight : 32,
            },
        backgroundColor: curtainColor,
        trafficLightPosition: { x: 12, y: 12 },
    });

    _mainWin = baseWin;

    // Background curtain below tabBar
    _curtainView = new WebContentsView({
        webPreferences: { sandbox: true, javascript: false },
    });
    _curtainView.setBackgroundColor(curtainColor);
    void Promise.resolve(_curtainView.webContents.loadURL(utils.buildHubCurtainDataUrl(curtainColor))).catch(() => {});

    // Account Picker WebContentsView
    _pickerView = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: debugConsole.isDebugConsoleEnabled(),
            transparent: false,
            partition: "agy_shell",
        },
    });
    _pickerView.setBackgroundColor(curtainColor);
    _pickerView.webContents.setWindowOpenHandler((details) => {
        void externalUrl.openExternalSafely(details.url, "unconfirmed");
        return { action: "deny" };
    });

    // Top Tab Bar WebContentsView
    _tabBarView = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: debugConsole.isDebugConsoleEnabled(),
            transparent: false,
            partition: "agy_shell",
        },
    });
    _tabBarView.setBackgroundColor(curtainColor);
    _tabBarView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    baseWin.contentView.addChildView(_curtainView);
    baseWin.contentView.addChildView(_pickerView);
    baseWin.contentView.addChildView(_tabBarView);

    // Expose webContents getter & loadURL on BaseWindow for legacy helpers
    Object.defineProperty(baseWin, "webContents", {
        get: () => {
            if (_viewMode === "tab" && _activeAccountId) {
                const wc = getTabWebContents(_activeAccountId);
                if (wc) return wc;
            }
            const pickerWc = _pickerView?.webContents;
            return pickerWc && !pickerWc.isDestroyed?.() ? pickerWc : undefined;
        },
        configurable: true,
    });
    baseWin.loadURL = (targetUrl, loadOpts) => {
        const wc = baseWin.webContents;
        return wc && !wc.isDestroyed?.() ? wc.loadURL(targetUrl, loadOpts) : Promise.resolve();
    };

    utils.registerTabHostWindow(baseWin, {
        initialView: _pickerView,
        curtainView: _curtainView,
        curtainColor,
        tabBarHeight: _tabBarVisible ? _tabBarHeight : 0,
    });
    utils.registerWindowWebContents(baseWin, _pickerView.webContents);
    utils.registerWindowWebContents(baseWin, _tabBarView.webContents);

    syncAllViewBounds();

    const onResize = () => syncAllViewBounds();
    const hostContentView = baseWin.contentView;
    baseWin.on("resize", onResize);
    hostContentView?.on?.("bounds-changed", onResize);
    _detachResizeListeners = () => {
        try {
            if (!baseWin.isDestroyed?.()) {
                baseWin.off?.("resize", onResize);
                hostContentView?.off?.("bounds-changed", onResize);
            }
        } catch {}
    };

    if (initialWindowState.isFullScreen) {
        if (!baseWin.isFullScreen?.()) baseWin.setFullScreen?.(true);
        syncAllViewBounds();
    } else if (initialWindowState.isMaximized) {
        baseWin.maximize?.();
        syncAllViewBounds();
    }

    if (options?.persistBounds !== false) {
        windowState.trackWindowState(baseWin, initialWindowState);
    }

    keybindings.registerKeybindings(baseWin, {
        createNewWindow: () => {
            showPicker();
        },
        onQuitRequested: () => {
            utils.setShowQuitConfirmation(true);
            app.quit();
        },
    });

    baseWin.on("closed", () => {
        teardownAllViews({ isQuit: _isQuitting, keepMainWinRef: false });
    });

    void _tabBarView.webContents.loadURL(`${shellBase}/shell/tabbar`).catch(() => {});
    void _pickerView.webContents.loadURL(`${shellBase}/shell/picker`).catch(() => {});

    _viewMode = "picker";
    _activeAccountId = "";
    updateWindowTitle();
    agyAccounts.emitAccountsChanged("window-ready");
    return baseWin;
}

function showPicker() {
    if (!hasMainWindow()) return false;
    // Hide currently active account tab & pause its wallpaper video
    if (_viewMode === "tab" && _activeAccountId) {
        const prev = _tabs.get(_activeAccountId);
        if (prev && !prev.destroyed && prev.view) {
            prev.view.setVisible(false);
            notifyTabVisibility(prev.view.webContents, false);
        }
    }
    hideBrowserViewsNotOwnedBy(null);
    _viewMode = "picker";
    if (_pickerView && !_pickerView.webContents?.isDestroyed?.()) {
        _pickerView.setVisible(true);
        notifyTabVisibility(_pickerView.webContents, true);
        utils.setActiveHubViewForWindow(_mainWin, _pickerView, _tabBarVisible ? _tabBarHeight : 0);
        try { _pickerView.webContents.focus(); } catch {}
    }
    syncAllViewBounds();
    updateWindowTitle();
    agyAccounts.emitAccountsChanged("show-picker");
    return true;
}

function activateTabView(accountId) {
    const tab = _tabs.get(accountId);
    if (!hasMainWindow() || !tab || tab.destroyed || !tab.view || tab.view.webContents?.isDestroyed?.()) {
        return false;
    }

    // Hide picker & pause its live wallpaper video
    if (_pickerView && !_pickerView.webContents?.isDestroyed?.()) {
        _pickerView.setVisible(false);
        notifyTabVisibility(_pickerView.webContents, false);
    }

    // Hide all other account tabs & pause their wallpaper videos
    for (const [id, other] of _tabs.entries()) {
        if (id === accountId || other.destroyed || !other.view) continue;
        other.view.setVisible(false);
        notifyTabVisibility(other.view.webContents, false);
    }

    _viewMode = "tab";
    _activeAccountId = accountId;
    tab.activatedOnce = true;

    tab.view.setVisible(true);
    syncAllViewBounds();
    utils.setActiveHubViewForWindow(_mainWin, tab.view, _tabBarVisible ? _tabBarHeight : 0);
    hideBrowserViewsNotOwnedBy(tab.wcId ?? tab.view.webContents.id);
    notifyTabVisibility(tab.view.webContents, true);
    try { tab.view.webContents.focus(); } catch {}

    // Retarget active LS pointer, actuator, mendel sync
    languageServer.setActiveProfileServer(accountId);
    if (tab.lsPort > 0 && tab.lsCsrf) {
        try { mainActuator.startMainActuatorClient(tab.lsPort, tab.lsCsrf); } catch {}
        _onActiveLsChanged?.(accountId, tab.lsPort, tab.lsCsrf);
    }

    updateWindowTitle();
    agyAccounts.emitAccountsChanged("activate-tab");
    return true;
}

async function loadTabWithBootstrap(tab, targetUrl) {
    if (!tab || tab.destroyed || !tab.view?.webContents || tab.view.webContents.isDestroyed?.()) {
        return;
    }
    const token = await authBootstrap.mintBootstrapTokenForInstance(tab.lsPort, tab.lsCsrf);
    if (tab.destroyed || tab.view.webContents.isDestroyed?.()) return;
    const finalUrl = authBootstrap.withBootstrapTokenFragment(targetUrl, token);
    console.log(`[TabManager] Loading [${tab.accountId}]: ${authBootstrap.redactUrlTokens(finalUrl)}`);
    try {
        await tab.view.webContents.loadURL(finalUrl);
    } catch (err) {
        if (err?.code === "ERR_ABORTED" || err?.errno === -3 || tab.destroyed) return;
        console.warn(`[TabManager] loadURL failed for [${tab.accountId}]: ${err?.message || err}`);
    }
}

async function createAccountTabView(accountId, lsInfo) {
    const ses = configureAccountSession(accountId);
    const curtainColor = utils.getHubCurtainColor(_mainWin);
    const partition = accountId === "default" ? undefined : `persist:agy_${accountId}`;

    const view = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
            devTools: debugConsole.isDebugConsoleEnabled(),
            webviewTag: true,
            transparent: true,
            backgroundThrottling: false,
            ...(partition ? { partition } : {}),
        },
    });
    view.setBackgroundColor("#00000000");

    const wc = view.webContents;
    const wcId = typeof wc.id === "number" ? wc.id : null;
    const lsOrigin = `${constants.WINDOW_ORIGIN}:${lsInfo.port}`;

    const tab = {
        accountId,
        view,
        wcId,
        session: ses,
        lsPort: lsInfo.port,
        lsCsrf: lsInfo.csrf,
        lsOrigin,
        destroyed: false,
    };

    _accountIdByWc.set(wc, accountId);
    if (wcId !== null) {
        _accountIdByWcId.set(wcId, accountId);
    }
    utils.registerWindowWebContents(_mainWin, wc);
    utils.registerAccountTabWebContents(_mainWin, wc);

    // Navigation guard: keep same-origin on this tab's LS port, send external links (like Google OAuth!) to OS browser
    const guardNav = (event) => {
        if (!event.isMainFrame || tab.destroyed || wc.isDestroyed?.()) return;
        const currentUrl = wc.getURL();
        if (externalUrl.isSameOrigin(event.url, tab.lsOrigin) || (currentUrl && externalUrl.isSameOrigin(event.url, currentUrl))) {
            return;
        }
        event.preventDefault();
        void externalUrl.openExternalSafely(event.url, "unconfirmed");
    };
    wc.setWindowOpenHandler((details) => {
        void externalUrl.openExternalSafely(details.url, "unconfirmed");
        return { action: "deny" };
    });
    wc.on("will-navigate", guardNav);
    wc.on("will-redirect", guardNav);

    // Inject wallpaperEngine + agyExtras bound explicitly to this tab's accountId (deduplicated per navigation)
    let lastInjectedUrl = "";
    wc.on("did-start-navigation", (e) => {
        if (e && e.isMainFrame) lastInjectedUrl = "";
    });
    const handleInject = () => {
        if (tab.destroyed || !hasMainWindow() || wc.isDestroyed?.()) return;
        const curUrl = wc.getURL() || "";
        if (curUrl && curUrl === lastInjectedUrl) return;
        lastInjectedUrl = curUrl;
        getWallpaperEngine().injectWallpaperUi(wc, accountId);
        // Allow pre-warming tab to buffer its initial wallpaper frame; only pause other background tabs
        const isVis = (_viewMode === "tab" && _activeAccountId === accountId) || !tab.activatedOnce;
        notifyTabVisibility(wc, isVis);
        if (_viewMode === "tab" && _activeAccountId === accountId) {
            try { wc.focus(); } catch {}
        }
    };
    wc.on("dom-ready", handleInject);
    wc.on("did-finish-load", handleInject);

    // Restore & sync shared zoom level
    if (_storageManager) {
        const ZOOM_KEY = "zoomLevel";
        let restoring = false;
        wc.on("did-finish-load", async () => {
            if (tab.destroyed || wc.isDestroyed?.()) return;
            try {
                const items = await _storageManager.getItems();
                const stored = parseFloat(items[ZOOM_KEY]);
                if (!Number.isNaN(stored) && !tab.destroyed && !wc.isDestroyed?.()) {
                    restoring = true;
                    wc.setZoomLevel(stored);
                    restoring = false;
                }
            } catch {}
        });
        wc.on("zoom-changed", () => {
            if (restoring || tab.destroyed || wc.isDestroyed?.()) return;
            void _storageManager.updateItems({ [ZOOM_KEY]: String(wc.getZoomLevel()) });
        });
    }

    wc.once("destroyed", () => {
        tab.destroyed = true;
        if (wcId !== null) _accountIdByWcId.delete(wcId);
    });

    previewViewers.registerPreviewViewer(wc);

    if (!hasMainWindow()) {
        tab.destroyed = true;
        safeCloseView(view, null);
        return null;
    }

    // Mount below tabBarView; keep Picker visible only until dom-ready so there is zero blank flash
    view.setVisible(false);
    _mainWin.contentView.addChildView(view);
    ensureTabBarOnTop();

    _tabs.set(accountId, tab);
    if (!_tabOrder.includes(accountId)) {
        _tabOrder.push(accountId);
    }

    agyAccounts.updateRuntimeState(accountId, { tabOpen: true, status: "ready", lastError: "" });
    let activated = false;
    const activateNow = () => {
        if (activated || tab.destroyed || !hasMainWindow()) return;
        activated = true;
        activateTabView(accountId);
    };
    wc.once("dom-ready", activateNow);
    const fallbackTimer = setTimeout(activateNow, 1500);
    await loadTabWithBootstrap(tab, `${tab.lsOrigin}/`);
    clearTimeout(fallbackTimer);
    activateNow();
    return tab;
}

async function openOrActivateAccount(accountId) {
    const id = String(accountId || "").trim().toLowerCase() || "default";
    if (!hasMainWindow()) {
        await createMainTabWindow(_storageManager);
    }

    const existing = _tabs.get(id);
    if (existing && !existing.destroyed && existing.view && !existing.view.webContents?.isDestroyed?.()) {
        activateTabView(id);
        return { ok: true, reused: true, accountId: id };
    }

    if (_openingPromises.has(id)) {
        return _openingPromises.get(id);
    }

    const openPromise = (async () => {
        let acc = agyAccounts.getAccountById(id);
        if (!acc) {
            return { ok: false, error: "not_found", message: "Account not found" };
        }

        // If secondary account on Windows lacks isolated user provisioning, run one-time provisioning first
        if (id !== "default" && process.platform === "win32" && !acc.isolationReady) {
            agyAccounts.updateRuntimeState(id, { status: "starting", lastError: "" });
            const rep = await agyAccounts.repairAccountIsolation(id);
            if (!rep.ok) {
                agyAccounts.updateRuntimeState(id, { status: "error", lastError: rep.message || rep.error || "Provision failed" });
                return { ok: false, error: rep.error || "winuser_provision_failed", message: rep.message || "Windows isolation setup failed" };
            }
            acc = agyAccounts.getAccountById(id);
        }

        agyAccounts.updateRuntimeState(id, { status: "starting", lastError: "" });
        // Pre-configure session, local cert trust, and CSP before LS finishes booting
        try { configureAccountSession(id); } catch {}

        try {
            const lsInfo = await languageServer.ensureProfileServer(id, {
                winUser: acc?.winUser || "",
                geminiDir: acc?.geminiDir || "",
            });
            if (!hasMainWindow() || _isQuitting) {
                return { ok: false, error: "window_closed", message: "Window was closed" };
            }
            const created = await createAccountTabView(id, lsInfo);
            if (!created) {
                return { ok: false, error: "window_closed", message: "Window was closed" };
            }
            return { ok: true, reused: false, accountId: id, port: lsInfo.port };
        } catch (err) {
            const msg = String(err?.message || err);
            console.error(`[TabManager] Failed to open account [${id}]:`, msg);
            agyAccounts.updateRuntimeState(id, { tabOpen: false, status: "error", lastError: msg });
            return { ok: false, error: "profile_start_failed", message: msg };
        }
    })().finally(() => {
        _openingPromises.delete(id);
    });

    _openingPromises.set(id, openPromise);
    return openPromise;
}

async function closeAccountTab(accountId, opts = {}) {
    const id = String(accountId || "").trim().toLowerCase();
    let defaultStop = true;
    try {
        const _wpClose = getWallpaperEngine();
        const wpCfg = typeof _wpClose.readAppearanceConfig === "function"
            ? _wpClose.readAppearanceConfig()
            : {};
        if (typeof wpCfg.stopServerOnTabClose === "boolean") {
            defaultStop = wpCfg.stopServerOnTabClose;
        }
    } catch {}
    const stopServer = typeof opts.stopServer === "boolean" ? opts.stopServer : defaultStop;
    const tab = _tabs.get(id);

    if (tab) {
        tab.destroyed = true;
        _tabs.delete(id);
        _tabOrder = _tabOrder.filter((x) => x !== id);

        let hostCv = null;
        if (hasMainWindow()) {
            try { hostCv = _mainWin.contentView || null; } catch {}
        }
        if (typeof tab.wcId === "number") {
            _accountIdByWcId.delete(tab.wcId);
        }
        safeCloseView(tab.view, hostCv);
    }

    if (stopServer) {
        try {
            await languageServer.stopProfileServer(id, { allowActive: true });
        } catch {}
        agyAccounts.updateRuntimeState(id, {
            tabOpen: false,
            status: "stopped",
            activeAgentCount: 0,
            waitingForUser: false,
            isLiveQuota: false,
            lastError: "",
        });
    } else {
        agyAccounts.updateRuntimeState(id, { tabOpen: false });
    }

    if (_viewMode === "tab" && _activeAccountId === id) {
        const remaining = getOpenAccountIds();
        if (remaining.length > 0) {
            activateTabView(remaining[remaining.length - 1]);
        } else {
            _activeAccountId = "";
            showPicker();
        }
    } else {
        agyAccounts.emitAccountsChanged("close-tab");
    }

    return { ok: true, closed: id };
}

function handleInstancePortChanged(accountId, newPort, newCsrf) {
    const tab = _tabs.get(accountId);
    if (!tab || tab.destroyed || !tab.view?.webContents || tab.view.webContents.isDestroyed?.()) {
        return;
    }
    if (tab.lsPort === newPort && tab.lsCsrf === newCsrf) {
        return;
    }
    tab.lsPort = newPort;
    tab.lsCsrf = newCsrf;
    tab.lsOrigin = `${constants.WINDOW_ORIGIN}:${newPort}`;
    languageServer.setupLocalCertTrustForSession(tab.session);

    const currentUrl = tab.view.webContents.getURL();
    const targetUrl = authBootstrap.buildLsRestartWindowUrl(currentUrl, tab.lsOrigin) || `${tab.lsOrigin}/`;
    void loadTabWithBootstrap(tab, targetUrl);

    if (_viewMode === "tab" && _activeAccountId === accountId) {
        try { mainActuator.startMainActuatorClient(newPort, newCsrf); } catch {}
        _onActiveLsChanged?.(accountId, newPort, newCsrf);
    }
}

function handleInstanceExited(accountId) {
    const tab = _tabs.get(accountId);
    if (!tab || tab.destroyed) {
        agyAccounts.updateRuntimeState(accountId, {
            tabOpen: false,
            status: "stopped",
            activeAgentCount: 0,
            waitingForUser: false,
            isLiveQuota: false,
        });
        return;
    }
    agyAccounts.updateRuntimeState(accountId, {
        status: "starting",
        activeAgentCount: 0,
        waitingForUser: false,
    });
}

function focusAccountTabForNotification(senderWc, payload) {
    if (!hasMainWindow()) return false;
    if (_mainWin.isMinimized()) _mainWin.restore();
    _mainWin.show();
    _mainWin.focus();
    const accId = getAccountIdForWebContents(senderWc);
    if (accId && _tabs.has(accId)) {
        activateTabView(accId);
    }
    if (payload && senderWc && !senderWc.isDestroyed?.()) {
        try { senderWc.send("notification:clicked", payload); } catch {}
    }
    return true;
}

function getAllTabWebContents() {
    const out = [];
    for (const tab of _tabs.values()) {
        if (!tab.destroyed && tab.view?.webContents && !tab.view.webContents.isDestroyed?.()) {
            out.push(tab.view.webContents);
        }
    }
    return out;
}

function getTotalActiveAgentCount() {
    let total = 0;
    for (const acc of agyAccounts.loadAccounts()) {
        total += Number(acc.activeAgentCount || 0);
    }
    return total;
}

module.exports = {
    DEFAULT_TAB_BAR_HEIGHT,
    hasMainWindow,
    getMainWindow,
    getViewMode,
    getActiveAccountId,
    getOpenAccountIds,
    getTabBarHeight,
    setTabBarHeight,
    setTabBarVisible,
    updateTitleBarOverlay,
    getAccountIdForWebContents,
    getTabWebContents,
    getAllTabWebContents,
    getTotalActiveAgentCount,
    setActiveLsChangedCallback,
    createMainTabWindow,
    showPicker,
    openOrActivateAccount,
    activateTabView,
    closeAccountTab,
    closeAllViewsForQuit,
    handleInstancePortChanged,
    handleInstanceExited,
    focusAccountTabForNotification,
    syncAllViewBounds,
};
