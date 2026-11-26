"use strict";
const { serializeContrastHelpers } = require("./agyUiContrast");
const {
    classifyTierType,
    cleanModelLabel,
    classifyFamily,
    normalizeQuotasForTier,
} = require("./agyAccounts");

function buildQuotaHelpersSnippet() {
    return [
        classifyTierType,
        cleanModelLabel,
        classifyFamily,
        normalizeQuotasForTier,
    ].map((fn) => fn.toString()).join("\n");
}

function buildContrastHelpersSnippet() {
    return serializeContrastHelpers();
}

function buildSharedThemeScript(baseUrl, token = "") {
    return `
    const BASE_URL = ${JSON.stringify(baseUrl)};
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
    ${buildContrastHelpersSnippet()}
    ${buildQuotaHelpersSnippet()}

    const FONT_MAP = {
        system: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
        inter: "'Inter', 'Segoe UI Variable', system-ui, sans-serif",
        jetbrains: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        cascadia: "'Cascadia Code', Consolas, monospace",
        georgia: "Georgia, 'Times New Roman', serif",
        segoe: "'Segoe UI', Tahoma, sans-serif",
    };

    const themeState = {
        lang: "ru",
        themeMode: "dark",
        uiContrast: "default",
        useCustomBg: false,
        customBgHex: "#0c0e14",
        useCustomText: false,
        customTextHex: "#f8fafc",
        darkUseCustomBg: false,
        darkCustomBgHex: "#0c0e14",
        darkUseCustomText: false,
        darkCustomTextHex: "#f8fafc",
        darkCustomAccentHex: "#60a5fa",
        lightUseCustomBg: false,
        lightCustomBgHex: "#fafbfe",
        lightUseCustomText: false,
        lightCustomTextHex: "#111827",
        lightCustomAccentHex: "#2563eb",
        accentRgb: "96, 165, 250",
        tintRgb: "12, 14, 20",
        customAccentHex: "#60a5fa",
        adaptiveAccent: true,
        autoContrast: true,
        lumaBoost: 0,
        panelAlpha: 0.68,
        panelBlurPx: 20,
        dim: 0.36,
        videoBlur: 0,
        videoSat: 1.0,
        videoContrast: 1.0,
        videoFit: "cover",
        playbackRate: 1.0,
        fontSizePx: 14,
        radiusPx: 10,
        uiFontChoice: "system",
        reduceBackdropBlur: true,
        reduceMotion: false,
        privacyMode: false,
        privacyRevealMode: "modifier",
        privacyHideStyle: "blur",
        privacyHidePaths: true,
        currentId: "",
        currentIndex: 0,
        mediaFilter: "all",
        hideMature: false,
        hideLowRes: false,
        staticWallpaperMode: false,
        wallpaperEnabled: true,
        hiddenIds: [],
    };

    const EMAIL_MASK_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
    const WIN_PATH_MASK_RE = /([A-Za-z]:[/\\\\]+Users[/\\\\]+)([^\\\\/\\s,;:"'<>|]+)/gi;
    const UNIX_PATH_MASK_RE = /(\\/(?:home|Users)\\/)([^/\\s,;:"'<>|]+)/g;

    function maskSensitiveString(str, maskPaths = themeState.privacyHidePaths) {
        let out = String(str || "").replace(EMAIL_MASK_RE, "••••@••••");
        if (maskPaths) {
            out = out
                .replace(WIN_PATH_MASK_RE, "$1••••")
                .replace(UNIX_PATH_MASK_RE, "$1••••");
        }
        return out;
    }

    function formatPrivacyValue(raw, isEmailField = false) {
        const str = String(raw || "");
        if (!themeState.privacyMode) return str;
        if (themeState.privacyHideStyle !== "mask") return str;
        let out = maskSensitiveString(str, themeState.privacyHidePaths);
        if (isEmailField && out === str && str.includes("@")) {
            out = "••••@••••";
        }
        return out;
    }

    function getSafePrivacyTip(raw) {
        const str = String(raw || "");
        if (!themeState.privacyMode) return str;
        return maskSensitiveString(str, themeState.privacyHidePaths);
    }

    function syncModHeld(held) {
        const root = document.documentElement;
        if (!root || !root.dataset) return;
        const active = Boolean(held && themeState.privacyMode && themeState.privacyRevealMode === "modifier");
        root.dataset.agyModHeld = active ? "1" : "0";
    }
    if (typeof window.addEventListener === "function") {
        const onKeyMod = (e) => syncModHeld(Boolean(e && (e.altKey || e.ctrlKey)));
        window.addEventListener("keydown", onKeyMod, true);
        window.addEventListener("keyup", onKeyMod, true);
        window.addEventListener("blur", () => syncModHeld(false));
    }

    const sysDarkMq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    function resolveShellThemeMode() {
        if (themeState.themeMode === "light") return "light";
        if (themeState.themeMode === "dark") return "dark";
        return (sysDarkMq && typeof sysDarkMq.matches === "boolean") ? (sysDarkMq.matches ? "dark" : "light") : "dark";
    }

    function hexToRgbStr(hex, fallback = "96, 165, 250") {
        const clean = String(hex || "").replace("#", "").trim();
        if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
        return parseInt(clean.slice(0, 2), 16) + ", " + parseInt(clean.slice(2, 4), 16) + ", " + parseInt(clean.slice(4, 6), 16);
    }

    function registerShellCustomFonts(fonts) {
        if (!Array.isArray(fonts)) return;
        const css = fonts.map((f) => {
            if (!f || !f.family || !f.urlPath) return "";
            const url = withToken(BASE_URL + f.urlPath);
            const safeFam = String(f.family).replace(/["\\\\]/g, "");
            const fmt = String(f.format || "truetype").replace(/[^a-z0-9-]/gi, "");
            return '@font-face{font-family:"' + safeFam + '";src:url("' + url + '") format("' + fmt + '");font-weight:100 900;font-style:normal;font-display:swap;}';
        }).filter(Boolean).join("\\n");
        let el = document.getElementById("agy-shell-custom-fonts");
        if (!el) {
            el = document.createElement("style");
            el.id = "agy-shell-custom-fonts";
            (document.head || document.documentElement).appendChild(el);
        }
        el.textContent = css;
    }

    function hydrateTheme(cfg, extras) {
        if (cfg && typeof cfg === "object") {
            if (cfg.lang === "en" || cfg.lang === "ru") themeState.lang = cfg.lang;
            if (cfg.themeMode === "dark" || cfg.themeMode === "light" || cfg.themeMode === "system") themeState.themeMode = cfg.themeMode;
            if (cfg.uiContrast === "default" || cfg.uiContrast === "high") themeState.uiContrast = cfg.uiContrast;
            for (const bk of ["darkUseCustomBg", "darkUseCustomText", "lightUseCustomBg", "lightUseCustomText", "reduceBackdropBlur", "reduceMotion", "adaptiveAccent", "autoContrast", "privacyMode", "privacyHidePaths"]) {
                if (typeof cfg[bk] === "boolean") themeState[bk] = cfg[bk];
            }
            if (cfg.privacyRevealMode === "never" || cfg.privacyRevealMode === "modifier" || cfg.privacyRevealMode === "hover") {
                themeState.privacyRevealMode = cfg.privacyRevealMode;
            }
            if (cfg.privacyHideStyle === "blur" || cfg.privacyHideStyle === "mask") {
                themeState.privacyHideStyle = cfg.privacyHideStyle;
            }
            for (const hk of ["darkCustomBgHex", "darkCustomTextHex", "darkCustomAccentHex", "lightCustomBgHex", "lightCustomTextHex", "lightCustomAccentHex"]) {
                if (typeof cfg[hk] === "string" && /^#[0-9a-fA-F]{6}$/.test(cfg[hk])) themeState[hk] = cfg[hk].toLowerCase();
            }
            const effModeForLegacy = resolveShellThemeMode();
            if (typeof cfg.useCustomBg === "boolean") {
                themeState.useCustomBg = cfg.useCustomBg;
                if (typeof cfg.darkUseCustomBg !== "boolean" && typeof cfg.lightUseCustomBg !== "boolean") {
                    if (effModeForLegacy === "light") themeState.lightUseCustomBg = cfg.useCustomBg;
                    else themeState.darkUseCustomBg = cfg.useCustomBg;
                }
            }
            if (typeof cfg.customBgHex === "string" && /^#[0-9a-fA-F]{6}$/.test(cfg.customBgHex)) {
                themeState.customBgHex = cfg.customBgHex.toLowerCase();
                if (!cfg.darkCustomBgHex && !cfg.lightCustomBgHex) {
                    if (effModeForLegacy === "light") themeState.lightCustomBgHex = themeState.customBgHex;
                    else themeState.darkCustomBgHex = themeState.customBgHex;
                }
            }
            if (typeof cfg.useCustomText === "boolean") {
                themeState.useCustomText = cfg.useCustomText;
                if (typeof cfg.darkUseCustomText !== "boolean" && typeof cfg.lightUseCustomText !== "boolean") {
                    if (effModeForLegacy === "light") themeState.lightUseCustomText = cfg.useCustomText;
                    else themeState.darkUseCustomText = cfg.useCustomText;
                }
            }
            if (typeof cfg.customTextHex === "string" && /^#[0-9a-fA-F]{6}$/.test(cfg.customTextHex)) {
                themeState.customTextHex = cfg.customTextHex.toLowerCase();
                if (!cfg.darkCustomTextHex && !cfg.lightCustomTextHex) {
                    if (effModeForLegacy === "light") themeState.lightCustomTextHex = themeState.customTextHex;
                    else themeState.darkCustomTextHex = themeState.customTextHex;
                }
            }
            if (typeof cfg.customAccentHex === "string" && /^#[0-9a-fA-F]{6}$/.test(cfg.customAccentHex)) {
                themeState.customAccentHex = cfg.customAccentHex.toLowerCase();
                if (!cfg.darkCustomAccentHex && !cfg.lightCustomAccentHex) {
                    if (effModeForLegacy === "light") themeState.lightCustomAccentHex = themeState.customAccentHex;
                    else themeState.darkCustomAccentHex = themeState.customAccentHex;
                }
            }
            if (typeof cfg.accentRgb === "string" && cfg.accentRgb) themeState.accentRgb = cfg.accentRgb;
            if (typeof cfg.tintRgb === "string" && cfg.tintRgb) themeState.tintRgb = cfg.tintRgb;
            if (Number.isFinite(Number(cfg.panelAlpha))) themeState.panelAlpha = Math.max(0, Math.min(1, Number(cfg.panelAlpha)));
            if (Number.isFinite(Number(cfg.panelBlurPx))) themeState.panelBlurPx = Math.max(0, Math.min(32, Math.round(Number(cfg.panelBlurPx))));
            if (Number.isFinite(Number(cfg.lumaBoost))) themeState.lumaBoost = Math.max(0, Math.min(0.92, Number(cfg.lumaBoost)));
            if (Number.isFinite(Number(cfg.dim))) themeState.dim = Math.max(0, Math.min(0.92, Number(cfg.dim)));
            if (Number.isFinite(Number(cfg.videoBlur))) themeState.videoBlur = Math.max(0, Math.min(28, Number(cfg.videoBlur)));
            if (Number.isFinite(Number(cfg.videoSat))) themeState.videoSat = Math.max(0.2, Math.min(2.2, Number(cfg.videoSat)));
            if (Number.isFinite(Number(cfg.videoContrast))) themeState.videoContrast = Math.max(0.5, Math.min(1.8, Number(cfg.videoContrast)));
            if (cfg.videoFit === "contain" || cfg.videoFit === "cover") themeState.videoFit = cfg.videoFit;
            if (Number.isFinite(Number(cfg.playbackRate))) themeState.playbackRate = Math.max(0.25, Math.min(2, Number(cfg.playbackRate)));
            if (Number.isFinite(Number(cfg.fontSizePx))) themeState.fontSizePx = Math.max(11, Math.min(22, Number(cfg.fontSizePx)));
            if (Number.isFinite(Number(cfg.radiusPx))) themeState.radiusPx = Math.max(0, Math.min(20, Number(cfg.radiusPx)));
            if (typeof cfg.uiFontChoice === "string" && cfg.uiFontChoice.trim()) themeState.uiFontChoice = cfg.uiFontChoice.trim();
            if (typeof cfg.currentId === "string") themeState.currentId = cfg.currentId;
            if (Number.isFinite(Number(cfg.currentIndex))) themeState.currentIndex = Number(cfg.currentIndex);
            if (cfg.mediaFilter === "all" || cfg.mediaFilter === "video" || cfg.mediaFilter === "image") themeState.mediaFilter = cfg.mediaFilter;
            if (typeof cfg.hideMature === "boolean") themeState.hideMature = cfg.hideMature;
            if (typeof cfg.hideLowRes === "boolean") themeState.hideLowRes = cfg.hideLowRes;
            if (typeof cfg.staticWallpaperMode === "boolean") themeState.staticWallpaperMode = cfg.staticWallpaperMode;
            if (typeof cfg.wallpaperEnabled === "boolean") themeState.wallpaperEnabled = cfg.wallpaperEnabled;
            if (Array.isArray(cfg.hiddenIds)) themeState.hiddenIds = cfg.hiddenIds.filter((x) => typeof x === "string");
        }
        if (extras && typeof extras === "object") {
            if (extras.lang === "en" || extras.lang === "ru") themeState.lang = extras.lang;
        }
    }

    const shellVarCache = new Map();
    const shellDataCache = new Map();
    let lastShellColorScheme = "";
    function setShellVar(rootStyle, name, value) {
        const v = String(value);
        if (shellVarCache.get(name) === v) return;
        shellVarCache.set(name, v);
        rootStyle.setProperty(name, v);
    }
    function setShellData(dataset, key, value) {
        const v = String(value);
        if (shellDataCache.get(key) === v && dataset[key] === v) return;
        shellDataCache.set(key, v);
        dataset[key] = v;
    }

    function applySharedThemeVars() {
        const root = document.documentElement;
        const effMode = resolveShellThemeMode();
        const highContrast = themeState.uiContrast === "high";
        const useBg = effMode === "light" ? !!themeState.lightUseCustomBg : !!themeState.darkUseCustomBg;
        const bgHex = effMode === "light" ? (themeState.lightCustomBgHex || "#fafbfe") : (themeState.darkCustomBgHex || "#0c0e14");
        const useText = effMode === "light" ? !!themeState.lightUseCustomText : !!themeState.darkUseCustomText;
        const textHex = effMode === "light" ? (themeState.lightCustomTextHex || "#111827") : (themeState.darkCustomTextHex || "#f8fafc");
        const customAccHex = effMode === "light" ? (themeState.lightCustomAccentHex || "#2563eb") : (themeState.darkCustomAccentHex || "#60a5fa");

        const plainBg = themeState.wallpaperEnabled === false;
        const accentRgb = !plainBg && themeState.adaptiveAccent && themeState.accentRgb
            ? themeState.accentRgb
            : hexToRgbStr(customAccHex || themeState.customAccentHex, effMode === "light" ? "37, 99, 235" : "96, 165, 250");
        const tintRgb = useBg
            ? hexToRgbStr(bgHex, effMode === "light" ? "250, 251, 254" : "12, 14, 20")
            : (effMode === "light" ? "250, 251, 254" : "12, 14, 20");

        const rawBlur = Number(themeState.panelBlurPx);
        const safeBlur = Number.isFinite(rawBlur) ? Math.max(0, Math.min(32, Math.round(rawBlur))) : 20;
        const tok = buildUiDesignTokens({
            themeMode: themeState.themeMode,
            effectiveMode: effMode,
            tintRgb,
            accentRgb,
            uiContrast: themeState.uiContrast,
            panelAlpha: themeState.panelAlpha,
            reduceBackdropBlur: themeState.reduceBackdropBlur,
            panelBlurPx: safeBlur,
            useCustomText: useText,
            customTextHex: textHex,
            useCustomBg: useBg,
            dim: plainBg ? 0 : themeState.dim,
            lumaBoost: plainBg ? 0 : (themeState.lumaBoost || 0),
        });
        const layers = tok.layers;
        const r = Math.round(themeState.radiusPx);
        const rSm = Math.max(0, Math.round(r * 0.7));
        const font = FONT_MAP[themeState.uiFontChoice] || themeState.uiFontChoice || FONT_MAP.system;
        const panelBlur = tok.panelBlurPx;
        const blurSkip = !themeState.reduceBackdropBlur && (panelBlur <= 0 || layers.panelAlpha >= 0.96);

        setShellData(root.dataset, "agyThemeMode", tok.effectiveMode);
        setShellData(root.dataset, "agySurface", tok.isLightSurface ? "light" : "dark");
        setShellData(root.dataset, "agyContrast", highContrast ? "high" : "default");
        setShellData(root.dataset, "agyNoBlur", (themeState.reduceBackdropBlur || blurSkip) ? "1" : "0");
        setShellData(root.dataset, "agyReduceMotion", themeState.reduceMotion ? "1" : "0");
        const plainBgVal = plainBg ? "1" : "0";
        if (root.dataset.agyPlainBg !== plainBgVal) root.dataset.agyPlainBg = plainBgVal;
        setShellData(root.dataset, "agyPrivacy", themeState.privacyMode ? "1" : "0");
        setShellData(root.dataset, "agyPrivacyReveal", themeState.privacyRevealMode || "modifier");
        setShellData(root.dataset, "agyPrivacyStyle", themeState.privacyHideStyle || "blur");
        setShellData(root.dataset, "agyPrivacyPaths", themeState.privacyHidePaths !== false ? "1" : "0");
        if (!themeState.privacyMode || themeState.privacyRevealMode !== "modifier") {
            setShellData(root.dataset, "agyModHeld", "0");
        }
        const nextScheme = tok.isLightSurface ? "light" : "dark";
        if (lastShellColorScheme !== nextScheme) {
            lastShellColorScheme = nextScheme;
            root.style.colorScheme = nextScheme;
        }

        const rs = root.style;
        setShellVar(rs, "--agy-accent-rgb", tok.accentRgb);
        setShellVar(rs, "--agy-tint-rgb", tok.tintRgb);
        setShellVar(rs, "--agy-ui-font", font);
        setShellVar(rs, "--agy-base-font-size", themeState.fontSizePx + "px");
        setShellVar(rs, "--agy-radius", r + "px");
        setShellVar(rs, "--agy-radius-sm", rSm + "px");
        setShellVar(rs, "--agy-panel-alpha", String(layers.panelAlpha));
        setShellVar(rs, "--agy-panel-blur", (blurSkip ? 0 : panelBlur) + "px");
        setShellVar(rs, "--agy-surface-base-alpha", layers.baseAlpha.toFixed(3));
        setShellVar(rs, "--agy-surface-sidebar-alpha", layers.sidebarAlpha.toFixed(3));
        setShellVar(rs, "--agy-surface-card-alpha", layers.cardAlpha.toFixed(3));
        setShellVar(rs, "--agy-surface-composer-alpha", layers.composerAlpha.toFixed(3));
        setShellVar(rs, "--agy-surface-modal-alpha", layers.modalAlpha.toFixed(3));
        setShellVar(rs, "--agy-surface-base", tok.surfaceBase);
        setShellVar(rs, "--agy-surface-sidebar", tok.surfaceSidebar);
        setShellVar(rs, "--agy-surface-card", tok.surfaceCard);
        setShellVar(rs, "--agy-surface-composer", tok.surfaceComposer);
        setShellVar(rs, "--agy-surface-modal", tok.surfaceDialog || tok.surfaceModal);
        setShellVar(rs, "--agy-surface-dialog", tok.surfaceDialog || tok.surfaceModal);
        setShellVar(rs, "--agy-surface-popover", tok.surfacePopover);
        setShellVar(rs, "--agy-surface-sticky", tok.surfaceSticky || tok.surfacePopover);
        setShellVar(rs, "--agy-backdrop-bg", tok.backdropBg);
        setShellVar(rs, "--agy-nav-bg", tok.navBg);
        setShellVar(rs, "--agy-card-bg", tok.cardBg);
        setShellVar(rs, "--agy-hc-scrim-lift", String(layers.hcScrimLift));
        setShellVar(rs, "--agy-wp-dim", String(themeState.dim));
        setShellVar(rs, "--agy-scrim-opacity", String(tok.scrimOpacity));

        setShellVar(rs, "--agy-fg", tok.fg);
        setShellVar(rs, "--agy-fg-secondary", tok.fgSecondary);
        setShellVar(rs, "--agy-fg-muted", tok.fgMuted);
        setShellVar(rs, "--agy-fg-subtle", tok.fgSubtle);
        setShellVar(rs, "--agy-text-primary", tok.fg);
        setShellVar(rs, "--agy-text-muted", tok.fgMuted);
        setShellVar(rs, "--agy-text-subtle", tok.fgSubtle);
        setShellVar(rs, "--agy-border", tok.border);
        setShellVar(rs, "--agy-border-strong", tok.borderStrong);
        setShellVar(rs, "--agy-divider", tok.divider);
        setShellVar(rs, "--agy-hover-bg", tok.hoverBg);
        setShellVar(rs, "--agy-subtle-bg", tok.subtleBg);
        setShellVar(rs, "--agy-subtle-bg-strong", tok.subtleBgStrong);
        setShellVar(rs, "--agy-shadow-card", tok.shadowCard);
        setShellVar(rs, "--agy-shadow-panel", tok.shadowPanel);
        setShellVar(rs, "--agy-danger-fg", tok.dangerFg);
        setShellVar(rs, "--agy-warn-fg", tok.warnFg);
        setShellVar(rs, "--agy-ok-fg", tok.okFg);
        setShellVar(rs, "--agy-on-solid-accent", tok.onSolidAccent);
        setShellVar(rs, "--agy-on-tinted-accent", tok.onTintedAccent);
        setShellVar(rs, "--agy-accent-text", tok.accentText);
        return tok;
    }

    if (sysDarkMq) {
        const onSys = () => { if (themeState.themeMode === "system") applySharedThemeVars(); };
        if (typeof sysDarkMq.addEventListener === "function") sysDarkMq.addEventListener("change", onSys);
        else if (typeof sysDarkMq.addListener === "function") sysDarkMq.addListener(onSys);
    }

    function esc(s) {
        return String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function getAccountTitle(acc, ru) {
        if (!acc) return ru ? "Аккаунт" : "Account";
        if (acc.customLabel) return acc.customLabel;
        if (acc.displayName) return acc.displayName;
        if (acc.email) return acc.email;
        return acc.id === "default" ? (ru ? "Основной аккаунт" : "Primary account") : (ru ? "Новый аккаунт" : "New account");
    }

    function getInitials(acc) {
        const s = (acc?.displayName || acc?.customLabel || acc?.email || "A").trim();
        const parts = s.split(/\\s+/);
        return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : s.slice(0, 2).toUpperCase();
    }

    function getStatusMeta(acc, ru) {
        const st = acc?.status || "stopped";
        if (st === "starting") return { key: "starting", label: ru ? "Запуск..." : "Starting...", color: "rgb(var(--agy-accent-rgb))" };
        if (st === "waiting") return { key: "waiting", label: ru ? "Ждёт ответа" : "Waiting", color: "var(--agy-warn-fg, #f59e0b)" };
        if (st === "working") {
            const n = Number(acc?.activeAgentCount || 0);
            return {
                key: "working",
                label: n > 1 ? (ru ? ("Работает (" + n + ")") : ("Working (" + n + ")")) : (ru ? "Работает" : "Working"),
                color: "rgb(var(--agy-accent-rgb))",
            };
        }
        if (st === "error") return { key: "error", label: ru ? "Ошибка" : "Error", color: "var(--agy-danger-fg, #ef4444)" };
        if (st === "ready" || acc?.tabOpen || acc?.lsRunning) return { key: "ready", label: ru ? "Готов" : "Ready", color: "var(--agy-ok-fg, #22c55e)" };
        return { key: "stopped", label: ru ? "Не запущен" : "Stopped", color: "var(--agy-text-subtle)" };
    }
    `;
}

function getInitialThemeAttr() {
    let attrs = "";
    try {
        const wp = require("./wallpaperEngine");
        if (typeof wp.readAppearanceConfig === "function") {
            const cfg = wp.readAppearanceConfig();
            if (cfg && typeof cfg === "object") {
                const rawMode = String(cfg.themeMode || "dark").toLowerCase();
                let effMode = rawMode === "light" || rawMode === "dark" ? rawMode : "dark";
                if (rawMode === "system") {
                    try {
                        const { nativeTheme } = require("electron");
                        if (nativeTheme && typeof nativeTheme.shouldUseDarkColors === "boolean") {
                            effMode = nativeTheme.shouldUseDarkColors ? "dark" : "light";
                        }
                    } catch {}
                }
                const isLightSurface = effMode === "light";
                const noBlur = cfg.reduceBackdropBlur ? "1" : "0";
                const contrast = cfg.uiContrast === "high" ? "high" : "default";
                attrs += ` data-agy-theme-mode="${effMode}" data-agy-surface="${isLightSurface ? "light" : "dark"}" data-agy-contrast="${contrast}" data-agy-no-blur="${noBlur}"`;
                const rev = cfg.privacyRevealMode === "never" || cfg.privacyRevealMode === "hover" ? cfg.privacyRevealMode : "modifier";
                const sty = cfg.privacyHideStyle === "mask" ? "mask" : "blur";
                const paths = cfg.privacyHidePaths === false ? "0" : "1";
                const priv = cfg.privacyMode ? "1" : "0";
                attrs += ` data-agy-privacy="${priv}" data-agy-privacy-reveal="${rev}" data-agy-privacy-style="${sty}" data-agy-privacy-paths="${paths}"`;
            }
        }
    } catch {}
    return attrs;
}

function getInitialPrivacyAttr() {
    return getInitialThemeAttr();
}

function renderTabBarHtml(port, token = "") {
    const baseUrl = `http://127.0.0.1:${Number(port)}`;
    const privAttr = getInitialThemeAttr();
    return `<!doctype html>
<html lang="ru"${privAttr}>
<head>
<meta charset="utf-8">
<title>Antigravity Tabs</title>
<style>
    :root {
        --agy-accent-rgb: 96, 165, 250;
        --agy-tint-rgb: 12, 14, 20;
        --agy-ui-font: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
        --agy-base-font-size: 14px;
        --agy-radius: 10px;
        --agy-radius-sm: 7px;
        --agy-surface-sidebar: rgba(12, 14, 20, 0.85);
        --agy-fg: #f8fafc;
        --agy-fg-muted: #b8c4d4;
        --agy-fg-subtle: #8b9bb0;
        --agy-text-primary: var(--agy-fg);
        --agy-text-muted: var(--agy-fg-muted);
        --agy-text-subtle: var(--agy-fg-subtle);
        --agy-border: rgba(255, 255, 255, 0.15);
        --agy-border-strong: rgba(255, 255, 255, 0.26);
        --agy-divider: rgba(255, 255, 255, 0.11);
        --agy-hover-bg: rgba(255, 255, 255, 0.08);
        --agy-subtle-bg: rgba(255, 255, 255, 0.06);
        --agy-subtle-bg-strong: rgba(255, 255, 255, 0.14);
        --agy-danger-fg: #fca5a5;
        --agy-warn-fg: #fcd34d;
        --agy-ok-fg: #86efac;
        --agy-on-tinted-accent: #ffffff;
        --agy-accent-text: #93c5fd;
    }
    html[data-agy-surface="light"] {
        --agy-tint-rgb: 250, 251, 254;
        --agy-surface-sidebar: rgba(250, 251, 254, 0.85);
        --agy-fg: #111827;
        --agy-fg-muted: #475569;
        --agy-fg-subtle: #64748b;
        --agy-border: rgba(15, 23, 42, 0.16);
        --agy-border-strong: rgba(15, 23, 42, 0.28);
        --agy-divider: rgba(15, 23, 42, 0.12);
        --agy-hover-bg: rgba(255, 255, 255, 0.54);
        --agy-subtle-bg: rgba(248, 250, 252, 0.56);
        --agy-subtle-bg-strong: rgba(241, 245, 249, 0.74);
        --agy-danger-fg: #b91c1c;
        --agy-warn-fg: #b45309;
        --agy-ok-fg: #15803d;
        --agy-on-tinted-accent: #1e293b;
        --agy-accent-text: #2563eb;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: rgb(var(--agy-tint-rgb));
        color: var(--agy-fg);
        font-family: var(--agy-ui-font);
        font-size: var(--agy-base-font-size);
        user-select: none;
        -webkit-font-smoothing: antialiased;
    }
    .bar {
        display: flex;
        align-items: center;
        height: 100%;
        width: 100%;
        padding: 0 144px 0 8px;
        gap: 6px;
        background: var(--agy-surface-sidebar);
        border-bottom: 1px solid var(--agy-divider);
        -webkit-app-region: drag;
    }
    .picker-btn {
        -webkit-app-region: no-drag;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: calc(100% - 8px);
        padding: 0 10px;
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: var(--agy-subtle-bg);
        color: var(--agy-fg);
        font: inherit;
        font-size: 0.84em;
        font-weight: 600;
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.12s ease, border-color 0.12s ease;
    }
    .picker-btn:hover {
        background: var(--agy-hover-bg);
    }
    .picker-btn.active {
        background: rgba(var(--agy-accent-rgb), 0.22);
        border-color: rgba(var(--agy-accent-rgb), 0.55);
        color: var(--agy-on-tinted-accent);
    }
    .tabs-scroll {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        height: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
    }
    .tabs-scroll::-webkit-scrollbar { display: none; }
    .tab {
        -webkit-app-region: no-drag;
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: calc(100% - 8px);
        min-width: 148px;
        max-width: 280px;
        padding: 0 7px 0 8px;
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: var(--agy-subtle-bg);
        color: var(--agy-fg-muted);
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.18s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.18s cubic-bezier(0.16, 1, 0.3, 1), color 0.18s ease, transform 0.14s ease;
    }
    html[data-agy-contrast="high"] .tab,
    html[data-agy-contrast="high"] .picker-btn,
    html[data-agy-contrast="high"] .tab-add-btn,
    html[data-agy-contrast="high"] .tab-close {
        border-color: var(--agy-border-strong);
    }
    html[data-agy-contrast="high"] :is(.tab, .picker-btn, .tab-add-btn, .tab-close):focus-visible {
        outline: 2px solid rgba(var(--agy-accent-rgb), 0.9);
        outline-offset: 1px;
    }
    .tab:hover:not(.active) {
        background: var(--agy-hover-bg);
        color: var(--agy-fg);
        transform: translateY(-1px);
    }
    .tab.active {
        background: rgba(var(--agy-accent-rgb), 0.19);
        border-color: rgba(var(--agy-accent-rgb), 0.58);
        color: var(--agy-fg);
    }
    .tab-av {
        width: 20px;
        height: 20px;
        border-radius: calc(var(--agy-radius-sm) * 0.65);
        background: var(--agy-subtle-bg-strong);
        color: var(--agy-fg);
        font-size: 0.68em;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        overflow: hidden;
    }
    .tab-av img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"] .tab-email {
        filter: blur(4.5px);
        opacity: 0.78;
        transition: filter 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
    }
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"][data-agy-privacy-reveal="hover"] .tab-email:hover,
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"][data-agy-privacy-reveal="modifier"][data-agy-mod-held="1"] .tab-email:hover {
        filter: none;
        opacity: 1;
    }
    html[data-agy-privacy="1"][data-agy-privacy-style="mask"] .tab-email {
        letter-spacing: 0.04em;
        opacity: 0.85;
    }
    .tab-meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
        line-height: 1.15;
    }
    .tab-name-row {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
    }
    .tab-name {
        font-size: 0.82em;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .tab-sub {
        font-size: 0.68em;
        color: var(--agy-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
        gap: 5px;
    }
    .tab.active .tab-sub {
        color: var(--agy-text-primary);
        opacity: 0.82;
    }
    .st-mark {
        width: 6px;
        height: 6px;
        border-radius: 2px;
        flex-shrink: 0;
        display: inline-block;
    }
    .st-text {
        white-space: nowrap;
        font-weight: 600;
    }
    .tab-close {
        width: 20px;
        height: 20px;
        border-radius: calc(var(--agy-radius-sm) * 0.65);
        border: none;
        background: transparent;
        color: var(--agy-text-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        opacity: 0.65;
        transition: background 0.16s ease, opacity 0.16s ease, color 0.16s ease, transform 0.14s ease;
    }
    .tab-close:hover {
        background: rgba(239, 68, 68, 0.24);
        color: var(--agy-danger-fg);
        opacity: 1;
        transform: scale(1.08);
    }
    .tab-close:active {
        transform: scale(0.92);
    }
    .add-btn {
        -webkit-app-region: no-drag;
        width: 28px;
        height: calc(100% - 8px);
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: transparent;
        color: var(--agy-fg-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.12s ease, color 0.12s ease;
    }
    .add-btn:hover {
        background: var(--agy-hover-bg);
        color: var(--agy-fg);
    }
    .hint {
        font-size: 0.78em;
        color: var(--agy-fg-muted);
        padding: 0 8px;
        white-space: nowrap;
    }
    .tab-add-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: transparent;
        color: var(--agy-fg-subtle);
        cursor: pointer;
        -webkit-app-region: no-drag;
        transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .tab-add-btn:hover {
        background: var(--agy-hover-bg);
        border-color: var(--agy-border);
        color: var(--agy-fg);
    }
    html[data-agy-reduce-motion="1"] * { transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
</style>
</head>
<body>
<div class="bar" id="bar">
    <button class="picker-btn" id="btn-picker" title="Аккаунты и лимиты">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span id="lbl-picker">Аккаунты</span>
    </button>
    <div class="tabs-scroll" id="tabs"></div>
</div>
<script>
(() => {
    ${buildSharedThemeScript(baseUrl, token)}

    let snapshot = { activeId: "", viewMode: "picker", openTabOrder: [], accounts: [] };
    let lastReportedHeight = 0;

    function syncBarHeight() {
        const target = Math.max(36, Math.min(54, Math.round(themeState.fontSizePx * 2.85)));
        if (target !== lastReportedHeight) {
            lastReportedHeight = target;
            apiFetch("/tabs/bar-height", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ height: target }),
            }).catch(() => {});
        }
    }

    function render() {
        const ru = themeState.lang !== "en";
        const pickerBtn = document.getElementById("btn-picker");
        const pickerLbl = document.getElementById("lbl-picker");
        const tabsEl = document.getElementById("tabs");

        pickerLbl.textContent = ru ? "Аккаунты" : "Accounts";
        pickerBtn.title = ru ? "Экран выбора аккаунта и лимитов" : "Account Picker & Quotas";
        pickerBtn.classList.toggle("active", snapshot.viewMode === "picker");

        const accById = new Map((snapshot.accounts || []).map((a) => [a.id, a]));
        const openIds = (snapshot.openTabOrder || []).filter((id) => accById.has(id));
        tabsEl.innerHTML = "";

        if (openIds.length === 0) {
            const hint = document.createElement("span");
            hint.className = "hint";
            hint.textContent = ru ? "Выберите аккаунт на экране ниже" : "Select an account below to open a tab";
            tabsEl.appendChild(hint);
            return;
        }

        for (const id of openIds) {
            const acc = accById.get(id);
            const isActive = snapshot.viewMode === "tab" && snapshot.activeId === id;
            const st = getStatusMeta(acc, ru);
            const title = getAccountTitle(acc, ru);
            const subEmail = acc.email && acc.email !== title ? acc.email : "";
            const showActiveStatus = st.key === "working" || st.key === "waiting" || st.key === "starting" || st.key === "error";

            const tab = document.createElement("div");
            tab.className = "tab" + (isActive ? " active" : "");
            const dispTitle = formatPrivacyValue(title, title.includes("@"));
            const dispSubEmail = formatPrivacyValue(subEmail, true);
            const safeTipTitle = getSafePrivacyTip((themeState.privacyMode && title.includes("@")) ? (ru ? "Аккаунт" : "Account") : title);
            tab.title = safeTipTitle + (!themeState.privacyMode && acc.email ? " (" + acc.email + ")" : "") + (showActiveStatus ? (" — " + st.label) : "");

            const av = document.createElement("div");
            av.className = "tab-av";
            if (acc.avatar) av.innerHTML = '<img src="' + esc(acc.avatar) + '" alt="">';
            else av.textContent = getInitials(acc);

            const meta = document.createElement("div");
            meta.className = "tab-meta";
            meta.innerHTML =
                '<div class="tab-name-row">' +
                    '<span class="tab-name' + (title.includes("@") ? ' tab-email' : '') + '">' + esc(dispTitle) + '</span>' +
                '</div>' +
                '<div class="tab-sub">' +
                    (showActiveStatus ? ('<span class="st-text" style="color:' + st.color + ';">' + esc(st.label) + '</span>' + (subEmail ? '<span>·</span>' : '')) : '') +
                    (subEmail ? '<span class="tab-email" style="overflow:hidden;text-overflow:ellipsis;">' + esc(dispSubEmail) + '</span>' : (!showActiveStatus ? '<span>' + esc(st.label) + '</span>' : '')) +
                '</div>';

            const closeBtn = document.createElement("button");
            closeBtn.className = "tab-close";
            closeBtn.title = ru ? "Закрыть вкладку" : "Close tab";
            closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                apiFetch("/tabs/close", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id }),
                }).catch(() => {});
            };

            tab.onclick = () => {
                apiFetch("/tabs/open", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id }),
                }).catch(() => {});
            };

            tab.append(av, meta, closeBtn);
            tabsEl.appendChild(tab);
        }

        const addBtn = document.createElement("button");
        addBtn.className = "tab-add-btn";
        addBtn.title = ru ? "Открыть или добавить аккаунт" : "Open or add account";
        addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        addBtn.onclick = () => {
            apiFetch("/tabs/show-picker", { method: "POST" }).catch(() => {});
        };
        tabsEl.appendChild(addBtn);
    }

    document.getElementById("btn-picker").onclick = () => {
        apiFetch("/tabs/show-picker", { method: "POST" }).catch(() => {});
    };

    function refreshAll() {
        Promise.all([
            apiFetch("/config").then((r) => r.json()).catch(() => ({})),
            apiFetch("/extras/config").then((r) => r.json()).catch(() => ({})),
            apiFetch("/accounts/list").then((r) => r.json()).catch(() => null),
            apiFetch("/fonts/list").then((r) => r.json()).catch(() => ({ fonts: [] })),
        ]).then(([cfg, ex, accRes, fontRes]) => {
            if (fontRes && Array.isArray(fontRes.fonts)) registerShellCustomFonts(fontRes.fonts);
            hydrateTheme(cfg, ex);
            applySharedThemeVars();
            syncBarHeight();
            if (accRes && Array.isArray(accRes.accounts)) snapshot = accRes;
            render();
        });
    }

    refreshAll();

    try {
        const es = new EventSource(withToken(BASE_URL + "/events"));
        es.addEventListener("fonts", (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                if (payload && Array.isArray(payload.fonts)) registerShellCustomFonts(payload.fonts);
            } catch {}
        });
        es.addEventListener("accounts", (ev) => {
            try {
                const data = JSON.parse(ev.data);
                if (data && Array.isArray(data.accounts)) {
                    snapshot = data;
                    render();
                }
            } catch {}
        });
        es.addEventListener("config", (ev) => {
            try {
                const cfg = JSON.parse(ev.data);
                const prevSig = [themeState.lang, themeState.privacyMode, themeState.privacyHideStyle, themeState.privacyRevealMode, themeState.privacyHidePaths].join("|");
                hydrateTheme(cfg, null);
                applySharedThemeVars();
                syncBarHeight();
                const nextSig = [themeState.lang, themeState.privacyMode, themeState.privacyHideStyle, themeState.privacyRevealMode, themeState.privacyHidePaths].join("|");
                if (nextSig !== prevSig) render();
            } catch {}
        });
        es.addEventListener("extras", (ev) => {
            try {
                const ex = JSON.parse(ev.data);
                const prevLang = themeState.lang;
                hydrateTheme(null, ex);
                applySharedThemeVars();
                if (themeState.lang !== prevLang) render();
            } catch {}
        });
        window.addEventListener("pagehide", () => { try { es.close(); } catch {} });
    } catch {}
})();
</script>
</body>
</html>`;
}

function renderPickerHtml(port, token = "") {
    const baseUrl = `http://127.0.0.1:${Number(port)}`;
    const privAttr = getInitialThemeAttr();
    return `<!doctype html>
<html lang="ru"${privAttr}>
<head>
<meta charset="utf-8">
<title>Antigravity — Accounts</title>
<style>
    :root {
        --agy-accent-rgb: 96, 165, 250;
        --agy-tint-rgb: 12, 14, 20;
        --agy-ui-font: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
        --agy-base-font-size: 14px;
        --agy-radius: 10px;
        --agy-radius-sm: 7px;
        --agy-panel-alpha: 0.68;
        --agy-surface-card-alpha: 0.698;
        --agy-surface-modal-alpha: 0.773;
        --agy-surface-card: rgba(12, 14, 20, 0.698);
        --agy-surface-modal: rgba(12, 14, 20, 0.773);
        --agy-hc-scrim-lift: 0;
        --agy-wp-dim: 0.36;
        --agy-fg: #f8fafc;
        --agy-fg-muted: #b8c4d4;
        --agy-fg-subtle: #8b9bb0;
        --agy-text-primary: var(--agy-fg);
        --agy-text-muted: var(--agy-fg-muted);
        --agy-text-subtle: var(--agy-fg-subtle);
        --agy-border: rgba(255, 255, 255, 0.15);
        --agy-border-strong: rgba(255, 255, 255, 0.26);
        --agy-divider: rgba(255, 255, 255, 0.11);
        --agy-hover-bg: rgba(255, 255, 255, 0.08);
        --agy-subtle-bg: rgba(255, 255, 255, 0.06);
        --agy-subtle-bg-strong: rgba(255, 255, 255, 0.14);
        --agy-shadow-card: 0 10px 30px rgba(0, 0, 0, 0.36);
        --agy-shadow-panel: 0 18px 46px rgba(0, 0, 0, 0.42);
        --agy-danger-fg: #fca5a5;
        --agy-warn-fg: #fcd34d;
        --agy-ok-fg: #86efac;
        --agy-on-solid-accent: #000000;
        --agy-on-tinted-accent: #ffffff;
        --agy-accent-text: #93c5fd;
    }
    html[data-agy-surface="light"] {
        --agy-tint-rgb: 250, 251, 254;
        --agy-surface-card: rgba(250, 251, 254, 0.698);
        --agy-surface-modal: rgba(250, 251, 254, 0.773);
        --agy-fg: #111827;
        --agy-fg-muted: #475569;
        --agy-fg-subtle: #64748b;
        --agy-border: rgba(15, 23, 42, 0.16);
        --agy-border-strong: rgba(15, 23, 42, 0.28);
        --agy-divider: rgba(15, 23, 42, 0.12);
        --agy-hover-bg: rgba(255, 255, 255, 0.54);
        --agy-subtle-bg: rgba(248, 250, 252, 0.56);
        --agy-subtle-bg-strong: rgba(241, 245, 249, 0.74);
        --agy-shadow-card: 0 8px 24px rgba(15, 23, 42, 0.10);
        --agy-shadow-panel: 0 16px 40px rgba(15, 23, 42, 0.14);
        --agy-danger-fg: #b91c1c;
        --agy-warn-fg: #b45309;
        --agy-ok-fg: #15803d;
        --agy-on-solid-accent: #ffffff;
        --agy-on-tinted-accent: #1e293b;
        --agy-accent-text: #2563eb;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: rgb(var(--agy-tint-rgb));
        color: var(--agy-fg);
        font-family: var(--agy-ui-font);
        font-size: var(--agy-base-font-size);
        -webkit-font-smoothing: antialiased;
    }
    .bg-layer {
        position: fixed;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        background: rgb(var(--agy-tint-rgb));
    }
    .bg-layer video, .bg-layer img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: none;
    }
    .bg-dim {
        position: absolute;
        inset: 0;
        background: rgb(var(--agy-tint-rgb));
        opacity: var(--agy-scrim-opacity, min(0.92, calc(var(--agy-wp-dim) + var(--agy-hc-scrim-lift))));
    }
    html[data-agy-plain-bg="1"] .bg-layer video,
    html[data-agy-plain-bg="1"] .bg-layer img,
    html[data-agy-plain-bg="1"] .bg-dim {
        display: none !important;
        opacity: 0 !important;
    }
    .page {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        padding: 28px 32px 44px;
        display: flex;
        flex-direction: column;
        align-items: center;
    }
    .wrap {
        width: 100%;
        max-width: 1060px;
        display: flex;
        flex-direction: column;
        gap: 20px;
    }
    .header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        padding: 18px 20px;
        border-radius: var(--agy-radius);
        background: var(--agy-surface-card);
        backdrop-filter: blur(var(--agy-panel-blur, 20px));
        border: 1px solid var(--agy-border);
        box-shadow: var(--agy-shadow-card);
    }
    .header-left h1 {
        font-size: 1.45em;
        font-weight: 700;
        letter-spacing: -0.015em;
        line-height: 1.2;
    }
    .header-left p {
        margin-top: 5px;
        font-size: 0.90em;
        color: var(--agy-text-muted);
    }
    .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .add-form {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .inp {
        height: 2.55em;
        min-width: 200px;
        padding: 0 0.8em;
        border-radius: var(--agy-radius-sm);
        border: 1px solid var(--agy-border);
        background: var(--agy-subtle-bg);
        color: var(--agy-fg);
        font: inherit;
        font-size: 0.90em;
        outline: none;
    }
    .inp::placeholder { color: var(--agy-fg-subtle); }
    .inp:focus {
        border-color: rgba(var(--agy-accent-rgb), 0.72);
    }
    .btn {
        height: 2.55em;
        padding: 0 1em;
        border-radius: var(--agy-radius-sm);
        border: 1px solid var(--agy-border);
        background: var(--agy-subtle-bg);
        color: var(--agy-fg);
        font: inherit;
        font-size: 0.88em;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        transition: transform 0.16s cubic-bezier(0.16, 1, 0.3, 1), background 0.18s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.18s ease;
    }
    .btn:hover:not(:disabled) {
        transform: translateY(-1px);
        background: var(--agy-hover-bg);
        border-color: var(--agy-border-strong);
        box-shadow: var(--agy-shadow-card);
    }
    .btn:active:not(:disabled) {
        transform: translateY(0) scale(0.97);
    }
    .btn:disabled {
        opacity: 0.55;
        cursor: wait;
    }
    .btn-primary {
        background: rgba(var(--agy-accent-rgb), 0.25);
        border-color: rgba(var(--agy-accent-rgb), 0.62);
        color: var(--agy-on-tinted-accent);
    }
    .btn-primary:hover:not(:disabled) {
        background: rgba(var(--agy-accent-rgb), 0.36);
        box-shadow: 0 4px 18px rgba(var(--agy-accent-rgb), 0.30);
    }
    .banner {
        display: none;
        padding: 12px 15px;
        border-radius: var(--agy-radius-sm);
        background: var(--agy-surface-modal);
        backdrop-filter: blur(var(--agy-panel-blur, 20px));
        -webkit-backdrop-filter: blur(var(--agy-panel-blur, 20px));
        border: 1px solid rgba(var(--agy-accent-rgb), 0.55);
        font-size: 0.88em;
        line-height: 1.4;
        color: var(--agy-fg);
    }
    .banner.show { display: flex; flex-direction: column; gap: 8px; }
    .banner.error { border-color: rgba(239, 68, 68, 0.65); color: var(--agy-danger-fg); }
    .banner-bar {
        display: none;
        width: 100%;
        height: 3px;
        border-radius: 2px;
        background: var(--agy-subtle-bg-strong);
        overflow: hidden;
    }
    .banner.loading .banner-bar { display: block; }
    .banner-bar-fill {
        width: 38%;
        height: 100%;
        background: rgb(var(--agy-accent-rgb));
        animation: agy-slide 1.2s ease-in-out infinite;
    }
    @keyframes agy-slide {
        0% { transform: translateX(-110%); }
        100% { transform: translateX(300%); }
    }

    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: 14px;
    }
    .card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px;
        border-radius: var(--agy-radius);
        background: var(--agy-surface-card);
        backdrop-filter: blur(var(--agy-panel-blur, 20px));
        border: 1px solid var(--agy-border);
        box-shadow: var(--agy-shadow-card);
        transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
    }
    html[data-agy-no-blur="1"] .header,
    html[data-agy-no-blur="1"] .card,
    html[data-agy-no-blur="1"] .banner {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
    }
    html[data-agy-contrast="high"] .header,
    html[data-agy-contrast="high"] .card,
    html[data-agy-contrast="high"] .inp,
    html[data-agy-contrast="high"] .btn,
    html[data-agy-contrast="high"] .icon-btn,
    html[data-agy-contrast="high"] .tag,
    html[data-agy-contrast="high"] .quotas-box {
        border-color: var(--agy-border-strong);
    }
    html[data-agy-contrast="high"] :is(.inp, .btn, .icon-btn, .card):focus-visible {
        outline: 2px solid rgba(var(--agy-accent-rgb), 0.9);
        outline-offset: 1px;
    }
    html[data-agy-reduce-motion="1"] * { transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
    .card:hover {
        transform: translateY(-2px);
        border-color: rgba(var(--agy-accent-rgb), 0.52);
        box-shadow: var(--agy-shadow-panel);
    }
    .card.is-open {
        border-color: rgba(var(--agy-accent-rgb), 0.68);
        box-shadow: 0 6px 20px rgba(var(--agy-accent-rgb), 0.18);
    }
    .card-top {
        display: flex;
        align-items: center;
        gap: 11px;
        cursor: pointer;
    }
    .av {
        width: 42px;
        height: 42px;
        border-radius: var(--agy-radius-sm);
        background: var(--agy-subtle-bg-strong);
        color: var(--agy-fg);
        font-size: 0.95em;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        overflow: hidden;
    }
    .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ident { flex: 1; min-width: 0; }
    .ident-name {
        font-size: 1.02em;
        font-weight: 700;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .ident-email {
        font-size: 0.82em;
        color: var(--agy-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
        transition: filter 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
    }
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"] .ident-email,
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"] .ident-name.is-email {
        filter: blur(5px);
        opacity: 0.82;
        user-select: none;
    }
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"][data-agy-privacy-reveal="hover"] .ident-email:hover,
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"][data-agy-privacy-reveal="hover"] .ident-name.is-email:hover,
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"][data-agy-privacy-reveal="modifier"][data-agy-mod-held="1"] .ident-email:hover,
    html[data-agy-privacy="1"][data-agy-privacy-style="blur"][data-agy-privacy-reveal="modifier"][data-agy-mod-held="1"] .ident-name.is-email:hover {
        filter: none;
        opacity: 1;
    }
    html[data-agy-privacy="1"][data-agy-privacy-style="mask"] .ident-email,
    html[data-agy-privacy="1"][data-agy-privacy-style="mask"] .ident-name.is-email {
        letter-spacing: 0.04em;
        opacity: 0.86;
        user-select: none;
    }
    .meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 0.78em;
    }
    .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        border-radius: calc(var(--agy-radius-sm) * 0.75);
        background: var(--agy-subtle-bg);
        border: 1px solid var(--agy-border);
        color: var(--agy-fg);
        font-weight: 600;
    }
    .tag-muted {
        color: var(--agy-fg-muted);
        font-weight: 500;
    }
    .tag-warn {
        border-color: rgba(245, 158, 11, 0.55);
        color: var(--agy-warn-fg);
    }
    .st-sq {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        display: inline-block;
        flex-shrink: 0;
        transition: background 0.25s ease, box-shadow 0.25s ease;
    }
    @keyframes agyPulseGlow {
        0% { box-shadow: 0 0 0 0 rgba(var(--agy-accent-rgb), 0.5); }
        70% { box-shadow: 0 0 0 5px rgba(var(--agy-accent-rgb), 0); }
        100% { box-shadow: 0 0 0 0 rgba(var(--agy-accent-rgb), 0); }
    }
    .st-sq.working, .st-sq.ready {
        animation: agyPulseGlow 2.2s infinite;
    }
    .quotas-box {
        display: flex;
        flex-direction: column;
        gap: 7px;
        padding: 10px 11px;
        border-radius: var(--agy-radius-sm);
        background: var(--agy-subtle-bg);
        border: 1px solid var(--agy-divider);
    }
    .quotas-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.77em;
        color: var(--agy-fg-muted);
    }
    .tier-name {
        font-weight: 700;
        color: var(--agy-accent-text);
    }
    .q-row {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
    .q-label-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.80em;
    }
    .q-model {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--agy-fg);
    }
    .q-val {
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        color: var(--agy-fg-muted);
        font-weight: 600;
    }
    .q-track {
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: var(--agy-subtle-bg-strong);
        overflow: hidden;
    }
    .q-fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.45s cubic-bezier(0.16, 1, 0.3, 1), background 0.25s ease;
    }
    .q-empty {
        font-size: 0.80em;
        color: var(--agy-fg-muted);
        line-height: 1.35;
    }
    .card-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: auto;
        padding-top: 4px;
    }
    .icon-acts {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .icon-btn {
        height: 2.35em;
        min-width: 2.35em;
        padding: 0 0.55em;
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: var(--agy-subtle-bg);
        color: var(--agy-fg-muted);
        font: inherit;
        font-size: 0.82em;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        transition: transform 0.14s cubic-bezier(0.16, 1, 0.3, 1), background 0.16s ease, color 0.16s ease;
    }
    .icon-btn:hover {
        background: var(--agy-hover-bg);
        color: var(--agy-fg);
        transform: translateY(-1px);
    }
    .icon-btn:active {
        transform: translateY(0) scale(0.95);
    }
    .icon-btn.danger {
        color: var(--agy-danger-fg);
    }
    .icon-btn.danger:hover {
        background: rgba(239, 68, 68, 0.22);
        color: var(--agy-danger-fg);
    }
    .rename-inp {
        width: 100%;
        height: 2.1em;
        padding: 0 0.6em;
        border-radius: var(--agy-radius-sm);
        border: 1px solid rgba(var(--agy-accent-rgb), 0.7);
        background: var(--agy-surface-modal);
        color: var(--agy-fg);
        font: inherit;
        font-size: 0.92em;
        outline: none;
    }
    .tab-add-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: transparent;
        color: var(--agy-fg-subtle);
        cursor: pointer;
        -webkit-app-region: no-drag;
        transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .tab-add-btn:hover {
        background: var(--agy-hover-bg);
        border-color: var(--agy-border);
        color: var(--agy-fg);
    }
</style>
</head>
<body>
<div class="bg-layer">
    <video id="bg-video" autoplay loop muted playsinline></video>
    <img id="bg-img" alt="">
    <div class="bg-dim"></div>
</div>
<div class="page">
    <div class="wrap">
        <div class="header">
            <div class="header-left">
                <h1 id="hdr-title">Выбор аккаунта</h1>
                <p id="hdr-sub">Изолированные профили Google с отдельными тарифами, лимитами и фоновой работой в одном окне</p>
            </div>
            <div class="header-actions">
                <form class="add-form" id="add-form">
                    <input class="inp" id="new-label" type="text" maxlength="48" placeholder="Метка нового аккаунта...">
                    <button class="btn btn-primary" id="btn-add" type="submit">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        <span id="lbl-add">Добавить аккаунт</span>
                    </button>
                </form>
                <button class="btn" id="btn-lang" type="button" title="RU / EN">RU</button>
            </div>
        </div>
        <div class="banner" id="banner" role="status"><span id="banner-text"></span><div class="banner-bar"><div class="banner-bar-fill"></div></div></div>
        <div class="grid" id="grid"></div>
    </div>
</div>
<script>
(() => {
    ${buildSharedThemeScript(baseUrl, token)}

    let snapshot = { activeId: "", viewMode: "picker", openTabOrder: [], accounts: [] };
    let videosList = [];
    let currentVideoId = "";
    let editingId = null;
    let confirmDelId = null;
    let deferredAccountsRender = false;
    let busyId = null;
    let isVisible = true;

    const bgVideo = document.getElementById("bg-video");
    const bgImg = document.getElementById("bg-img");
    const banner = document.getElementById("banner");
    const bannerText = document.getElementById("banner-text");

    function showBanner(text, isErr = false, isLoading = false) {
        if (bannerText) bannerText.textContent = text || "";
        banner.classList.toggle("show", Boolean(text));
        banner.classList.toggle("error", Boolean(isErr));
        banner.classList.toggle("loading", Boolean(isLoading && !isErr));
    }

    function applyWallpaper() {
        const bgDimEl = typeof document.querySelector === "function" ? document.querySelector(".bg-dim") : null;
        if (themeState.wallpaperEnabled === false) {
            currentVideoId = "";
            try { bgVideo.pause(); bgVideo.removeAttribute("src"); bgVideo.load(); } catch {}
            try { bgImg.removeAttribute("src"); } catch {}
            bgVideo.style.display = "none";
            bgImg.style.display = "none";
            if (bgDimEl) bgDimEl.style.display = "none";
            return;
        }
        if (bgDimEl) bgDimEl.style.display = "";
        const filters = [];
        if (themeState.videoBlur > 0) filters.push("blur(" + themeState.videoBlur + "px)");
        if (Math.abs(themeState.videoSat - 1) > 0.01) filters.push("saturate(" + themeState.videoSat + ")");
        if (Math.abs(themeState.videoContrast - 1) > 0.01) filters.push("contrast(" + themeState.videoContrast + ")");
        const filterStr = filters.join(" ") || "none";
        bgVideo.style.filter = filterStr;
        bgVideo.style.objectFit = themeState.videoFit || "cover";
        bgImg.style.filter = filterStr;
        bgImg.style.objectFit = themeState.videoFit || "cover";

        const hiddenSet = new Set(Array.isArray(themeState.hiddenIds) ? themeState.hiddenIds : []);
        const filteredVideos = videosList.filter((v) => {
            if (!v) return false;
            if (hiddenSet.has(v.id)) return false;
            if (themeState.hideMature && v.isMature) return false;
            if (themeState.hideLowRes && v.isLowRes) return false;
            if (themeState.mediaFilter === "video" && v.kind !== "video") return false;
            if (themeState.mediaFilter === "image" && v.kind === "video") return false;
            return true;
        });

        if (!filteredVideos.length) {
            currentVideoId = "";
            try { bgVideo.pause(); bgVideo.removeAttribute("src"); bgVideo.load(); } catch {}
            bgVideo.style.display = "none";
            bgImg.style.display = "none";
            return;
        }
        let item = themeState.currentId ? filteredVideos.find((v) => v.id === themeState.currentId) : null;
        if (!item) item = filteredVideos[themeState.currentIndex] || filteredVideos[0];
        if (!item) return;

        const allowVideoPlayback = isVisible && !themeState.staticWallpaperMode;
        if (item.id !== currentVideoId) {
            currentVideoId = item.id;
            const src = withToken(BASE_URL + "/stream/" + item.index);
            if (item.kind === "video") {
                bgImg.style.display = "none";
                bgVideo.style.display = "block";
                bgVideo.src = src;
                bgVideo.muted = true;
                bgVideo.playbackRate = themeState.playbackRate || 1.0;
                if (allowVideoPlayback) bgVideo.play().catch(() => {});
                else { try { bgVideo.pause(); } catch {} }
            } else {
                try { bgVideo.pause(); bgVideo.removeAttribute("src"); bgVideo.load(); } catch {}
                bgVideo.style.display = "none";
                bgImg.src = src;
                bgImg.style.display = "block";
            }
        } else if (item.kind === "video") {
            bgVideo.playbackRate = themeState.playbackRate || 1.0;
            if (allowVideoPlayback) bgVideo.play().catch(() => {});
            else { try { bgVideo.pause(); } catch {} }
        }
    }

    window.addEventListener("agy-tab-visibility", (e) => {
        isVisible = Boolean(e.detail?.visible);
        if (themeState.wallpaperEnabled !== false && isVisible && !themeState.staticWallpaperMode) {
            if (bgVideo.style.display === "block") bgVideo.play().catch(() => {});
        } else {
            try { bgVideo.pause(); } catch {}
        }
    });

    function formatRelativeTime(ts, ru) {
        if (!ts) return ru ? "нет данных" : "no data";
        const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diffSec < 45) return ru ? "только что" : "just now";
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return ru ? (diffMin + " мин назад") : (diffMin + "m ago");
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return ru ? (diffHr + " ч назад") : (diffHr + "h ago");
        const d = new Date(ts);
        return d.toLocaleDateString(ru ? "ru-RU" : "en-US", { day: "2-digit", month: "2-digit" }) + " " +
            d.toLocaleTimeString(ru ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit" });
    }

    function formatResetTime(resetStr, ru) {
        if (!resetStr) return "";
        const ts = Date.parse(resetStr);
        if (!Number.isFinite(ts)) return resetStr;
        const diffMs = ts - Date.now();
        if (diffMs <= 0) return ru ? "сброс скоро" : "resets soon";
        const mins = Math.ceil(diffMs / 60000);
        if (mins < 60) return (ru ? "сброс " : "reset ") + mins + (ru ? "м" : "m");
        const hrs = Math.floor(mins / 60);
        const remM = mins % 60;
        if (hrs < 48) return (ru ? "сброс " : "reset ") + hrs + (ru ? "ч " : "h ") + remM + (ru ? "м" : "m");
        const days = Math.floor(hrs / 24);
        return (ru ? "сброс " : "reset ") + days + (ru ? "д" : "d");
    }

    function renderQuotas(acc, ru) {
        const box = document.createElement("div");
        box.className = "quotas-box";

        const tierLabel = acc.tier?.planName || acc.tier?.name || (ru ? "Тариф не загружен" : "Plan not synced");
        const freshness = acc.isLiveQuota
            ? (ru ? "В реальном времени" : "Live")
            : (acc.quotaUpdatedAt ? ((ru ? "Обновлено " : "Updated ") + formatRelativeTime(acc.quotaUpdatedAt, ru)) : "");

        const hdr = document.createElement("div");
        hdr.className = "quotas-hdr";
        hdr.innerHTML =
            '<span class="tier-name">' + esc(tierLabel) + '</span>' +
            '<span>' + esc(freshness) + '</span>';
        box.appendChild(hdr);

        const rawQuotas = Array.isArray(acc.quotas) ? acc.quotas : [];
        const quotas = typeof normalizeQuotasForTier === "function" ? normalizeQuotasForTier(rawQuotas, acc.tier) : rawQuotas;
        if (quotas.length === 0) {
            const empty = document.createElement("div");
            empty.className = "q-empty";
            empty.textContent = acc.tabOpen
                ? (ru ? "Загрузка квот из активной сессии..." : "Loading quotas from active session...")
                : (ru ? "Откройте аккаунт один раз, чтобы сохранить снимок тарифа и квот по моделям." : "Open this account once to capture its plan & model quotas.");
            box.appendChild(empty);
            return box;
        }

        const localizePoolLabel = (lbl) => {
            if (!ru) return lbl;
            if (lbl === "Gemini Models") return "Модели Gemini";
            if (lbl === "Claude & GPT") return "Модели Claude и GPT";
            if (lbl === "Claude Models") return "Модели Claude";
            if (lbl === "GPT Models") return "Модели GPT";
            if (lbl === "Gemini & Argon" || lbl === "Gemini & Argon Models") return "Модели Gemini и Argon";
            if (lbl === "Orchestrator") return "Оркестратор";
            return lbl;
        };

        // Display grouped quota pools cleanly
        for (const q of quotas.slice(0, 6)) {
            const pct = q.remainingFraction >= 0 ? Math.round(q.remainingFraction * 100) : null;
            let barColor = "rgb(var(--agy-accent-rgb))";
            if (pct !== null && pct <= 15) barColor = "var(--agy-danger-fg, #ef4444)";
            else if (pct !== null && pct <= 40) barColor = "var(--agy-warn-fg, #f59e0b)";
            const resetTxt = q.resetTime && q.resetTime !== "[object Object]" ? formatResetTime(q.resetTime, ru) : "";

            const row = document.createElement("div");
            row.className = "q-row";
            row.innerHTML =
                '<div class="q-label-line">' +
                    '<span class="q-model">' + esc(localizePoolLabel(q.label)) + '</span>' +
                    '<span class="q-val">' + (pct !== null ? (pct + "%") : "—") + (resetTxt ? (" · " + esc(resetTxt)) : "") + '</span>' +
                '</div>' +
                '<div class="q-track"><div class="q-fill" style="width:' + (pct !== null ? Math.max(2, pct) : 0) + '%;background:' + barColor + ';"></div></div>';
            box.appendChild(row);
        }
        return box;
    }

    function openAccount(id) {
        if (busyId) return;
        const ru = themeState.lang !== "en";
        busyId = id;
        showBanner(ru
            ? "Запуск изолированного сервера аккаунта... Обычно это занимает 3–10 секунд, процесс не завис."
            : "Starting isolated account server... This usually takes 3–10 seconds.", false, true);
        render();
        apiFetch("/tabs/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        })
            .then((r) => r.json())
            .then((res) => {
                if (!res || !res.ok) {
                    showBanner(res?.message || (ru ? "Не удалось открыть аккаунт" : "Failed to open account"), true);
                } else {
                    showBanner("");
                }
            })
            .catch((err) => showBanner(String(err), true))
            .finally(() => {
                busyId = null;
                render();
            });
    }

    function render() {
        const ru = themeState.lang !== "en";
        document.getElementById("hdr-title").textContent = ru ? "Выбор аккаунта" : "Account Picker";
        document.getElementById("hdr-sub").textContent = ru
            ? "Изолированные профили Google с отдельными тарифами, лимитами и фоновой работой в одном окне"
            : "Isolated Google profiles with separate plans, model quotas, and background tabs in one window";
        document.getElementById("new-label").placeholder = ru ? "Метка нового аккаунта..." : "New account label...";
        document.getElementById("lbl-add").textContent = ru ? "Добавить аккаунт" : "Add account";
        document.getElementById("btn-lang").textContent = ru ? "RU" : "EN";

        const grid = document.getElementById("grid");
        grid.innerHTML = "";
        const list = snapshot.accounts || [];
        const isWin = snapshot.platform === "win32";

        for (const acc of list) {
            const st = getStatusMeta(acc, ru);
            const title = getAccountTitle(acc, ru);
            const isDefault = acc.id === "default";
            const isStarting = acc.status === "starting" || busyId === acc.id;

            const card = document.createElement("div");
            card.className = "card" + (acc.tabOpen ? " is-open" : "");

            // Top: Avatar + Name + Email
            const top = document.createElement("div");
            top.className = "card-top";
            if (editingId !== acc.id) {
                top.onclick = () => openAccount(acc.id);
            }

            const av = document.createElement("div");
            av.className = "av";
            if (acc.avatar) av.innerHTML = '<img src="' + esc(acc.avatar) + '" alt="">';
            else av.textContent = getInitials(acc);

            const ident = document.createElement("div");
            ident.className = "ident";
            if (editingId === acc.id) {
                const inp = document.createElement("input");
                inp.className = "rename-inp";
                inp.value = acc.customLabel || acc.displayName || "";
                inp.placeholder = ru ? "Название..." : "Label...";
                let renameDone = false;
                const cancelRename = () => {
                    if (renameDone) return;
                    renameDone = true;
                    editingId = null;
                    deferredAccountsRender = false;
                    render();
                };
                const commit = () => {
                    if (renameDone) return;
                    renameDone = true;
                    editingId = null;
                    deferredAccountsRender = false;
                    apiFetch("/accounts/rename", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, label: inp.value }),
                    }).catch(() => {});
                    render();
                };
                inp.onkeydown = (ev) => {
                    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
                    if (ev.key === "Escape") { ev.preventDefault(); cancelRename(); }
                };
                inp.onblur = () => commit();
                ident.appendChild(inp);
                setTimeout(() => inp.focus(), 10);
            } else {
                const dispTitle = formatPrivacyValue(title, title.includes("@"));
                const rawEmailLine = acc.email || (isDefault ? (isWin ? (ru ? "Основная сессия Windows" : "Primary Windows session") : (ru ? "Основная сессия" : "Primary session")) : (ru ? "Вход в Google при открытии" : "Sign in to Google on open"));
                const dispEmailLine = formatPrivacyValue(rawEmailLine, Boolean(acc.email));
                ident.innerHTML =
                    '<div class="ident-name' + (title.includes("@") ? ' is-email' : '') + '">' + esc(dispTitle) + '</div>' +
                    '<div class="ident-email">' + esc(dispEmailLine) + '</div>';
            }
            top.append(av, ident);

            // Meta tags: Live Status + Profile Isolation
            const metaRow = document.createElement("div");
            metaRow.className = "meta-row";

            const stTag = document.createElement("span");
            stTag.className = "tag";
            stTag.innerHTML = '<span class="st-sq ' + esc(st.key) + '" style="background:' + esc(st.color) + ';"></span><span>' + esc(st.label) + '</span>';

            const isoTag = document.createElement("span");
            if (isDefault) {
                isoTag.className = "tag tag-muted";
                isoTag.textContent = ru ? "Основной пользователь" : "Primary user";
            } else if (!isWin) {
                isoTag.className = "tag tag-muted";
                isoTag.textContent = ru ? "Изолированный профиль" : "Isolated profile";
            } else if (acc.isolationReady && acc.winUser) {
                isoTag.className = "tag tag-muted";
                isoTag.textContent = "Windows: " + acc.winUser;
            } else {
                isoTag.className = "tag tag-warn";
                isoTag.textContent = ru ? "Требуется настройка изоляции" : "Needs isolation setup";
            }
            metaRow.append(stTag, isoTag);

            // Quotas Box
            const quotasBox = renderQuotas(acc, ru);

            // Footer actions
            const foot = document.createElement("div");
            foot.className = "card-foot";

            const openBtn = document.createElement("button");
            openBtn.className = "btn btn-primary";
            openBtn.disabled = isStarting;
            openBtn.textContent = isStarting
                ? (ru ? "Запуск..." : "Starting...")
                : (acc.tabOpen ? (ru ? "Переключиться" : "Switch to tab") : (ru ? "Открыть вкладку" : "Open tab"));
            openBtn.onclick = () => openAccount(acc.id);

            const acts = document.createElement("div");
            acts.className = "icon-acts";

            if (acc.tabOpen || acc.lsRunning) {
                const stopBtn = document.createElement("button");
                stopBtn.className = "icon-btn";
                stopBtn.title = ru ? "Закрыть вкладку и остановить сервер" : "Close tab & stop server";
                stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
                stopBtn.onclick = (e) => {
                    e.stopPropagation();
                    apiFetch("/tabs/close", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, stopServer: true }),
                    }).catch(() => {});
                };
                acts.appendChild(stopBtn);
            }

            if (isWin && !isDefault && acc.isolationReady) {
                const folderBtn = document.createElement("button");
                folderBtn.className = "icon-btn";
                folderBtn.title = ru ? "Выдать этому аккаунту доступ к папке проекта" : "Grant project folder access";
                folderBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
                folderBtn.onclick = (e) => {
                    e.stopPropagation();
                    apiFetch("/accounts/grant-folder", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id }),
                    }).then((r) => r.json()).then((res) => {
                        if (res?.ok && res.folder) {
                            showBanner((ru ? "Доступ выдан к папке: " : "Access granted to: ") + res.folder);
                        } else if (res && !res.canceled && !res.ok) {
                            showBanner(res.message || (ru ? "Не удалось выдать доступ" : "Could not grant folder access"), true);
                        }
                    }).catch(() => {});
                };
                acts.appendChild(folderBtn);
            }

            const renBtn = document.createElement("button");
            renBtn.className = "icon-btn";
            renBtn.title = ru ? "Переименовать" : "Rename";
            renBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
            renBtn.onclick = (e) => {
                e.stopPropagation();
                confirmDelId = null;
                editingId = acc.id;
                render();
            };
            acts.appendChild(renBtn);

            if (!isDefault) {
                const delBtn = document.createElement("button");
                const confirming = confirmDelId === acc.id;
                delBtn.className = "icon-btn danger";
                delBtn.title = confirming ? (isWin ? (ru ? "Подтвердить удаление пользователя Windows и данных" : "Confirm deletion") : (ru ? "Подтвердить удаление профиля и данных" : "Confirm deletion")) : (ru ? "Удалить аккаунт" : "Delete account");
                delBtn.innerHTML = confirming
                    ? (ru ? "Удалить?" : "Confirm?")
                    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!confirming) { confirmDelId = acc.id; render(); return; }
                    confirmDelId = null;
                    showBanner(isWin
                        ? (ru ? "Удаление изолированного профиля Windows (подтвердите UAC)..." : "Removing isolated Windows profile (confirm UAC)...")
                        : (ru ? "Удаление изолированного профиля и данных..." : "Removing isolated profile and data..."));
                    apiFetch("/accounts/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, purgeData: true }),
                    }).then((r) => r.json()).then((res) => {
                        if (!res?.ok) showBanner(res?.message || (ru ? "Удаление отменено или завершилось ошибкой" : "Delete failed or cancelled"), true);
                        else showBanner("");
                    }).catch((err) => showBanner(String(err), true));
                };
                acts.appendChild(delBtn);
            }

            foot.append(openBtn, acts);
            card.append(top, metaRow, quotasBox, foot);

            if (acc.lastError) {
                const errEl = document.createElement("div");
                errEl.style.cssText = "font-size:0.78em;color:var(--agy-danger-fg, #fca5a5);line-height:1.35;";
                errEl.textContent = themeState.privacyMode ? maskSensitiveString(acc.lastError, themeState.privacyHidePaths) : acc.lastError;
                card.appendChild(errEl);
            }
            grid.appendChild(card);
        }
    }

    document.getElementById("add-form").onsubmit = (e) => {
        e.preventDefault();
        const ru = themeState.lang !== "en";
        const inp = document.getElementById("new-label");
        const btn = document.getElementById("btn-add");
        if (btn.disabled) return;
        const label = inp.value.trim();
        inp.value = "";
        btn.disabled = true;
        const isWin = snapshot.platform === "win32";
        showBanner(isWin
            ? (ru
                ? "Создание изолированного пользователя Windows... Это занимает 5–15 секунд, не закрывайте окно. Подтвердите запрос UAC, если он появился."
                : "Provisioning isolated Windows user... This takes 5–15 seconds. Confirm the UAC prompt if shown.")
            : (ru
                ? "Создание изолированного профиля и запуск сервера аккаунта..."
                : "Creating isolated profile and starting account server..."), false, true);
        const slowHint = setTimeout(() => {
            if (btn.disabled) {
                showBanner(ru
                    ? "Настройка прав доступа и первый запуск сервера аккаунта... Процесс работает, вкладка откроется автоматически."
                    : "Configuring permissions and launching account server... Still working, tab will open automatically.", false, true);
            }
        }, 5500);
        apiFetch("/accounts/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label, openInNewWindow: false }),
        })
            .then((r) => r.json())
            .then((res) => {
                if (!res || !res.ok) {
                    const msg = res?.error === "uac_cancelled"
                        ? (ru ? "Запрос UAC отменён — аккаунт не создан." : "UAC prompt cancelled — account not created.")
                        : (res?.message || (ru ? "Не удалось создать аккаунт" : "Failed to create account"));
                    showBanner(msg, true, false);
                } else {
                    showBanner("");
                }
            })
            .catch((err) => showBanner(String(err), true, false))
            .finally(() => { clearTimeout(slowHint); btn.disabled = false; });
    };

    document.getElementById("btn-lang").onclick = () => {
        const next = themeState.lang === "en" ? "ru" : "en";
        themeState.lang = next;
        render();
        Promise.all([
            apiFetch("/extras/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lang: next }),
            }),
            apiFetch("/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lang: next }),
            }),
        ]).catch(() => {});
    };

    function refreshAll() {
        Promise.all([
            apiFetch("/config").then((r) => r.json()).catch(() => ({})),
            apiFetch("/extras/config").then((r) => r.json()).catch(() => ({})),
            apiFetch("/list").then((r) => r.json()).catch(() => ({ videos: [] })),
            apiFetch("/accounts/list").then((r) => r.json()).catch(() => null),
            apiFetch("/fonts/list").then((r) => r.json()).catch(() => ({ fonts: [] })),
        ]).then(([cfg, ex, listData, accRes, fontRes]) => {
            if (fontRes && Array.isArray(fontRes.fonts)) registerShellCustomFonts(fontRes.fonts);
            hydrateTheme(cfg, ex);
            applySharedThemeVars();
            videosList = Array.isArray(listData?.videos) ? listData.videos : [];
            applyWallpaper();
            if (accRes && Array.isArray(accRes.accounts)) snapshot = accRes;
            render();
        });
    }

    refreshAll();
    setInterval(() => { if (!document.hidden) { if (isVisible && !editingId && !confirmDelId) render(); } }, 30000);

    // Custom tooltips in Picker view (replaces native OS title popups)
    (() => {
        const tipEl = document.createElement("div");
        tipEl.setAttribute("role", "tooltip");
        tipEl.style.cssText = [
            "position:fixed", "z-index:2147483647", "pointer-events:none",
            "opacity:0", "transition:opacity 0.12s ease", "visibility:hidden",
            "padding:5px 9px", "max-width:min(320px,85vw)", "line-height:1.35",
            "border-radius:var(--agy-radius-sm,7px)",
            "background:var(--agy-surface-popover,rgba(var(--agy-tint-rgb,14,17,24),var(--agy-surface-modal-alpha,0.92)))",
            "border:1px solid var(--agy-border-strong,rgba(255,255,255,0.22))",
            "box-shadow:var(--agy-shadow-panel,0 10px 28px rgba(0,0,0,0.42))",
            "color:var(--agy-text-primary,#f1f5f9)",
            "font-family:var(--agy-ui-font,'Segoe UI Variable','Segoe UI',system-ui,sans-serif)",
            "font-size:calc(var(--agy-base-font-size,14px) * 0.84)",
            "font-weight:500", "white-space:normal", "word-break:break-word",
        ].join(";");
        document.body.appendChild(tipEl);

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
        document.addEventListener("pointerover", (e) => {
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
        document.addEventListener("pointerout", (e) => {
            if (!activeEl) return;
            if (e.relatedTarget && activeEl.contains && activeEl.contains(e.relatedTarget)) return;
            hideTip();
        }, true);
        document.addEventListener("pointerdown", hideTip, true);
        window.addEventListener("blur", hideTip);
        window.addEventListener("keydown", hideTip, true);
    })();

    try {
        const es = new EventSource(withToken(BASE_URL + "/events"));
        es.addEventListener("fonts", (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                if (payload && Array.isArray(payload.fonts)) registerShellCustomFonts(payload.fonts);
            } catch {}
        });
        es.addEventListener("accounts", (ev) => {
            try {
                const data = JSON.parse(ev.data);
                if (data && Array.isArray(data.accounts)) {
                    snapshot = data;
                    if (editingId || confirmDelId) {
                        deferredAccountsRender = true;
                    } else {
                        deferredAccountsRender = false;
                        render();
                    }
                }
            } catch {}
        });
        es.addEventListener("config", (ev) => {
            try {
                const cfg = JSON.parse(ev.data);
                const prevSig = [themeState.lang, themeState.privacyMode, themeState.privacyHideStyle, themeState.privacyRevealMode, themeState.privacyHidePaths].join("|");
                hydrateTheme(cfg, null);
                applySharedThemeVars();
                applyWallpaper();
                const nextSig = [themeState.lang, themeState.privacyMode, themeState.privacyHideStyle, themeState.privacyRevealMode, themeState.privacyHidePaths].join("|");
                if (nextSig !== prevSig && !editingId && !confirmDelId) render();
            } catch {}
        });
        es.addEventListener("extras", (ev) => {
            try {
                const ex = JSON.parse(ev.data);
                const prevLang = themeState.lang;
                hydrateTheme(null, ex);
                applySharedThemeVars();
                if (themeState.lang !== prevLang) render();
            } catch {}
        });
        window.addEventListener("pagehide", () => { try { es.close(); } catch {} });
    } catch {}
})();
</script>
</body>
</html>`;
}

module.exports = {
    renderTabBarHtml,
    renderPickerHtml,
};
