"use strict";
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
} = require("./agyUiContrast");

function buildContrastHelpersSnippet() {
    return [
        parseRgb,
        relativeLuminance,
        contrastRatio,
        blendRgbOver,
        rgbToHex,
        getAccessibleTextPalette,
        ensureReadableAccentOnSurface,
        normalizeAdaptiveAccent,
        getAdaptiveThemeTokens,
    ].map((fn) => fn.toString()).join("\n");
}

function buildSharedThemeScript(baseUrl) {
    return `
    const BASE_URL = ${JSON.stringify(baseUrl)};
    ${buildContrastHelpersSnippet()}

    const FONT_MAP = {
        system: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
        inter: "'Inter', 'Segoe UI Variable', system-ui, sans-serif",
        jetbrains: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        cascadia: "'Cascadia Code', Consolas, monospace",
        segoe: "'Segoe UI', Tahoma, sans-serif",
    };

    const themeState = {
        lang: "ru",
        accentRgb: "96, 165, 250",
        tintRgb: "12, 14, 20",
        customAccentHex: "#60a5fa",
        adaptiveAccent: true,
        panelAlpha: 0.72,
        dim: 0.36,
        videoBlur: 0,
        videoSat: 1.0,
        videoContrast: 1.0,
        videoFit: "cover",
        playbackRate: 1.0,
        fontSizePx: 14,
        radiusPx: 10,
        uiFontChoice: "system",
        currentId: "",
        currentIndex: 0,
        videoMuted: true,
        videoVolume: 0,
    };

    function hexToRgbStr(hex) {
        const clean = String(hex || "").replace("#", "").trim();
        if (!/^[0-9a-fA-F]{6}$/.test(clean)) return "96, 165, 250";
        return parseInt(clean.slice(0, 2), 16) + ", " + parseInt(clean.slice(2, 4), 16) + ", " + parseInt(clean.slice(4, 6), 16);
    }

    function hydrateTheme(cfg, extras) {
        if (cfg && typeof cfg === "object") {
            if (cfg.lang === "en" || cfg.lang === "ru") themeState.lang = cfg.lang;
            if (typeof cfg.customAccentHex === "string" && /^#[0-9a-fA-F]{6}$/.test(cfg.customAccentHex)) themeState.customAccentHex = cfg.customAccentHex;
            if (typeof cfg.adaptiveAccent === "boolean") themeState.adaptiveAccent = cfg.adaptiveAccent;
            if (typeof cfg.accentRgb === "string" && cfg.accentRgb) themeState.accentRgb = cfg.accentRgb;
            if (typeof cfg.tintRgb === "string" && cfg.tintRgb) themeState.tintRgb = cfg.tintRgb;
            if (Number.isFinite(Number(cfg.panelAlpha))) themeState.panelAlpha = Math.max(0.25, Math.min(0.96, Number(cfg.panelAlpha)));
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
            if (typeof cfg.privacyMode === "boolean") themeState.privacyMode = cfg.privacyMode;
        }
        if (extras && typeof extras === "object") {
            if (extras.lang === "en" || extras.lang === "ru") themeState.lang = extras.lang;
        }
    }

    function applySharedThemeVars() {
        const root = document.documentElement;
        const accentRgb = themeState.adaptiveAccent && themeState.accentRgb
            ? themeState.accentRgb
            : hexToRgbStr(themeState.customAccentHex);
        const tintRgb = themeState.tintRgb || "12, 14, 20";
        const tokens = getAdaptiveThemeTokens(tintRgb, accentRgb, 0.24);
        const surf = tokens.surface || {};
        const r = Math.round(themeState.radiusPx);
        const rSm = Math.max(0, Math.round(r * 0.7));
        const font = FONT_MAP[themeState.uiFontChoice] || themeState.uiFontChoice || FONT_MAP.system;

        root.style.setProperty("--agy-accent-rgb", accentRgb);
        root.style.setProperty("--agy-tint-rgb", tintRgb);
        root.style.setProperty("--agy-ui-font", font);
        root.style.setProperty("--agy-base-font-size", themeState.fontSizePx + "px");
        root.style.setProperty("--agy-radius", r + "px");
        root.style.setProperty("--agy-radius-sm", rSm + "px");
        root.style.setProperty("--agy-panel-alpha", String(themeState.panelAlpha));
        root.dataset.agyPrivacy = themeState.privacyMode ? "1" : "0";
        root.style.setProperty("--agy-wp-dim", String(themeState.dim));
        root.style.setProperty("--agy-text-primary", surf.primary || "#f1f5f9");
        root.style.setProperty("--agy-text-muted", surf.secondary || "#cbd5e1");
        root.style.setProperty("--agy-text-subtle", surf.subtle || "#94a3b8");
        root.style.setProperty("--agy-border", surf.border || "rgba(255,255,255,0.14)");
        root.style.setProperty("--agy-on-solid-accent", tokens.onSolidAccent || "#000000");
        root.style.setProperty("--agy-on-tinted-accent", tokens.onTintedAccent || "#ffffff");
        root.style.setProperty("--agy-accent-text", tokens.accentText || "#93c5fd");
        return tokens;
    }

    function esc(s) {
        return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
        if (st === "waiting") return { key: "waiting", label: ru ? "Ждёт ответа" : "Waiting", color: "#f59e0b" };
        if (st === "working") {
            const n = Number(acc?.activeAgentCount || 0);
            return {
                key: "working",
                label: n > 1 ? (ru ? ("Работает (" + n + ")") : ("Working (" + n + ")")) : (ru ? "Работает" : "Working"),
                color: "rgb(var(--agy-accent-rgb))",
            };
        }
        if (st === "error") return { key: "error", label: ru ? "Ошибка" : "Error", color: "#ef4444" };
        if (st === "ready" || acc?.tabOpen || acc?.lsRunning) return { key: "ready", label: ru ? "Готов" : "Ready", color: "#22c55e" };
        return { key: "stopped", label: ru ? "Не запущен" : "Stopped", color: "var(--agy-text-subtle)" };
    }
    `;
}

function renderTabBarHtml(port) {
    const baseUrl = `http://127.0.0.1:${Number(port)}`;
    return `<!doctype html>
<html lang="ru">
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
        --agy-text-primary: #f1f5f9;
        --agy-text-muted: #94a3b8;
        --agy-text-subtle: #64748b;
        --agy-border: rgba(255, 255, 255, 0.12);
        --agy-on-tinted-accent: #ffffff;
        --agy-accent-text: #93c5fd;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: rgb(var(--agy-tint-rgb));
        color: var(--agy-text-primary);
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
        background: rgba(var(--agy-tint-rgb), 0.96);
        border-bottom: 1px solid var(--agy-border);
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
        background: rgba(255, 255, 255, 0.05);
        color: var(--agy-text-primary);
        font: inherit;
        font-size: 0.84em;
        font-weight: 600;
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.12s ease, border-color 0.12s ease;
    }
    .picker-btn:hover {
        background: rgba(255, 255, 255, 0.11);
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
        background: rgba(255, 255, 255, 0.04);
        color: var(--agy-text-muted);
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .tab:hover {
        background: rgba(255, 255, 255, 0.09);
        color: var(--agy-text-primary);
    }
    .tab.active {
        background: rgba(var(--agy-accent-rgb), 0.19);
        border-color: rgba(var(--agy-accent-rgb), 0.58);
        color: var(--agy-text-primary);
    }
    .tab-av {
        width: 20px;
        height: 20px;
        border-radius: calc(var(--agy-radius-sm) * 0.65);
        background: rgba(255, 255, 255, 0.11);
        color: var(--agy-text-primary);
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
    html[data-agy-privacy="1"] .tab-email {
        filter: blur(4.5px);
        opacity: 0.78;
        transition: filter 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
    }
    html[data-agy-privacy="1"] .tab:hover .tab-email,
    html[data-agy-privacy="1"] .tab-email:hover {
        filter: none;
        opacity: 1;
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
        transition: background 0.1s ease, opacity 0.1s ease, color 0.1s ease;
    }
    .tab-close:hover {
        background: rgba(239, 68, 68, 0.24);
        color: #fca5a5;
        opacity: 1;
    }
    .add-btn {
        -webkit-app-region: no-drag;
        width: 28px;
        height: calc(100% - 8px);
        border-radius: var(--agy-radius-sm);
        border: 1px solid transparent;
        background: transparent;
        color: var(--agy-text-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.12s ease, color 0.12s ease;
    }
    .add-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: var(--agy-text-primary);
    }
    .hint {
        font-size: 0.78em;
        color: var(--agy-text-muted);
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
        color: var(--agy-text-subtle);
        cursor: pointer;
        -webkit-app-region: no-drag;
        transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .tab-add-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: var(--agy-border);
        color: var(--agy-text-primary);
    }
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
    ${buildSharedThemeScript(baseUrl)}

    let snapshot = { activeId: "", viewMode: "picker", openTabOrder: [], accounts: [] };
    let lastReportedHeight = 0;

    function syncBarHeight() {
        const target = Math.max(36, Math.min(54, Math.round(themeState.fontSizePx * 2.85)));
        if (target !== lastReportedHeight) {
            lastReportedHeight = target;
            fetch(BASE_URL + "/tabs/bar-height", {
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
            tab.title = title + (acc.email ? " (" + acc.email + ")" : "") + (showActiveStatus ? (" — " + st.label) : "");

            const av = document.createElement("div");
            av.className = "tab-av";
            if (acc.avatar) av.innerHTML = '<img src="' + esc(acc.avatar) + '" alt="">';
            else av.textContent = getInitials(acc);

            const meta = document.createElement("div");
            meta.className = "tab-meta";
            meta.innerHTML =
                '<div class="tab-name-row">' +
                    '<span class="tab-name">' + esc(title) + '</span>' +
                '</div>' +
                '<div class="tab-sub">' +
                    (showActiveStatus ? ('<span class="st-text" style="color:' + st.color + ';">' + esc(st.label) + '</span>' + (subEmail ? '<span>·</span>' : '')) : '') +
                    (subEmail ? '<span class="tab-email" style="overflow:hidden;text-overflow:ellipsis;">' + esc(subEmail) + '</span>' : (!showActiveStatus ? '<span>' + esc(st.label) + '</span>' : '')) +
                '</div>';

            const closeBtn = document.createElement("button");
            closeBtn.className = "tab-close";
            closeBtn.title = ru ? "Закрыть вкладку и остановить сервер" : "Close tab & stop server";
            closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                fetch(BASE_URL + "/tabs/close", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id }),
                }).catch(() => {});
            };

            tab.onclick = () => {
                fetch(BASE_URL + "/tabs/open", {
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
            fetch(BASE_URL + "/tabs/show-picker", { method: "POST" }).catch(() => {});
        };
        tabsEl.appendChild(addBtn);
    }

    document.getElementById("btn-picker").onclick = () => {
        fetch(BASE_URL + "/tabs/show-picker", { method: "POST" }).catch(() => {});
    };

    function refreshAll() {
        Promise.all([
            fetch(BASE_URL + "/config").then((r) => r.json()).catch(() => ({})),
            fetch(BASE_URL + "/extras/config").then((r) => r.json()).catch(() => ({})),
            fetch(BASE_URL + "/accounts/list").then((r) => r.json()).catch(() => null),
        ]).then(([cfg, ex, accRes]) => {
            hydrateTheme(cfg, ex);
            applySharedThemeVars();
            syncBarHeight();
            if (accRes && Array.isArray(accRes.accounts)) snapshot = accRes;
            render();
        });
    }

    refreshAll();

    try {
        const es = new EventSource(BASE_URL + "/events");
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
                hydrateTheme(cfg, null);
                applySharedThemeVars();
                syncBarHeight();
                render();
            } catch {}
        });
        es.addEventListener("extras", (ev) => {
            try {
                const ex = JSON.parse(ev.data);
                hydrateTheme(null, ex);
                applySharedThemeVars();
                render();
            } catch {}
        });
    } catch {}
})();
</script>
</body>
</html>`;
}

function renderPickerHtml(port) {
    const baseUrl = `http://127.0.0.1:${Number(port)}`;
    return `<!doctype html>
<html lang="ru">
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
        --agy-panel-alpha: 0.76;
        --agy-wp-dim: 0.42;
        --agy-text-primary: #f1f5f9;
        --agy-text-muted: #94a3b8;
        --agy-text-subtle: #64748b;
        --agy-border: rgba(255, 255, 255, 0.12);
        --agy-on-solid-accent: #000000;
        --agy-on-tinted-accent: #ffffff;
        --agy-accent-text: #93c5fd;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: rgb(var(--agy-tint-rgb));
        color: var(--agy-text-primary);
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
        background: rgba(var(--agy-tint-rgb), var(--agy-wp-dim));
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
        background: rgba(var(--agy-tint-rgb), var(--agy-panel-alpha));
        backdrop-filter: blur(22px);
        border: 1px solid var(--agy-border);
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
        background: rgba(255, 255, 255, 0.06);
        color: var(--agy-text-primary);
        font: inherit;
        font-size: 0.90em;
        outline: none;
    }
    .inp:focus {
        border-color: rgba(var(--agy-accent-rgb), 0.72);
    }
    .btn {
        height: 2.55em;
        padding: 0 1em;
        border-radius: var(--agy-radius-sm);
        border: 1px solid var(--agy-border);
        background: rgba(255, 255, 255, 0.07);
        color: var(--agy-text-primary);
        font: inherit;
        font-size: 0.88em;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        transition: background 0.12s ease, border-color 0.12s ease;
    }
    .btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.13);
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
    }
    .banner {
        display: none;
        padding: 12px 15px;
        border-radius: var(--agy-radius-sm);
        background: rgba(var(--agy-tint-rgb), 0.90);
        border: 1px solid rgba(var(--agy-accent-rgb), 0.55);
        font-size: 0.88em;
        line-height: 1.4;
        color: var(--agy-text-primary);
    }
    .banner.show { display: flex; flex-direction: column; gap: 8px; }
    .banner.error { border-color: rgba(239, 68, 68, 0.65); color: #fecaca; }
    .banner-bar {
        display: none;
        width: 100%;
        height: 3px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.12);
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
        background: rgba(var(--agy-tint-rgb), var(--agy-panel-alpha));
        backdrop-filter: blur(22px);
        border: 1px solid var(--agy-border);
        transition: border-color 0.14s ease, background 0.14s ease;
    }
    .card:hover {
        border-color: rgba(var(--agy-accent-rgb), 0.52);
    }
    .card.is-open {
        border-color: rgba(var(--agy-accent-rgb), 0.68);
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
        background: rgba(255, 255, 255, 0.10);
        color: var(--agy-text-primary);
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
    html[data-agy-privacy="1"] .ident-email {
        filter: blur(5px);
        opacity: 0.82;
        user-select: none;
    }
    html[data-agy-privacy="1"] .acc-card:hover .ident-email,
    html[data-agy-privacy="1"] .ident-email:hover {
        filter: none;
        opacity: 1;
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
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.09);
        color: var(--agy-text-primary);
        font-weight: 600;
    }
    .tag-muted {
        color: var(--agy-text-muted);
        font-weight: 500;
    }
    .tag-warn {
        border-color: rgba(245, 158, 11, 0.55);
        color: #fcd34d;
    }
    .st-sq {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        display: inline-block;
        flex-shrink: 0;
    }
    .quotas-box {
        display: flex;
        flex-direction: column;
        gap: 7px;
        padding: 10px 11px;
        border-radius: var(--agy-radius-sm);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.07);
    }
    .quotas-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.77em;
        color: var(--agy-text-muted);
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
        color: var(--agy-text-primary);
    }
    .q-val {
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        color: var(--agy-text-muted);
        font-weight: 600;
    }
    .q-track {
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.11);
        overflow: hidden;
    }
    .q-fill {
        height: 100%;
        border-radius: 2px;
    }
    .q-empty {
        font-size: 0.80em;
        color: var(--agy-text-muted);
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
        background: rgba(255, 255, 255, 0.05);
        color: var(--agy-text-muted);
        font: inherit;
        font-size: 0.82em;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        transition: background 0.12s ease, color 0.12s ease;
    }
    .icon-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: var(--agy-text-primary);
    }
    .icon-btn.danger {
        color: #f87171;
    }
    .icon-btn.danger:hover {
        background: rgba(239, 68, 68, 0.22);
        color: #fecaca;
    }
    .rename-inp {
        width: 100%;
        height: 2.1em;
        padding: 0 0.6em;
        border-radius: var(--agy-radius-sm);
        border: 1px solid rgba(var(--agy-accent-rgb), 0.7);
        background: rgba(var(--agy-tint-rgb), 0.95);
        color: var(--agy-text-primary);
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
        color: var(--agy-text-subtle);
        cursor: pointer;
        -webkit-app-region: no-drag;
        transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .tab-add-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: var(--agy-border);
        color: var(--agy-text-primary);
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
    ${buildSharedThemeScript(baseUrl)}

    let snapshot = { activeId: "", viewMode: "picker", openTabOrder: [], accounts: [] };
    let videosList = [];
    let currentVideoId = "";
    let editingId = null;
    let confirmDelId = null;
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
        const filters = [];
        if (themeState.videoBlur > 0) filters.push("blur(" + themeState.videoBlur + "px)");
        if (Math.abs(themeState.videoSat - 1) > 0.01) filters.push("saturate(" + themeState.videoSat + ")");
        if (Math.abs(themeState.videoContrast - 1) > 0.01) filters.push("contrast(" + themeState.videoContrast + ")");
        const filterStr = filters.join(" ") || "none";
        bgVideo.style.filter = filterStr;
        bgVideo.style.objectFit = themeState.videoFit || "cover";
        bgImg.style.filter = filterStr;
        bgImg.style.objectFit = themeState.videoFit || "cover";

        if (!videosList.length) return;
        let item = themeState.currentId ? videosList.find((v) => v.id === themeState.currentId) : null;
        if (!item) item = videosList[themeState.currentIndex] || videosList[0];
        if (!item) return;

        if (item.id !== currentVideoId) {
            currentVideoId = item.id;
            const src = BASE_URL + "/stream/" + item.index;
            if (item.kind === "video") {
                bgImg.style.display = "none";
                bgVideo.style.display = "block";
                bgVideo.src = src;
                bgVideo.muted = true;
                bgVideo.playbackRate = themeState.playbackRate || 1.0;
                if (isVisible) bgVideo.play().catch(() => {});
            } else {
                bgVideo.pause();
                bgVideo.style.display = "none";
                bgImg.src = src;
                bgImg.style.display = "block";
            }
        } else if (item.kind === "video") {
            bgVideo.playbackRate = themeState.playbackRate || 1.0;
            if (isVisible) bgVideo.play().catch(() => {});
            else bgVideo.pause();
        }
    }

    window.addEventListener("agy-tab-visibility", (e) => {
        isVisible = Boolean(e.detail?.visible);
        if (isVisible) {
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

        const quotas = Array.isArray(acc.quotas) ? acc.quotas : [];
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
            if (lbl === "Claude & GPT") return "Claude и GPT";
            if (lbl === "Claude Models") return "Модели Claude";
            if (lbl === "GPT Models") return "Модели GPT";
            return lbl;
        };

        // Display grouped quota pools cleanly
        for (const q of quotas.slice(0, 6)) {
            const pct = q.remainingFraction >= 0 ? Math.round(q.remainingFraction * 100) : null;
            let barColor = "rgb(var(--agy-accent-rgb))";
            if (pct !== null && pct <= 15) barColor = "#ef4444";
            else if (pct !== null && pct <= 40) barColor = "#f59e0b";
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
        fetch(BASE_URL + "/tabs/open", {
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
                const commit = () => {
                    editingId = null;
                    fetch(BASE_URL + "/accounts/rename", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, label: inp.value }),
                    }).catch(() => {});
                };
                inp.onkeydown = (ev) => {
                    if (ev.key === "Enter") commit();
                    if (ev.key === "Escape") { editingId = null; render(); }
                };
                inp.onblur = commit;
                ident.appendChild(inp);
                setTimeout(() => inp.focus(), 10);
            } else {
                ident.innerHTML =
                    '<div class="ident-name">' + esc(title) + '</div>' +
                    '<div class="ident-email">' + esc(acc.email || (isDefault ? (ru ? "Основная сессия Windows" : "Primary Windows session") : (ru ? "Вход в Google при открытии" : "Sign in to Google on open"))) + '</div>';
            }
            top.append(av, ident);

            // Meta tags: Live Status + Windows User Isolation
            const metaRow = document.createElement("div");
            metaRow.className = "meta-row";

            const stTag = document.createElement("span");
            stTag.className = "tag";
            stTag.innerHTML = '<span class="st-sq" style="background:' + st.color + ';"></span><span>' + esc(st.label) + '</span>';

            const isoTag = document.createElement("span");
            if (isDefault) {
                isoTag.className = "tag tag-muted";
                isoTag.textContent = ru ? "Основной пользователь" : "Primary user";
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
                    fetch(BASE_URL + "/tabs/close", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: acc.id, stopServer: true }),
                    }).catch(() => {});
                };
                acts.appendChild(stopBtn);
            }

            if (!isDefault && acc.isolationReady) {
                const folderBtn = document.createElement("button");
                folderBtn.className = "icon-btn";
                folderBtn.title = ru ? "Выдать этому аккаунту доступ к папке проекта" : "Grant project folder access";
                folderBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
                folderBtn.onclick = (e) => {
                    e.stopPropagation();
                    fetch(BASE_URL + "/accounts/grant-folder", {
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
                delBtn.title = confirming ? (ru ? "Подтвердить удаление пользователя Windows и данных" : "Confirm deletion") : (ru ? "Удалить аккаунт" : "Delete account");
                delBtn.innerHTML = confirming
                    ? (ru ? "Удалить?" : "Confirm?")
                    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!confirming) { confirmDelId = acc.id; render(); return; }
                    confirmDelId = null;
                    showBanner(ru ? "Удаление изолированного профиля Windows (подтвердите UAC)..." : "Removing isolated Windows profile (confirm UAC)...");
                    fetch(BASE_URL + "/accounts/delete", {
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
                errEl.style.cssText = "font-size:0.78em;color:#fca5a5;line-height:1.35;";
                errEl.textContent = acc.lastError;
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
        showBanner(ru
            ? "Создание изолированного пользователя Windows... Это занимает 5–15 секунд, не закрывайте окно. Подтвердите запрос UAC, если он появился."
            : "Provisioning isolated Windows user... This takes 5–15 seconds. Confirm the UAC prompt if shown.", false, true);
        const slowHint = setTimeout(() => {
            if (btn.disabled) {
                showBanner(ru
                    ? "Настройка прав доступа и первый запуск сервера аккаунта... Процесс работает, вкладка откроется автоматически."
                    : "Configuring permissions and launching account server... Still working, tab will open automatically.", false, true);
            }
        }, 5500);
        fetch(BASE_URL + "/accounts/add", {
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
        fetch(BASE_URL + "/extras/config")
            .then((r) => r.json())
            .catch(() => ({}))
            .then((cur) => {
                return fetch(BASE_URL + "/extras/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...(cur || {}), lang: next }),
                });
            })
            .catch(() => {});
    };

    function refreshAll() {
        Promise.all([
            fetch(BASE_URL + "/config").then((r) => r.json()).catch(() => ({})),
            fetch(BASE_URL + "/extras/config").then((r) => r.json()).catch(() => ({})),
            fetch(BASE_URL + "/list").then((r) => r.json()).catch(() => ({ videos: [] })),
            fetch(BASE_URL + "/accounts/list").then((r) => r.json()).catch(() => null),
        ]).then(([cfg, ex, listData, accRes]) => {
            hydrateTheme(cfg, ex);
            applySharedThemeVars();
            videosList = Array.isArray(listData?.videos) ? listData.videos : [];
            applyWallpaper();
            if (accRes && Array.isArray(accRes.accounts)) snapshot = accRes;
            render();
        });
    }

    refreshAll();
    setInterval(() => { if (isVisible) render(); }, 30000);

    // Custom tooltips in Picker view (replaces native OS title popups)
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
            "color:var(--text,#f1f5f9)",
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
        const es = new EventSource(BASE_URL + "/events");
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
                hydrateTheme(cfg, null);
                applySharedThemeVars();
                applyWallpaper();
                render();
            } catch {}
        });
        es.addEventListener("extras", (ev) => {
            try {
                const ex = JSON.parse(ev.data);
                hydrateTheme(null, ex);
                applySharedThemeVars();
                render();
            } catch {}
        });
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
