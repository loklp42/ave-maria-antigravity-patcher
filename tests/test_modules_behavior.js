"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

function testSyntax(relPath) {
    const full = path.join(ROOT, relPath);
    const code = fs.readFileSync(full, "utf8");
    new vm.Script(code, { filename: relPath });
}

console.log("[1/23] Checking JS syntax of all 9 autonomous modules and all 13 patched system files...");
{
    const modDir = path.join(ROOT, "customization/modules");
    const sysDir = path.join(ROOT, "customization/patched_system");
    const modFiles = fs.readdirSync(modDir).filter((f) => f.endsWith(".js")).sort();
    const sysFiles = fs.readdirSync(sysDir).filter((f) => f.endsWith(".js")).sort();
    assert.strictEqual(modFiles.length, 9, `Expected 9 autonomous modules, got ${modFiles.length}`);
    assert.strictEqual(sysFiles.length, 13, `Expected 13 patched system files, got ${sysFiles.length}`);
    for (const f of modFiles) testSyntax(path.join("customization/modules", f));
    for (const f of sysFiles) testSyntax(path.join("customization/patched_system", f));
}

// Also verify generated client bundles compile cleanly as JS
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "./paths") {
        return {
            getSharedConfigDir: () => os.tmpdir(),
            getActiveProfileName: () => "",
        };
    }
    if (request === "electron") {
        return {
            app: { getPath: () => os.tmpdir(), getVersion: () => "2.34.0", isPackaged: false },
            protocol: { registerSchemesAsPrivileged() {}, handle() {} },
            dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
            shell: { openPath() {} },
        };
    }
    return origLoad.apply(this, arguments);
};

const { buildExtrasClientJs } = require(path.join(ROOT, "customization/modules/agyExtras.js"));
const extrasBundle = buildExtrasClientJs("default", 12345);
new vm.Script(extrasBundle, { filename: "agyExtras.client.js" });
assert(extrasBundle.includes("hoverOpenPlayer"), "hoverOpenPlayer missing in client bundle");
assert(extrasBundle.includes("i-quick-prev"), "i-quick-prev missing in client bundle");
assert(extrasBundle.includes("i-quick-next"), "i-quick-next missing in client bundle");
assert(extrasBundle.includes("bar-vol-pop"), "bar-vol-pop missing in client bundle");
assert(extrasBundle.includes("setBarHoverFreeze"), "setBarHoverFreeze missing in client bundle");

// Runtime smoke test: execute buildExtrasClientJs in a minimal DOM sandbox to catch TDZ / ReferenceError bugs!
console.log("[1b/4] Runtime smoke-testing agyExtras client bundle...");
(() => {
    const mkClassList = () => {
        const s = new Set();
        return {
            add: (...a) => a.forEach((x) => s.add(x)),
            remove: (...a) => a.forEach((x) => s.delete(x)),
            toggle: (x, f) => (f === undefined ? (s.has(x) ? (s.delete(x), false) : (s.add(x), true)) : (f ? (s.add(x), true) : (s.delete(x), false))),
            contains: (x) => s.has(x),
        };
    };
    const mkEl = (tag = "div") => {
        const attrs = new Map();
        const styleMap = new Map();
        const el = {
            tagName: tag.toUpperCase(),
            nodeType: 1,
            id: "",
            innerHTML: "",
            textContent: "",
            isConnected: true,
            classList: mkClassList(),
            style: {
                setProperty: (k, v) => styleMap.set(k, String(v)),
                getPropertyValue: (k) => styleMap.get(k) || "",
            },
            dataset: {},
            setAttribute: (k, v) => attrs.set(k, String(v)),
            getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
            removeAttribute: (k) => attrs.delete(k),
            hasAttribute: (k) => attrs.has(k),
            addEventListener() {},
            removeEventListener() {},
            appendChild(c) { return c; },
            append() {},
            remove() {},
            contains: () => false,
            matches: () => false,
            closest: () => null,
            getBoundingClientRect: () => ({ top: 0, bottom: 32, left: 0, right: 300, width: 300, height: 32 }),
            querySelector: () => mkEl("div"),
            querySelectorAll: () => [],
            attachShadow: () => mkEl("shadow"),
        };
        return el;
    };
    const docEl = mkEl("html");
    const bodyEl = mkEl("body");
    const sandbox = {
        window: {
            innerWidth: 1280,
            innerHeight: 800,
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() {},
            CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
        },
        document: {
            documentElement: docEl,
            body: bodyEl,
            visibilityState: "visible",
            createElement: (t) => mkEl(t),
            createTreeWalker: () => ({ nextNode: () => null }),
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        },
        NodeFilter: { SHOW_TEXT: 4 },
        WeakMap,
        localStorage: { getItem: () => null, setItem() {} },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        performance: { now: () => 0 },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval: () => 1,
        clearInterval() {},
        console,
        Math, Date, Number, String, Boolean, Array, Object, Set, Map, JSON, RegExp, Error, Promise, parseInt, parseFloat, isFinite, encodeURIComponent,
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(extrasBundle, sandbox, { filename: "agyExtras.runtime.test.js" });
})();

console.log("[2/4] Testing custom image/video wallpaper scanner...");
const wp = require(path.join(ROOT, "customization/modules/wallpaperEngine.js"));
const tmpWpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy_custom_wp_"));
try {
    fs.writeFileSync(path.join(tmpWpDir, "sunset.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    fs.writeFileSync(path.join(tmpWpDir, "anime.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(tmpWpDir, "art.webp"), Buffer.from("RIFFxxxxWEBP"));
    fs.writeFileSync(path.join(tmpWpDir, "loop.gif"), Buffer.from("GIF89a"));
    fs.writeFileSync(path.join(tmpWpDir, "readme.txt"), "ignore me");

    const results = [];
    wp.scanCustomWallpapers(tmpWpDir, results);
    assert.strictEqual(results.length, 4, `Expected 4 custom images, got ${results.length}`);
    for (const item of results) {
        assert.strictEqual(item.kind, "image");
        assert.strictEqual(item.source, "custom");
        assert.strictEqual(item.isLowRes, false);
        assert.ok(item.mime.startsWith("image/"), `Invalid mime: ${item.mime}`);
    }
    const gifItem = results.find((r) => r.name === "loop");
    assert.strictEqual(gifItem.resLabel, "GIF");
} finally {
    fs.rmSync(tmpWpDir, { recursive: true, force: true });
}

console.log("[3/4] Testing i18n translations & project-header protection...");
const { buildI18nClientJs } = require(path.join(ROOT, "customization/modules/agyI18n.js"));
global.window = { dispatchEvent() {}, addEventListener() {} };
global.localStorage = { getItem() { return null; } };
global.document = { documentElement: null, body: null };
global.MutationObserver = class { observe() {} takeRecords() {} };
eval(buildI18nClientJs());

const expectedI18n = {
    "Welcome back, Alex. Where should we pick up?": "С возвращением, Alex. На чём мы остановились?",
    "Group By": "Группировка",
    "Sort Conversations": "Сортировка диалогов",
    "Sort Projects": "Сортировка проектов",
    "Custom Order": "Свой порядок",
    "Auto Pin": "Автозакрепление",
    "Archived Only": "Только архив",
    "Copy Content": "Копировать содержимое",
    "Download File": "Скачать файл",
    "Diff": "Дифф",
    "Open Diff": "Открыть дифф",
    "Fork": "Форк",
    "Standalone": "Автономный",
    "Worktree Name": "Имя Worktree",
    "Zoom in (+)": "Увеличить (+)",
    "Commit": "Коммит",
    "Repository": "Репозиторий",
    "2m": "2м",
    "45s": "45с",
    "The original Gemini 4 model for advanced workflows. Leaving on Nov 30.": "Оригинальная модель Gemini 4 для сложных рабочих процессов. Будет отключена 30 ноября.",
    "Leaving on Nov 30.": "Будет отключена 30 ноября.",
    "Leaving on Dec 15": "Будет отключена 15 декабря.",
    "Use Hydrogen for better quality with lower quota usage. Leaving on Nov 30.": "Используйте Hydrogen для лучшего качества при меньшем расходе квоты. Будет отключена 30 ноября.",
    "Gemini 4 Hydrogen is currently available to paid Pro and Ultra subscribers.": "Gemini 4 Hydrogen сейчас доступна подписчикам тарифов платного Pro и Ultra.",
    "Gemini 4 Argon is currently available to Ultra and paid Pro subscribers.": "Gemini 4 Argon сейчас доступна подписчикам тарифов Ultra и платного Pro.",
    "Gemini 4 Carbon is currently available to Ultra and paid Pro plan subscribers.": "Gemini 4 Carbon сейчас доступна подписчикам тарифов Ultra и платного Pro.",
    "Opus 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 30, 2026.": "Opus 5.5 доступна на платных тарифах Pro и Ultra. Доступ к сторонним моделям на вашем текущем тарифе прекратится с 30 ноября 2026 г.",
    "Sonnet 4.6 is now available on Pro plans. Third-party model access will no longer be available on your current plan starting on Dec 31, 2026.": "Sonnet 4.6 доступна на платном тарифе Pro. Доступ к сторонним моделям на вашем текущем тарифе прекратится с 31 декабря 2026 г.",
    "Gemini 4 Custom is currently available to paid Pro subscribers.": "Gemini 4 Custom сейчас доступна подписчикам тарифа платного Pro.",
    "Leaving Soon": "Скоро устареет",
    "Gemini 4 Carbon now available!": "Gemini 4 Carbon теперь доступна!",
    "Both Carbon and Argon are now included as part of the entire Gemini entitlement, so you can use them for much longer.": "И Carbon, и Argon теперь включены в общий лимит Gemini, поэтому вы сможете использовать их намного дольше.",
    "For your hardest, long-horizon tasks": "Для самых сложных и масштабных задач",
    "Are you sure you want to delete this conversation?": "Вы уверены, что хотите удалить этот диалог?",
    "This action cannot be undone.": "Это действие нельзя отменить.",
    "Are you sure you want to delete the Project Ave Maria Patcher AG?": "Вы уверены, что хотите удалить Project Ave Maria Patcher AG?",
    "This will permanently delete 3 active conversations within it.": "Это безвозвратно удалит 3 активных диалогов внутри.",
    "Runs on this machine": "Запускается на этом компьютере",
    "Open File": "Открыть файл",
    "Search or enter a URL": "Поиск или введите URL",
    "Model cannot be changed while the agent is running": "Нельзя сменить модель, пока агент работает",
};
for (const [en, ru] of Object.entries(expectedI18n)) {
    assert.strictEqual(window.__agyI18n._translateTextForTest(en), ru, `Mismatch for "${en}"`);
}
assert.strictEqual(window.__agyI18n._translateTextForTest("and"), null, "'and' keyword must not be translated in DOM");
assert.strictEqual(window.__agyI18n._translateTextForTest("None"), null, "'None' python literal must not be translated");

// Verify protection against translating code in diffs, terminals, and editors
const makeMockNode = (tag, className = "", attrs = {}, parent = null) => {
    const node = {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        className,
        parentElement: parent,
        getAttribute: (k) => attrs[k] || null,
        hasAttribute: (k) => k in attrs,
        closest: function(sel) {
            let cur = this;
            const parts = sel.split(",").map((s) => s.trim());
            while (cur) {
                for (const p of parts) {
                    if (p.startsWith(".")) {
                        const cls = p.slice(1);
                        if (cur.className && cur.className.split(" ").includes(cls)) return cur;
                    } else if (p.startsWith("[")) {
                        const inner = p.slice(1, -1);
                        const [k, v] = inner.split("=");
                        if (v) {
                            const cleanV = v.replace(/['"]/g, "");
                            if (cur.getAttribute && cur.getAttribute(k) === cleanV) return cur;
                        } else if (cur.hasAttribute && cur.hasAttribute(k)) {
                            return cur;
                        }
                    } else if (cur.tagName && cur.tagName.toLowerCase() === p.toLowerCase()) {
                        return cur;
                    }
                }
                cur = cur.parentElement;
            }
            return null;
        },
    };
    return node;
};

// 1. Code line in diff viewer MUST be skipped
const diffRoot = makeMockNode("div", "file-viewer-root");
const diffLine = makeMockNode("div", "code-line", { "data-diff-type": "0", "data-file-uri": "src/app.ts" }, diffRoot);
const diffContent = makeMockNode("div", "line-content", {}, diffLine);
const diffToken = makeMockNode("span", "token keyword", {}, diffContent);
assert.strictEqual(window.__agyI18n._shouldSkipElementForTest(diffToken), true, "Diff line code tokens must be skipped");

// 2. Terminal output MUST be skipped
const termPanel = makeMockNode("div", "bottom-terminal-panel");
const xtermNode = makeMockNode("div", "xterm", {}, termPanel);
const termSpan = makeMockNode("span", "", {}, xtermNode);
assert.strictEqual(window.__agyI18n._shouldSkipElementForTest(termSpan), true, "Terminal output must be skipped");

// 3. Toolbar button on diff / file viewer MUST NOT be skipped (should be translated)
const toolbarBtn = makeMockNode("button", "btn-copy", {}, diffRoot);
const btnLabel = makeMockNode("span", "btn-label", {}, toolbarBtn);
assert.strictEqual(window.__agyI18n._shouldSkipElementForTest(btnLabel), false, "Diff toolbar buttons must not be skipped");

// 4. Regular UI element in sidebar / dialog MUST NOT be skipped
const sidebarItem = makeMockNode("div", "sidebar-item");
assert.strictEqual(window.__agyI18n._shouldSkipElementForTest(sidebarItem), false, "Standard UI elements must not be skipped");

console.log("[4/23] Testing real agyExtras player hover/volume/karaoke client wiring...");
(() => {
    // Verify real client bundle contains hover/volume/karaoke conflict guards
    assert(extrasBundle.includes("setBarHoverFreeze(true)"), "Client bundle must freeze karaoke on bar hover");
    assert(extrasBundle.includes("setBarHoverFreeze(false)"), "Client bundle must unfreeze karaoke on bar leave");
    assert(extrasBundle.includes("barVolOpen"), "Client bundle must track volume popup state");
    assert(extrasBundle.includes("cardHoverOpen"), "Client bundle must track hover-opened card state");
    assert(extrasBundle.includes("hoverOpenPlayer"), "Client bundle must support hoverOpenPlayer toggle");
})();

console.log("[5/5] Testing Linux MPRIS2 / audio helpers in agyMediaDaemon.js...");
const mediaMod = require(path.join(ROOT, "customization/modules/agyMediaDaemon.js"));
const gdbusSample = `({'PlaybackStatus': <'Playing'>, 'Position': <int64 42500000>, 'CanSeek': <true>, 'CanGoNext': <true>, 'CanGoPrevious': <true>, 'Metadata': <{'mpris:trackid': <objectpath '/org/mpris/MediaPlayer2/track/1'>, 'mpris:length': <uint64 210000000>, 'mpris:artUrl': <'file:///tmp/cover.jpg'>, 'xesam:title': <'Midnight City'>, 'xesam:album': <'Hurry Up'>, 'xesam:artist': <['M83', 'Guest']>}>},)`;
const parsedMpris = mediaMod._test.parseGdbusPlayerProps(gdbusSample);
assert.strictEqual(parsedMpris.status, "Playing");
assert.strictEqual(parsedMpris.title, "Midnight City");
assert.strictEqual(parsedMpris.artist, "M83, Guest");
assert.strictEqual(parsedMpris.album, "Hurry Up");
assert.strictEqual(parsedMpris.artUrl, "file:///tmp/cover.jpg");
assert.strictEqual(parsedMpris.posSec, 42.5);
assert.strictEqual(parsedMpris.durSec, 210);
assert.strictEqual(mediaMod._test.getLinuxAppDisplayName("org.mpris.MediaPlayer2.spotify"), "Spotify");
assert.strictEqual(mediaMod._test.getLinuxAppDisplayName("org.mpris.MediaPlayer2.yandex-music"), "Яндекс Музыка");
assert.strictEqual(mediaMod._test.matchesLinuxAudioApp("org.mpris.MediaPlayer2.spotify", 'application.name = "Spotify"'), true);
assert.ok(
    mediaMod._test.scoreLinuxSession("spotify", "Song", "Playing", 180, "") >
    mediaMod._test.scoreLinuxSession("firefox", "Video", "Paused", 180, "")
);

console.log("[6/23] Testing real agyAccounts runtime state with background LS...");
(() => {
    const runningProfiles = new Set(["bg_active"]);
    const savedOrigLoad = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req === "./languageServer") {
            return { getRunningProfiles: () => Array.from(runningProfiles) };
        }
        return savedOrigLoad.apply(this, arguments);
    };
    try {
        const agyAccountsMod = require(path.join(ROOT, "customization/modules/agyAccounts.js"));
        agyAccountsMod.updateRuntimeState("bg_active", { tabOpen: false, status: "ready", activeAgentCount: 2 });
        const stRunning = agyAccountsMod.getRuntimeState("bg_active");
        assert.strictEqual(stRunning.status, "working", "Status must remain working while background server is alive");

        agyAccountsMod.updateRuntimeState("bg_inactive", { tabOpen: false, status: "ready" });
        const stDead = agyAccountsMod.getRuntimeState("bg_inactive");
        assert.strictEqual(stDead.status, "stopped", "Status should be stopped when neither tab nor LS is running");
    } finally {
        Module._load = savedOrigLoad;
    }
})();

console.log("[7/23] Testing real main.js accountStartupMode wiring & initialAccountId handling...");
(() => {
    const mainCode = fs.readFileSync(path.join(ROOT, "customization/patched_system/main.js"), "utf8");
    const tmCode = fs.readFileSync(path.join(ROOT, "customization/modules/agyTabManager.js"), "utf8");
    assert(mainCode.includes("accountStartupMode"), "patched main.js must read accountStartupMode");
    assert(mainCode.includes("primaryAccountId"), "patched main.js must read primaryAccountId");
    assert(mainCode.includes("initialAccountId"), "patched main.js must pass initialAccountId to createMainTabWindow");
    assert(tmCode.includes("options.initialAccountId"), "agyTabManager must support options.initialAccountId");
})();

console.log("[8/23] Testing real agyExtras privacy spoiler engine (DOM TreeWalker, >160 chars, attrs scrub, reuse cleanup)...");
(() => {
    const mkClassList = () => {
        const s = new Set();
        return {
            add: (...a) => a.forEach((x) => s.add(x)),
            remove: (...a) => a.forEach((x) => s.delete(x)),
            toggle: (x, f) => (f === undefined ? (s.has(x) ? (s.delete(x), false) : (s.add(x), true)) : (f ? (s.add(x), true) : (s.delete(x), false))),
            contains: (x) => s.has(x),
        };
    };
    const allElements = [];
    const mkEl = (tag = "div", opts = {}) => {
        const attrs = new Map(Object.entries(opts.attrs || {}));
        const styleMap = new Map();
        const el = {
            tagName: tag.toUpperCase(),
            nodeType: 1,
            id: opts.id || "",
            innerHTML: "",
            textContent: opts.text || "",
            isConnected: true,
            _isCode: Boolean(opts.isCode),
            classList: mkClassList(),
            style: {
                setProperty: (k, v) => styleMap.set(k, String(v)),
                getPropertyValue: (k) => styleMap.get(k) || "",
            },
            dataset: {},
            setAttribute: (k, v) => attrs.set(k, String(v)),
            getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
            removeAttribute: (k) => attrs.delete(k),
            hasAttribute: (k) => attrs.has(k),
            addEventListener() {},
            removeEventListener() {},
            appendChild(c) { return c; },
            append() {},
            remove() {},
            contains: () => false,
            matches: () => false,
            closest: (sel) => (el._isCode && /code|monaco|pre/.test(sel) ? el : null),
            getBoundingClientRect: () => ({ top: 0, bottom: 32, left: 0, right: 300, width: 300, height: 32 }),
            querySelector: () => mkEl("div"),
            querySelectorAll(sel) {
                if (sel === '[data-agy-spoiler="1"]') return allElements.filter((n) => n.getAttribute("data-agy-spoiler") === "1");
                if (sel === "[title], [aria-label], [data-agy-tip]") return allElements.filter((n) => n.hasAttribute("title") || n.hasAttribute("aria-label") || n.hasAttribute("data-agy-tip"));
                const m = /^\[([a-z0-9-]+)\]$/.exec(sel);
                if (m) return allElements.filter((n) => n.hasAttribute(m[1]));
                return [];
            },
            attachShadow: () => mkEl("shadow"),
        };
        if (opts.track) allElements.push(el);
        return el;
    };

    const normalSpan = mkEl("span", { track: true, text: "developer@example.com" });
    const longSpan = mkEl("p", { track: true, text: "A".repeat(250) + " long.user@example.org " + "B".repeat(200) });
    const codeSpan = mkEl("span", { track: true, text: "code@example.com", isCode: true });
    const tipBtn = mkEl("button", { track: true, text: "Profile", attrs: { title: "Signed in as secret@example.com", "aria-label": "Account secret@example.com", "data-agy-tip": "secret@example.com" } });
    const reusedSpan = mkEl("span", { track: true, text: "Plain text without email", attrs: { "data-agy-spoiler": "1" } });

    const textNodes = [
        { nodeType: 3, nodeValue: normalSpan.textContent, parentElement: normalSpan },
        { nodeType: 3, nodeValue: longSpan.textContent, parentElement: longSpan },
        { nodeType: 3, nodeValue: codeSpan.textContent, parentElement: codeSpan },
    ];
    const docEl = mkEl("html");
    docEl.dataset.agyPrivacy = "1";
    const bodyEl = mkEl("body");
    const winListeners = new Map();
    const sandbox = {
        window: {
            innerWidth: 1280,
            innerHeight: 800,
            addEventListener(ev, fn) {
                if (!winListeners.has(ev)) winListeners.set(ev, []);
                winListeners.get(ev).push(fn);
            },
            removeEventListener() {},
            dispatchEvent(ev) {
                for (const fn of winListeners.get(ev.type) || []) fn(ev);
            },
            CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
        },
        document: {
            documentElement: docEl,
            body: bodyEl,
            readyState: "complete",
            visibilityState: "visible",
            createElement: (t) => mkEl(t),
            createTreeWalker: () => {
                let idx = 0;
                return { nextNode: () => (idx < textNodes.length ? textNodes[idx++] : null) };
            },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        },
        NodeFilter: { SHOW_TEXT: 4 },
        WeakMap,
        localStorage: { getItem: () => null, setItem() {} },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        performance: { now: () => 0 },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval: () => 1,
        clearInterval() {},
        console,
        Math, Date, Number, String, Boolean, Array, Object, Set, Map, JSON, RegExp, Error, Promise, parseInt, parseFloat, isFinite, encodeURIComponent,
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(extrasBundle, sandbox, { filename: "agyExtras.privacy.test.js" });

    assert.strictEqual(normalSpan.getAttribute("data-agy-spoiler"), "1", "Real scanPrivacySpoilers must tag email span");
    assert.strictEqual(longSpan.getAttribute("data-agy-spoiler"), "1", "P1-5: text nodes > 160 chars (<=2000) must also be spoiled");
    assert.strictEqual(codeSpan.getAttribute("data-agy-spoiler"), null, "Emails inside code editors must NOT be spoiled");
    assert.strictEqual(reusedSpan.getAttribute("data-agy-spoiler"), null, "P1-5: stale data-agy-spoiler on reused React node must be removed");
    assert(!tipBtn.getAttribute("title").includes("secret@example.com"), "P1-5: title attribute email must be scrubbed");
    assert(!tipBtn.getAttribute("aria-label").includes("secret@example.com"), "P1-5: aria-label attribute email must be scrubbed");
    assert(!tipBtn.getAttribute("data-agy-tip").includes("secret@example.com"), "P1-5: data-agy-tip attribute email must be scrubbed");

    // Disable privacy mode -> original tooltip attributes must be restored and spoilers cleared
    docEl.dataset.agyPrivacy = "0";
    sandbox.window.dispatchEvent(new sandbox.window.CustomEvent("agy-privacy-sync", { detail: { privacyMode: false } }));
    assert.strictEqual(tipBtn.getAttribute("title"), "Signed in as secret@example.com", "Disabling privacy mode must restore original title");
    assert.strictEqual(normalSpan.getAttribute("data-agy-spoiler"), null, "Disabling privacy mode must clear data-agy-spoiler");
})();

console.log("[9/23] Testing real agyUiContrast WCAG adaptive tokens & wallpaperEngine Light/Dark compatibility...");
(() => {
    const contrast = require(path.join(ROOT, "customization/modules/agyUiContrast.js"));
    const lightTokens = contrast.getAdaptiveThemeTokens("248, 250, 252", "96, 165, 250", 0.24);
    const darkTokens = contrast.getAdaptiveThemeTokens("12, 14, 20", "96, 165, 250", 0.24);
    assert.strictEqual(lightTokens.surface.primary, "#000000", "Light surface must select dark primary ink");
    assert.strictEqual(darkTokens.surface.primary, "#ffffff", "Dark surface must select light primary ink");
    assert(
        contrast.contrastRatio(contrast.parseRgb(lightTokens.surface.primary), [248, 250, 252]) >= 4.5,
        "Light surface primary text must meet WCAG AA >= 4.5:1"
    );
    assert(
        contrast.contrastRatio(contrast.parseRgb(darkTokens.surface.primary), [12, 14, 20]) >= 4.5,
        "Dark surface primary text must meet WCAG AA >= 4.5:1"
    );
    assert(
        contrast.contrastRatio(contrast.parseRgb(lightTokens.accentText), [248, 250, 252]) >= 4.5,
        "Light surface accent text must meet WCAG AA >= 4.5:1"
    );
    assert(
        contrast.contrastRatio(contrast.parseRgb(darkTokens.accentText), [12, 14, 20]) >= 4.5,
        "Dark surface accent text must meet WCAG AA >= 4.5:1"
    );
})();

console.log("[10/10] Testing quota model display rules, label sanitization, and tier-specific pool grouping...");
(() => {
    const agyAccounts = require(path.join(ROOT, "customization/modules/agyAccounts.js"));
    const { extractUserTelemetryFromUserStatus } = require(path.join(ROOT, "customization/modules/agyExtras.js"));
    const {
        classifyTierType,
        cleanModelLabel,
        classifyFamily,
        normalizeQuotasForTier,
        sanitizeQuotaList,
    } = agyAccounts;

    // 1. Tier classification
    assert.strictEqual(classifyTierType(null), "trial");
    assert.strictEqual(classifyTierType({}), "trial");
    assert.strictEqual(classifyTierType({ name: "Trial Plan" }), "trial");
    assert.strictEqual(classifyTierType({ name: "free" }), "trial");
    assert.strictEqual(classifyTierType({ planName: "Pro Paid" }), "pro");
    assert.strictEqual(classifyTierType({ id: "google_ai_pro" }), "pro");
    assert.strictEqual(classifyTierType({ name: "Ultra Tier" }), "ultra");
    assert.strictEqual(classifyTierType({ planName: "Google AI Ultra" }), "ultra");

    // 2. Model label cleaning
    assert.strictEqual(cleanModelLabel("Gemini 4 Argon (Medium)"), "Gemini 4 Argon");
    assert.strictEqual(cleanModelLabel("Gemini 4 Argon (medium)"), "Gemini 4 Argon");
    assert.strictEqual(cleanModelLabel("Gemini 4 Argon (Средний)"), "Gemini 4 Argon");
    assert.strictEqual(cleanModelLabel("Argon (Medium)"), "Argon");
    assert.strictEqual(cleanModelLabel("Argon medium"), "Argon");
    assert.strictEqual(cleanModelLabel("Orchestrator (Neon)"), "Orchestrator");
    assert.strictEqual(cleanModelLabel("Orchestrator: Neon"), "Orchestrator");
    assert.strictEqual(cleanModelLabel("Orchestrator Neon"), "Orchestrator");
    assert.strictEqual(cleanModelLabel("Orchestrator (Неон)"), "Orchestrator");
    assert.strictEqual(cleanModelLabel("Оркестратор (Neon)"), "Оркестратор");
    assert.strictEqual(cleanModelLabel("Gemini 2.5 Flash"), "Gemini 2.5 Flash");
    assert.strictEqual(cleanModelLabel("Gemini Models"), "Gemini Models");
    assert.strictEqual(cleanModelLabel("Gemini 4 Carbon"), "Gemini 4 Carbon");

    // 3. Trial tier: only Gemini open, Argon & Carbon filtered out (never show 0%), Gemini Models never duplicated
    const trialConfigs = [
        { label: "Gemini 2.5 Flash", quotaInfo: { remainingFraction: 0.9, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.85, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini Models", quotaInfo: { remainingFraction: 0.85, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 4 Argon (Medium)", quotaInfo: { remainingFraction: 0.0, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 4 Carbon", quotaInfo: { remainingFraction: 0.0, resetTime: "2026-12-01T00:00:00Z" } },
    ];
    const trialUserStatus = {
        name: "Trial User",
        email: "trial@example.com",
        userTier: { name: "Trial Plan" },
        cascadeModelConfigData: { clientModelConfigs: trialConfigs },
    };
    const trialRes = extractUserTelemetryFromUserStatus(trialUserStatus);
    assert(trialRes, "extractUserTelemetryFromUserStatus must return object");
    assert.strictEqual(trialRes.quotas.length, 1, "Trial tier must contain exactly 1 quota pool");
    assert.strictEqual(trialRes.quotas[0].label, "Gemini Models", "Trial pool must be Gemini Models");
    assert.strictEqual(trialRes.quotas[0].remainingFraction, 0.85, "Must use lowest remainingFraction among Gemini models");
    assert(!trialRes.quotas.some((q) => /argon|carbon/i.test(q.label)), "Argon and Carbon must not be present in Trial tier");

    // 4. Pro Paid tier: Gemini + Argon + Orchestrator unified into "Gemini Models", Carbon available on Pro Paid
    const proConfigs = [
        { label: "Gemini 2.5 Flash", quotaInfo: { remainingFraction: 0.95, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.95, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 4 Argon (Medium)", quotaInfo: { remainingFraction: 0.40, resetTime: "2026-12-02T00:00:00Z" } },
        { label: "Orchestrator (Neon)", quotaInfo: { remainingFraction: 0.75, resetTime: "2026-12-03T00:00:00Z" } },
        { label: "Gemini 4 Carbon", quotaInfo: { remainingFraction: 0.60, resetTime: "2026-12-01T00:00:00Z" } },
    ];
    const proUserStatus = {
        name: "Pro User",
        email: "pro@example.com",
        userTier: { name: "Pro Plan", planName: "Pro Paid" },
        cascadeModelConfigData: { clientModelConfigs: proConfigs },
    };
    const proRes = extractUserTelemetryFromUserStatus(proUserStatus);
    assert(proRes, "pro telemetry must parse");
    const proLabels = proRes.quotas.map((q) => q.label);
    assert(proLabels.includes("Gemini Models"), "Pro must include unified Gemini Models");
    assert(!proLabels.includes("Gemini 4 Argon"), "Argon must be merged into Gemini Models");
    assert(!proLabels.includes("Orchestrator"), "Orchestrator must be merged into Gemini Models");
    const geminiQ = proRes.quotas.find((q) => q.label === "Gemini Models");
    assert.strictEqual(geminiQ.remainingFraction, 0.40, "Unified Gemini Models pool must retain lowest fraction across Gemini/Argon/Orchestrator");

    // 5. Ultra tier: Gemini + Argon + Orchestrator unified into "Gemini Models", Carbon allowed
    const ultraConfigs = [
        { label: "Gemini Models", quotaInfo: { remainingFraction: 0.88, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 4 Argon (Medium)", quotaInfo: { remainingFraction: 0.88, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Orchestrator (Neon)", quotaInfo: { remainingFraction: 0.88, resetTime: "2026-12-01T00:00:00Z" } },
        { label: "Gemini 4 Carbon", quotaInfo: { remainingFraction: 0.60, resetTime: "2026-12-05T00:00:00Z" } },
    ];
    const ultraUserStatus = {
        name: "Ultra User",
        email: "ultra@example.com",
        userTier: { name: "Ultra Plan", planName: "Google AI Ultra" },
        cascadeModelConfigData: { clientModelConfigs: ultraConfigs },
    };
    const ultraRes = extractUserTelemetryFromUserStatus(ultraUserStatus);
    assert(ultraRes, "ultra telemetry must parse");
    const ultraLabels = ultraRes.quotas.map((q) => q.label);
    assert.strictEqual(ultraLabels.includes("Gemini Models"), true, "On Ultra tier Gemini, Argon, and Orchestrator must be combined into 'Gemini Models'");
    assert(!ultraLabels.includes("Gemini 4 Argon") && !ultraLabels.includes("Orchestrator"), "Individual Argon and Orchestrator rows must be unified on Ultra");

    // 6. agyAccounts sanitizeQuotaList compatibility with saved accounts
    const dirtyTrialQuotas = [
        { label: "Gemini 2.5 Flash", remainingFraction: 1 },
        { label: "Gemini 2.5 Pro", remainingFraction: 0.9 },
        { label: "Gemini 4 Argon (Medium)", remainingFraction: 0.8 },
        { label: "Carbon", remainingFraction: 0 },
    ];
    const sanitizedTrial = sanitizeQuotaList(dirtyTrialQuotas, { name: "Trial" });
    assert.strictEqual(sanitizedTrial.length, 1);
    assert.strictEqual(sanitizedTrial[0].label, "Gemini Models");
    assert.strictEqual(sanitizedTrial[0].remainingFraction, 0.8);

    const dirtyProQuotas = [
        { label: "Gemini Models", remainingFraction: 1, resetTime: "2026-12-01T00:00:00Z" },
        { label: "Gemini 4 Argon (Medium)", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" },
        { label: "Orchestrator (Neon)", remainingFraction: 0.8, resetTime: "2026-12-01T00:00:00Z" },
        { label: "Carbon", remainingFraction: 0.7, resetTime: "2026-12-05T00:00:00Z" },
    ];
    const sanitizedPro = sanitizeQuotaList(dirtyProQuotas, { name: "Pro Paid" });
    assert.strictEqual(sanitizedPro.length, 1);
    assert.strictEqual(sanitizedPro[0].label, "Gemini Models");
    assert.strictEqual(sanitizedPro[0].remainingFraction, 0.5);

    // 7. Deduplicate reasoning effort variants (Medium, High, Low) and unify Claude + GPT models into shared "Claude & GPT" pool
    const reasoningVariations = [
        { label: "Gemini Models", remainingFraction: 1 },
        { label: "Gemini 4 Argon", remainingFraction: 0.9 },
        { label: "Gemini 4 Carbon (Medium)", remainingFraction: 1 },
        { label: "Gemini 4 Carbon (High)", remainingFraction: 0.8 },
        { label: "Gemini 4 Carbon (Low)", remainingFraction: 1 },
        { label: "Claude Opus 5.5 (Medium)", remainingFraction: 1 },
        { label: "Claude Opus 5.5 (Low)", remainingFraction: 0.7 },
        { label: "Claude Sonnet 5.5 (Medium)", remainingFraction: 0.85 },
        { label: "GPT-OSS 120B", remainingFraction: 0.65 },
        { label: "Оркестратор Gemini 4 Neon Extra High", remainingFraction: 0.95 },
    ];
    // On Pro Paid: Gemini+Argon+Orchestrator+Gemini4Carbon -> 1 entry "Gemini Models", Claude+GPT -> 1 entry "Claude & GPT"
    const deduplicated = normalizeQuotasForTier(reasoningVariations, { name: "Pro Paid" });
    const claudeGptEntries = deduplicated.filter((q) => /claude|opus|sonnet|gpt/i.test(q.label));
    const geminiEntries = deduplicated.filter((q) => q.label === "Gemini Models");
    assert.strictEqual(geminiEntries.length, 1, "Gemini, Argon, and Orchestrator must be unified into 1 'Gemini Models' entry");
    assert.strictEqual(geminiEntries[0].remainingFraction, 0.8, "Gemini Models must retain lowest fraction across merged Gemini/Argon/Orchestrator/Carbon");
    assert.strictEqual(claudeGptEntries.length, 1, "All Claude and GPT models (Opus, Sonnet, GPT-OSS) must be unified into 1 entry 'Claude & GPT'");
    assert.strictEqual(claudeGptEntries[0].label, "Claude & GPT", "Pool label must be 'Claude & GPT'");
    assert.strictEqual(claudeGptEntries[0].remainingFraction, 0.65, "Must retain lowest remaining fraction across shared Claude & GPT pool");

    // On Ultra with shared/empty resetTime: Carbon also merges into Gemini Models
    const deduplicatedUltra = normalizeQuotasForTier(reasoningVariations, { name: "Ultra" });
    assert.strictEqual(deduplicatedUltra.filter((q) => q.label === "Gemini Models").length, 1);
})();

console.log("[11/11] Testing widget animations, transitions, and micro-interactions...");
(() => {
    const extrasCode = fs.readFileSync(path.join(ROOT, "customization/modules/agyExtras.js"), "utf8");
    const shellViewsCode = fs.readFileSync(path.join(ROOT, "customization/modules/agyShellViews.js"), "utf8");

    // 1. agyExtras widget animations
    assert(extrasCode.includes("@keyframes cardGlideIn"), "cardGlideIn keyframes missing");
    assert(extrasCode.includes("@keyframes ctxGlideIn"), "ctxGlideIn keyframes missing");
    assert(extrasCode.includes("@keyframes agyPulseGlow"), "agyPulseGlow keyframes missing in agyExtras");
    assert(extrasCode.includes("cubic-bezier(0.16, 1, 0.3, 1)"), "Smooth cubic-bezier deceleration missing in agyExtras");
    assert(extrasCode.includes("stroke-dashoffset 0.4s"), "Context ring arc transition missing");

    // 2. agyShellViews transitions
    assert(shellViewsCode.includes("@keyframes agyPulseGlow"), "agyPulseGlow keyframes missing in agyShellViews");
    assert(shellViewsCode.includes(".st-sq.working, .st-sq.ready"), "Status square pulse glow missing");
    assert(shellViewsCode.includes("transform: translateY(-2px)"), "Card hover lift transition missing");
    assert(shellViewsCode.includes("width 0.45s cubic-bezier"), "Quota progress fill animation missing");
    assert(shellViewsCode.includes(".btn:hover:not(:disabled)"), "Button hover transitions missing");
})();

console.log("[12/16] Testing P0-1 HTTP server hardening (Host/Origin/Token/POST-only) & handleExtrasRequest...");
const phase1AsyncTests = (async () => {
    const { EventEmitter } = require("events");
    const wp = require(path.join(ROOT, "customization/modules/wallpaperEngine.js"));
    const { handleExtrasRequest, buildExtrasClientJs } = require(path.join(ROOT, "customization/modules/agyExtras.js"));

    const tok = wp.getLocalServerToken();
    assert(/^[a-f0-9]{64}$/.test(tok), `SERVER_TOKEN must be 64-char hex, got: ${tok}`);

    const mkReq = (method, headers = {}) => ({ method, headers });
    const allowOrigin = (o) => o === "http://127.0.0.1:12345" || o === "https://127.0.0.1:54321";

    // 1. DNS Rebinding protection (invalid Host)
    const badHost = wp.validateLocalServerRequest(
        mkReq("GET", { host: "evil.attacker.com:12345", "x-agy-token": tok }),
        new URL("http://127.0.0.1:12345/accounts/list"),
        { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
    );
    assert.strictEqual(badHost.ok, false);
    assert.strictEqual(badHost.status, 403, "Invalid Host header must be rejected with 403");

    // 2. CSRF protection (untrusted Origin)
    const badOrigin = wp.validateLocalServerRequest(
        mkReq("POST", { host: "127.0.0.1:12345", origin: "https://evil.example", "x-agy-token": tok }),
        new URL("http://127.0.0.1:12345/accounts/delete"),
        { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
    );
    assert.strictEqual(badOrigin.ok, false);
    assert.strictEqual(badOrigin.status, 403, "Untrusted Origin must be rejected with 403");

    // 3. Valid preflight OPTIONS from allowed Origin
    const preflight = wp.validateLocalServerRequest(
        mkReq("OPTIONS", { host: "127.0.0.1:12345", origin: "https://127.0.0.1:54321" }),
        new URL("http://127.0.0.1:12345/accounts/list"),
        { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
    );
    assert.strictEqual(preflight.ok, true);
    assert.strictEqual(preflight.preflight, true);
    assert.strictEqual(preflight.origin, "https://127.0.0.1:54321");

    // 4. Missing or wrong X-Agy-Token -> 401
    const noTok = wp.validateLocalServerRequest(
        mkReq("GET", { host: "127.0.0.1:12345" }),
        new URL("http://127.0.0.1:12345/accounts/list"),
        { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
    );
    assert.strictEqual(noTok.ok, false);
    assert.strictEqual(noTok.status, 401, "Missing token must return 401");

    // 5. Query token ?t= allowed ONLY for SSE/stream/cover/shell, NOT for control/API routes
    const queryOnApi = wp.validateLocalServerRequest(
        mkReq("POST", { host: "127.0.0.1:12345" }),
        new URL(`http://127.0.0.1:12345/accounts/delete?t=${tok}`),
        { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
    );
    assert.strictEqual(queryOnApi.ok, false);
    assert.strictEqual(queryOnApi.status, 401, "Query token must NOT authorize /accounts/delete");

    for (const qPath of ["/events", "/stream/0", "/media/cover?key=abc", "/shell/picker"]) {
        const sep = qPath.includes("?") ? "&" : "?";
        const okQ = wp.validateLocalServerRequest(
            mkReq("GET", { host: "127.0.0.1:12345" }),
            new URL(`http://127.0.0.1:12345${qPath}${sep}t=${tok}`),
            { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
        );
        assert.strictEqual(okQ.ok, true, `Query token must authorize ${qPath}`);
    }

    // 6. Valid header token authorizes API routes
    const okHeader = wp.validateLocalServerRequest(
        mkReq("POST", { host: "127.0.0.1:12345", origin: "https://127.0.0.1:54321", "x-agy-token": tok }),
        new URL("http://127.0.0.1:12345/accounts/list"),
        { serverPort: 12345, token: tok, isAllowedOrigin: allowOrigin }
    );
    assert.strictEqual(okHeader.ok, true);

    // 7. Real handleExtrasRequest checks (POST-only media control, invalid seek, malformed JSON)
    const invokeRoute = (method, urlPath, bodyObj = null) => new Promise((resolve) => {
        const req = new EventEmitter();
        req.method = method;
        req.headers = { host: "127.0.0.1:12345", "content-type": "application/json", "x-agy-token": tok };
        req.destroy = () => {};
        const res = {
            status: 0,
            headers: {},
            headersSent: false,
            writableEnded: false,
            destroyed: false,
            body: "",
            writeHead(code, h) { this.status = code; this.headers = h || {}; this.headersSent = true; },
            end(chunk = "") { this.body += String(chunk); this.writableEnded = true; resolve(this); },
        };
        const handled = handleExtrasRequest(new URL(`http://127.0.0.1:12345${urlPath}`), req, res, 12345);
        assert.strictEqual(handled, true, `Route ${urlPath} must be handled`);
        if (bodyObj !== null) {
            req.emit("data", Buffer.from(typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj)));
            req.emit("end");
        }
    });

    for (const mediaPath of ["/media/playpause", "/media/next", "/media/prev"]) {
        const getResp = await invokeRoute("GET", mediaPath);
        assert.strictEqual(getResp.status, 405, `GET ${mediaPath} must return 405 Method Not Allowed`);
    }
    const badSeek = await invokeRoute("POST", "/media/seek", { sec: -5 });
    assert.strictEqual(badSeek.status, 400, "Negative seek must return 400");
    const badJson = await invokeRoute("POST", "/media/seek", "{broken_json");
    assert.strictEqual(badJson.status, 400, "Malformed JSON on /media/seek must return 400");

    // 7b. Real /tabs/close option forwarding (must NOT force stopServer=true when omitted)
    {
        const closeCalls = [];
        const savedCloseLoad = Module._load;
        Module._load = function (req, parent, isMain) {
            if (req === "./agyTabManager") {
                return {
                    hasMainWindow: () => true,
                    closeAccountTab: async (id, opts) => {
                        closeCalls.push({ id, opts });
                        return { ok: true, id };
                    },
                };
            }
            return savedCloseLoad.apply(this, arguments);
        };
        try {
            const extrasPath = path.join(ROOT, "customization/modules/agyExtras.js");
            delete require.cache[require.resolve(extrasPath)];
            const freshExtras = require(extrasPath);
            const invokeFreshClose = (payload) => new Promise((resolve) => {
                const req = new EventEmitter();
                req.method = "POST";
                req.headers = { host: "127.0.0.1:12345", "content-type": "application/json", "x-agy-token": tok };
                req.destroy = () => {};
                const res = {
                    status: 0, headersSent: false, writableEnded: false, destroyed: false, body: "",
                    writeHead(code) { this.status = code; this.headersSent = true; },
                    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; resolve(this); },
                };
                freshExtras.handleExtrasRequest(new URL("http://127.0.0.1:12345/tabs/close"), req, res, 12345);
                req.emit("data", Buffer.from(JSON.stringify(payload)));
                req.emit("end");
            });
            await invokeFreshClose({ id: "acc1" });
            await invokeFreshClose({ id: "acc1", stopServer: true });
            await invokeFreshClose({ id: "acc1", stopServer: false });
            assert.strictEqual(closeCalls.length, 3, "All 3 /tabs/close calls must reach real closeAccountTab");
            assert.deepStrictEqual(closeCalls[0], { id: "acc1", opts: {} }, "Default /tabs/close must NOT force stopServer=true");
            assert.deepStrictEqual(closeCalls[1], { id: "acc1", opts: { stopServer: true } }, "Explicit stopServer=true must be forwarded");
            assert.deepStrictEqual(closeCalls[2], { id: "acc1", opts: { stopServer: false } }, "Explicit stopServer=false must be forwarded");
        } finally {
            Module._load = savedCloseLoad;
            delete require.cache[require.resolve(path.join(ROOT, "customization/modules/agyExtras.js"))];
        }
    }

    // 8. Extras client bundle embeds token & uses apiFetch
    const exWithTok = buildExtrasClientJs("default", 12345, "tok_test_999");
    new vm.Script(exWithTok, { filename: "agyExtras.client.tok.js" });
    assert(exWithTok.includes("tok_test_999"), "Extras client bundle must embed token");
    assert(exWithTok.includes("X-Agy-Token"), "Extras client bundle must send X-Agy-Token header");
    assert(!exWithTok.includes("fetch(BASE_URL +"), "Extras client bundle must not use raw unauthenticated fetch(BASE_URL +");

    console.log("[13/16] Testing P0-2 & P0-3 agyWinUserIsolation hardening & agyUiContrast WCAG invariants...");
    const iso = require(path.join(ROOT, "customization/modules/agyWinUserIsolation.js"));
    const contrast = require(path.join(ROOT, "customization/modules/agyUiContrast.js"));

    const winUser = iso.buildWinUsername("acc_very_long_account_identifier_12345");
    assert(/^AgyAcc_[a-f0-9]{8}$/.test(winUser), `Invalid winUser format: ${winUser}`);
    assert(winUser.length <= 20, "Windows SAM username must be <= 20 chars");

    const pwd = iso.generateStrongPassword();
    assert.strictEqual(pwd.length, 28, "Password must be 28 chars");
    assert(/[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd), "Password must contain mixed classes");
    assert(!/[$"`'\\]/.test(pwd), "Password must not contain PowerShell metacharacters");

    // P0-2: Runner clears inherited environment & sanitizes PATH
    const runnerPs = iso.buildRunnerScriptContent();
    assert(runnerPs.includes("$psi.EnvironmentVariables.Clear()"), "Runner script must clear inherited EnvironmentVariables");
    assert(runnerPs.includes("$keepSys"), "Runner script must keep only minimal OS whitelist");

    const cleanPath = iso.buildSanitizedChildPath(
        "C:\\Users\\PrimaryUser\\AppData\\Roaming\\npm;C:\\Windows\\System32;c:\\users\\primaryuser\\bin;C:\\Program Files\\Git\\cmd",
        "C:\\Users\\PrimaryUser",
        "C:\\ProgramData\\AntigravityAccounts\\bin"
    );
    assert(!cleanPath.toLowerCase().includes("primaryuser"), `Primary user paths must be stripped from child PATH: ${cleanPath}`);
    assert(cleanPath.startsWith("C:\\ProgramData\\AntigravityAccounts\\bin;"), "sharedBin must be prepended to sanitized PATH");
    assert(cleanPath.includes("C:\\Windows\\System32"), "System32 must remain in sanitized PATH");

    // P0-3: Admin script uses /inheritance:r, GetFullPath canonicalization, ReparsePoint guard, and bootstrap verifies SHA-256
    const adminPs = iso.buildAdminScriptContent();
    assert(adminPs.includes("$canonDataRoot /inheritance:r"), "dataRoot must strip inherited Users write ACLs");
    assert(adminPs.includes("$canonSharedBin /inheritance:r"), "sharedBin must strip inherited Users write ACLs");
    assert(adminPs.includes("[System.IO.Path]::GetFullPath($accountRoot)"), "accountRoot must be canonicalized");
    assert(adminPs.includes("ReparsePoint"), "remove action must guard against symlinks/junctions (ReparsePoint)");

    const bootPs = iso.buildElevatedBootstrapScript({
        action: "provision",
        adminPath: "C:\\test\\admin.ps1",
        adminSha256: "a".repeat(64),
        specPath: "C:\\test\\spec.json",
        specSha256: "b".repeat(64),
        resultPath: "C:\\test\\res.json",
    });
    assert(bootPs.includes("SHA256"), "Elevated bootstrap must verify SHA-256 before executing");
    assert(bootPs.includes("[scriptblock]::Create"), "Elevated bootstrap must execute verified bytes from memory");
    assert(bootPs.includes("WriteAllBytes") && bootPs.includes("Delete"), "Elevated bootstrap must zero-wipe and delete spec file");

    // Unlocker 2 proxy: WinINET parsing, registry -> TCP-probe -> null fallback chain
    {
        assert.strictEqual(iso.parseWinInetProxyServer("127.0.0.1:10809").url, "http://127.0.0.1:10809");
        assert.strictEqual(iso.parseWinInetProxyServer("http=127.0.0.1:10809;https=127.0.0.1:10810;socks=127.0.0.1:10808").hostPort, "127.0.0.1:10810", "https= entry must win");
        assert.strictEqual(iso.parseWinInetProxyServer("http=127.0.0.1:10809").hostPort, "127.0.0.1:10809");
        assert.strictEqual(iso.parseWinInetProxyServer("http://127.0.0.1:10809/").hostPort, "127.0.0.1:10809");
        assert.strictEqual(iso.parseWinInetProxyServer("socks=127.0.0.1:10808"), null, "SOCKS-only proxy must be ignored");
        assert.strictEqual(iso.parseWinInetProxyServer("127.0.0.1:99999"), null, "Invalid port must be rejected");
        assert.strictEqual(iso.parseWinInetProxyServer("evil\" & calc:80"), null, "Unsafe host must be rejected");

        const regOut = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:10809\r\n";
        assert.deepStrictEqual(iso.parseInternetSettingsRegOutput(regOut), { enabled: true, server: "127.0.0.1:10809" });
        assert.strictEqual(iso.parseInternetSettingsRegOutput("    ProxyEnable    REG_DWORD    0x0\r\n").enabled, false);

        let probeCalls = 0;
        const fromReg = await iso.resolveUnlockerProxy({
            force: true,
            readSettings: async () => ({ enabled: true, server: "http=127.0.0.1:20809;https=127.0.0.1:20809" }),
            probe: async () => { probeCalls++; return true; },
        });
        assert.strictEqual(fromReg.url, "http://127.0.0.1:20809");
        assert.strictEqual(fromReg.source, "registry");
        assert.strictEqual(probeCalls, 0, "Registry hit must not TCP-probe the fallback port");

        let probedTarget = "";
        const fromProbe = await iso.resolveUnlockerProxy({
            force: true,
            readSettings: async () => ({ enabled: false, server: "127.0.0.1:20809" }),
            probe: async (h, p) => { probedTarget = `${h}:${p}`; return true; },
        });
        assert.strictEqual(probedTarget, "127.0.0.1:10809", "Disabled registry proxy must fall back to probing 127.0.0.1:10809");
        assert.strictEqual(fromProbe.url, "http://127.0.0.1:10809");
        assert.strictEqual(fromProbe.source, "port-probe");

        const none = await iso.resolveUnlockerProxy({
            force: true,
            readSettings: async () => null,
            probe: async () => false,
        });
        assert.strictEqual(none, null, "Unlocker off + closed port must yield null (direct networking)");
        iso.resetUnlockerProxyCache();

        // Real TCP probe against a closed + an open loopback port
        const srv = require("net").createServer().listen(0, "127.0.0.1");
        await new Promise((r) => srv.once("listening", r));
        const openPort = srv.address().port;
        assert.strictEqual(await iso.probeTcpPort("127.0.0.1", openPort, 1000), true, "probeTcpPort must detect an open port");
        await new Promise((r) => srv.close(r));
        assert.strictEqual(await iso.probeTcpPort("127.0.0.1", openPort, 1000), false, "probeTcpPort must report a closed port");

        // Isolated LS env: proxy vars injected, loopback bypassed, explicit parent proxy preserved
        const px = { host: "127.0.0.1", port: 10809, hostPort: "127.0.0.1:10809", url: "http://127.0.0.1:10809", source: "registry" };
        const envPx = iso.buildIsolatedChildEnv({ env: { ANTIGRAVITY_SERVER_CSRF_TOKEN: "csrf", SECRET_X: "no" }, proxy: px, rawPath: "C:\\Windows\\System32", homeDir: path.join(os.tmpdir(), "agy_home") });
        assert.strictEqual(envPx.HTTP_PROXY, "http://127.0.0.1:10809");
        assert.strictEqual(envPx.HTTPS_PROXY, "http://127.0.0.1:10809");
        assert.strictEqual(envPx.ALL_PROXY, "http://127.0.0.1:10809");
        assert.strictEqual(envPx.NO_PROXY, "localhost,127.0.0.1", "NO_PROXY must keep loopback direct for local-server/LS");
        assert.strictEqual(envPx.ANTIGRAVITY_SERVER_CSRF_TOKEN, "csrf");
        assert.strictEqual(envPx.ANTIGRAVITY_VSCODE_HOST, "1");
        assert.strictEqual(envPx.SECRET_X, undefined, "Non-whitelisted env must not leak into isolated LS");
        const envExplicit = iso.buildIsolatedChildEnv({ env: { https_proxy: "http://corp:8080", no_proxy: "intranet" }, proxy: px });
        assert.strictEqual(envExplicit.HTTPS_PROXY, "http://corp:8080", "Explicit parent proxy must win over detected unlocker proxy");
        assert.strictEqual(envExplicit.HTTP_PROXY, undefined);
        assert.strictEqual(envExplicit.NO_PROXY, "intranet,localhost,127.0.0.1", "Loopback must be merged into explicit NO_PROXY");
        const envNone = iso.buildIsolatedChildEnv({ env: {}, proxy: null });
        assert.strictEqual(envNone.HTTP_PROXY, undefined, "No proxy must be injected when unlocker is off");
        assert.strictEqual(envNone.NO_PROXY, undefined);

        // HKCU proxy registry plan for the isolated user (enable -> marker -> disable)
        const markerPath = path.join(os.tmpdir(), `agy_proxy_marker_${process.pid}_${Date.now()}`);
        assert.deepStrictEqual(iso.planIsolatedProxyRegistry(markerPath, px), { enable: true, server: "127.0.0.1:10809", override: "localhost;127.0.0.1;<local>" });
        assert(fs.existsSync(markerPath), "Enabling proxy registry must write marker");
        assert.deepStrictEqual(iso.planIsolatedProxyRegistry(markerPath, null), { enable: false }, "Unlocker off after enable must disable isolated WinINET proxy");
        assert(!fs.existsSync(markerPath), "Disabling must remove marker");
        assert.strictEqual(iso.planIsolatedProxyRegistry(markerPath, null), null, "No marker + no proxy must skip registry sync");

        assert(runnerPs.includes("Sync-IsolatedProxyRegistry $spec.proxyRegistry"), "Runner must sync isolated HKCU proxy before LS start");
        assert(runnerPs.indexOf("Sync-IsolatedProxyRegistry $spec.proxyRegistry") < runnerPs.indexOf("$started = $proc.Start()"), "Proxy registry sync must happen before LS start");
        assert(runnerPs.includes("/v ProxyEnable /t REG_DWORD /d 1") && runnerPs.includes("/v ProxyServer /t REG_SZ") && runnerPs.includes("/v ProxyOverride /t REG_SZ"), "Runner must write ProxyEnable/ProxyServer/ProxyOverride");
        assert(runnerPs.includes("$server -notmatch"), "Runner must validate proxy server before building reg.exe command");
    }

    assert.strictEqual(Math.round(contrast.contrastRatio([0, 0, 0], [255, 255, 255])), 21);
    const tokens = contrast.getAdaptiveThemeTokens("248, 250, 252", "96, 165, 250", 0.24);
    assert(tokens.surface.primary, "Light surface tokens must resolve cleanly");

    console.log("[14/16] Testing P0-1 agyShellViews inline script compilation & token injection...");
    const shell = require(path.join(ROOT, "customization/modules/agyShellViews.js"));
    for (const [name, html] of [
        ["tabbar", shell.renderTabBarHtml(12345, "shell_tok_777")],
        ["picker", shell.renderPickerHtml(12345, "shell_tok_777")],
    ]) {
        const match = html.match(/<script>([\s\S]*?)<\/script>/);
        assert(match && match[1], `${name} must contain inline <script>`);
        new vm.Script(match[1], { filename: `agyShellViews.${name}.js` });
        assert(match[1].includes("shell_tok_777"), `${name} must embed API token`);
        assert(match[1].includes("X-Agy-Token"), `${name} must attach X-Agy-Token header`);
        assert(!match[1].includes("fetch(BASE_URL +"), `${name} must not use raw unauthenticated fetch(BASE_URL +`);
    }

    console.log("[15/16] Testing P0-4 OAuth deep-link initiator binding & IPC guard...");
    const prevLoad = Module._load;
    const stubMap = {
        "./constants": {},
        "./windowState": { MIN_WINDOW_WIDTH: 800, MIN_WINDOW_HEIGHT: 600 },
        "./utils": {},
        "./languageServer": {},
        "./authBootstrap": {},
        "./customScheme": {},
        "./externalUrl": {},
        "./debugConsole": {},
        "./keybindings": {},
        "./computer/previewViewers": {},
        "./wsl": {},
        "./actuator/mainClient": {},
    };
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(stubMap, request)) return stubMap[request];
        return prevLoad.apply(this, arguments);
    };
    let tabMgr;
    try {
        const tmPath = path.join(ROOT, "customization/modules/agyTabManager.js");
        delete require.cache[require.resolve(tmPath)];
        tabMgr = require(tmPath);
    } finally {
        Module._load = prevLoad;
    }

    assert.strictEqual(tabMgr.recordOAuthInitiator("acc_b", "https://accounts.google.com/o/oauth2/v2/auth?client_id=1", 1000), true);
    assert.strictEqual(tabMgr.recordOAuthInitiator("acc_evil", "https://evil.example/accounts.google.com", 1500), false, "Non-Google domain must not overwrite OAuth initiator");
    assert.strictEqual(tabMgr.recordOAuthInitiator("acc_evil", "http://accounts.google.com/o/oauth2/auth", 1600), false, "Plain HTTP must not be accepted as OAuth initiator");
    assert.strictEqual(tabMgr.consumeOAuthInitiator(300000, 2000), "acc_b", "OAuth initiator must resolve to acc_b");
    assert.strictEqual(tabMgr.consumeOAuthInitiator(300000, 2001), "", "OAuth initiator must be single-use");
    tabMgr.recordOAuthInitiator("acc_expired", "https://accounts.google.com/signin", 1000);
    assert.strictEqual(tabMgr.consumeOAuthInitiator(5000, 10000), "", "Expired OAuth initiator must return empty string");

    const mainPatchedCode = fs.readFileSync(path.join(ROOT, "customization/patched_system/main.js"), "utf8");
    const mainPatchDiff = fs.readFileSync(path.join(ROOT, "customization/patches/main.js.patch"), "utf8");
    assert(mainPatchedCode.includes("consumeOAuthInitiator"), "patched main.js must consume OAuth initiator");
    assert(mainPatchedCode.includes("isAuthorizedHubMainFrameEvent"), "deep-link:get-stored must check isAuthorizedHubMainFrameEvent");
    assert(mainPatchedCode.includes("getAccountIdForWebContents"), "deep-link:get-stored must verify sender accountId");
    assert(mainPatchDiff.includes("consumeOAuthInitiator"), "main.js.patch must stay synced with patched_system/main.js");

    console.log("[16/16] Testing P0-5 agyMediaDaemon LFI/SSRF/magic-bytes hardening...");
    const { _test: mediaTest } = require(path.join(ROOT, "customization/modules/agyMediaDaemon.js"));

    // Magic bytes detection
    assert.strictEqual(mediaTest.strictDetectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])), "image/png");
    assert.strictEqual(mediaTest.strictDetectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
    assert.strictEqual(mediaTest.strictDetectImageMime(Buffer.from("RIFF0000WEBP12345678", "ascii")), "image/webp");
    assert.strictEqual(mediaTest.strictDetectImageMime(Buffer.from("GIF89a01234567890123", "ascii")), "image/gif");
    assert.strictEqual(mediaTest.strictDetectImageMime(Buffer.from("-----BEGIN OPENSSH " + "PRIVATE KEY-----\nsecret", "utf8")), null, "Non-image file must be rejected");
    assert.strictEqual(mediaTest.strictDetectImageMime(Buffer.from("RIFF0000WAVE12345678", "ascii")), null, "WAV RIFF must not be accepted as WEBP");

    // Private/Reserved IP blocking
    for (const badIp of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.5.1", "192.168.1.10", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) {
        assert.strictEqual(mediaTest.isPrivateOrReservedIp(badIp), true, `Expected ${badIp} to be blocked as private/reserved`);
    }
    for (const goodIp of ["8.8.8.8", "1.1.1.1", "151.101.1.69", "2606:4700:4700::1111"]) {
        assert.strictEqual(mediaTest.isPrivateOrReservedIp(goodIp), false, `Expected public IP ${goodIp} to be allowed`);
    }

    // URL SSRF guard
    for (const badUrl of [
        "http://127.0.0.1:8080/secret",
        "http://localhost:3000/a.png",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:8080/a.png",
        "file:///etc/passwd",
        "javascript:alert(1)",
    ]) {
        assert.strictEqual(mediaTest.isSafePublicArtUrl(badUrl), false, `SSRF/unsafe URL must be rejected: ${badUrl}`);
    }
    assert.strictEqual(mediaTest.isSafePublicArtUrl("https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg"), true);
    const blockedFetch = await mediaTest.httpOrHttpsGetBuffer("http://127.0.0.1:9999/secret", 500);
    assert.strictEqual(blockedFetch, null, "httpOrHttpsGetBuffer must immediately reject loopback URLs");

    console.log("[17/20] Testing P0-10 async route safety, P0-12 context ring listener & P1-13 quota resilience...");
    const { extractUserTelemetryFromUserStatus: extractTelemetry } = require(path.join(ROOT, "customization/modules/agyExtras.js"));
    const agyAccMod = require(path.join(ROOT, "customization/modules/agyAccounts.js"));
    const { mediaDaemon: realMediaDaemon } = require(path.join(ROOT, "customization/modules/agyMediaDaemon.js"));

    // P1-13: Out-of-range protobuf timestamp must NOT throw RangeError; null remainingFraction must NOT coerce to 0%
    const edgeTelemetry = extractTelemetry({
        name: "Edge User",
        email: "edge@example.com",
        userTier: { name: "Pro Paid" },
        cascadeModelConfigData: {
            clientModelConfigs: [
                { label: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: null, resetTime: { seconds: 9e15, nanos: 0 } } },
                { label: "Gemini 4 Argon", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" } },
            ],
        },
    });
    assert(edgeTelemetry, "Must gracefully degrade on out-of-range timestamp without throwing");
    const sanitizedNull = agyAccMod.sanitizeQuotaList([
        { label: "Gemini 2.5 Flash", remainingFraction: null },
        { label: "Gemini 2.5 Pro", remainingFraction: "" },
    ], { name: "Trial" });
    assert.strictEqual(sanitizedNull[0].remainingFraction, -1, "null/empty remainingFraction must map to -1, not 0%");

    // P0-10: Rejected async route must be caught and return 500 JSON (never unhandledRejection)
    const origGetStatus = realMediaDaemon.getStatus;
    realMediaDaemon.getStatus = async () => { throw new Error("simulated_daemon_crash"); };
    try {
        const errResp = await invokeRoute("GET", "/media/rich");
        assert.strictEqual(errResp.status, 500, "Rejected async route must respond with 500");
        assert(errResp.body.includes("simulated_daemon_crash"), "500 body must report caught error safely");
    } finally {
        realMediaDaemon.getStatus = origGetStatus;
    }

    // P0-12: Context ring must NOT attach document mousedown inside createContextRingElement
    const ringFnMatch = exWithTok.match(/function createContextRingElement\(\)[\s\S]*?return ring;\s*\}/);
    assert(ringFnMatch && !ringFnMatch[0].includes('document.addEventListener("mousedown"'), "createContextRingElement must not leak document mousedown listener");

    console.log("[18/20] Testing P0-11 atomic agy_accounts.json save, .bak fallback & mutateAccounts...");
    const isoAccDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acc-atomic-"));
    const prevAccLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "electron") {
            return { app: { getPath: () => isoAccDir, getVersion: () => "2.35.0", isPackaged: false } };
        }
        if (request === "./paths") {
            return {
                getSharedConfigDir: () => isoAccDir,
                getActiveProfileName: () => "default",
            };
        }
        return prevAccLoad.apply(this, arguments);
    };
    try {
        const accPath = path.join(ROOT, "customization/modules/agyAccounts.js");
        delete require.cache[require.resolve(accPath)];
        const freshAcc = require(accPath);
        const accFile = path.join(isoAccDir, "agy_accounts.json");

        assert.strictEqual(freshAcc.saveAccounts([
            { id: "default", displayName: "Primary" },
            { id: "acc_test1", displayName: "Work" },
        ]), true);
        assert(fs.existsSync(accFile), "agy_accounts.json must exist after saveAccounts");

        // Second save creates .bak and mutates cleanly
        freshAcc.mutateAccounts((list) => {
            list.push({ id: "acc_test2", displayName: "Personal" });
        });
        assert(fs.existsSync(accFile + ".bak"), "saveAccounts must maintain .bak backup");
        assert.strictEqual(freshAcc.loadAccounts().length, 3, "mutateAccounts must persist 3 accounts");

        // Corrupt primary JSON -> loadAccounts must recover from .bak (not wipe to [default]!)
        fs.writeFileSync(accFile, "{truncated_corrupt_json", "utf8");
        const recovered = freshAcc.loadAccounts();
        assert(recovered.some((a) => a.id === "acc_test1"), "loadAccounts must recover accounts from .bak on primary corruption");
    } finally {
        Module._load = prevAccLoad;
        fs.rmSync(isoAccDir, { recursive: true, force: true });
    }

    console.log("[19/20] Testing P0-12 & P1-9 agyTabManager WebContentsView destroy, singleton window & open/close race...");
    {
        let baseWinCount = 0;
        let destroyedWcs = 0;
        let removedChildViews = 0;
        let stopActuatorCalls = 0;
        let resolveSlowLs = null;
        let failNextLs = false;

        class MockBaseWindow {
            constructor() {
                baseWinCount++;
                this._destroyed = false;
                this._events = new Map();
                this.contentView = {
                    addChildView() {},
                    removeChildView() { removedChildViews++; },
                    on() {},
                    off() {},
                };
            }
            isDestroyed() { return this._destroyed; }
            isMinimized() { return false; }
            restore() {}
            show() {}
            focus() {}
            setTitle() {}
            getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
            on(ev, fn) { this._events.set(ev, fn); }
            off() {}
        }
        class MockWebContentsView {
            constructor() {
                this._visible = true;
                this.webContents = {
                    id: Math.floor(Math.random() * 100000),
                    _dead: false,
                    isDestroyed() { return this._dead; },
                    destroy() { this._dead = true; destroyedWcs++; },
                    close() { this._dead = true; },
                    loadURL: async () => {},
                    executeJavaScript: async () => {},
                    setWindowOpenHandler() {},
                    removeAllListeners() {},
                    on() {}, once() {}, off() {},
                    getURL: () => "https://127.0.0.1:5000/",
                    focus() {},
                };
            }
            setVisible(v) { this._visible = v; }
            setBounds() {}
            setBackgroundColor() {}
        }

        const prevTmLoad = Module._load;
        const tmStubs = {
            electron: {
                BaseWindow: MockBaseWindow,
                WebContentsView: MockWebContentsView,
                View: class {},
                app: { getPath: () => os.tmpdir(), getName: () => "Antigravity", getVersion: () => "2.35.0", quit() {} },
                session: {
                    defaultSession: { closeAllConnections: async () => {} },
                    fromPartition: () => ({ closeAllConnections: async () => {} }),
                },
            },
            "./constants": { WINDOW_ORIGIN: "https://127.0.0.1" },
            "./windowState": { MIN_WINDOW_WIDTH: 800, MIN_WINDOW_HEIGHT: 600, resolveInitialWindowState: () => ({ width: 1200, height: 800 }), trackWindowState() {} },
            "./utils": {
                getHubCurtainColor: () => "#0a0b0f",
                buildHubCurtainDataUrl: () => "data:text/html,",
                isMacOS: () => false,
                registerTabHostWindow() {},
                registerWindowWebContents() {},
                registerAccountTabWebContents() {},
                setActiveHubViewForWindow() {},
                setTabBarHeightForWindow() {},
                setShowQuitConfirmation() {},
            },
            "./languageServer": {
                setupLocalCertTrustForSession() {},
                setActiveProfileServer() {},
                ensureProfileServer: (id) => new Promise((resolve, reject) => {
                    if (failNextLs) { failNextLs = false; reject(new Error("boot_failed")); return; }
                    if (id === "acc_race") { resolveSlowLs = () => resolve({ port: 55111, csrf: "csrf_race" }); return; }
                    resolve({ port: 55110, csrf: "csrf_ok" });
                }),
                stopProfileServer: async () => ({ ok: true }),
            },
            "./authBootstrap": {
                mintBootstrapTokenForInstance: async () => "btok",
                withBootstrapTokenFragment: (u) => u,
                redactUrlTokens: (u) => u,
                buildBootstrapEntryUrl: (u) => u,
                buildAuthenticatedWindowUrl: (u) => u,
                buildLsRestartWindowUrl: (u) => u,
            },
            "./customScheme": { registerCustomSchemeHandlersForSession() {} },
            "./externalUrl": { isSameOrigin: () => true, openExternalSafely: async () => {} },
            "./debugConsole": { isDebugConsoleEnabled: () => false },
            "./keybindings": { registerKeybindings() {} },
            "./computer/previewViewers": { registerPreviewViewer() {} },
            "./wsl": { getActiveWslDistro: () => "" },
            "./actuator/mainClient": {
                startMainActuatorClient() {},
                stopMainActuatorClient() { stopActuatorCalls++; },
            },
            "./wallpaperEngine": {
                readAppearanceConfig: () => ({}),
                ensureLocalServer() {},
                getLocalServerPort: () => 12345,
                getLocalServerToken: () => "tok_mock",
                attachWallpaperCspToSession() {},
                injectWallpaperUi() {},
            },
            "./agyAccounts": {
                getAccountById: (id) => ({ id, displayName: id, isolationReady: true }),
                updateRuntimeState() {},
                emitAccountsChanged() {},
                loadAccounts: () => [],
            },
        };
        Module._load = function (request, parent, isMain) {
            if (Object.prototype.hasOwnProperty.call(tmStubs, request)) return tmStubs[request];
            return prevTmLoad.apply(this, arguments);
        };
        try {
            const tmPath = path.join(ROOT, "customization/modules/agyTabManager.js");
            delete require.cache[require.resolve(tmPath)];
            const tm = require(tmPath);

            // 1. Concurrent createMainTabWindow must create only ONE BaseWindow
            const [w1, w2] = await Promise.all([tm.createMainTabWindow(null), tm.createMainTabWindow(null)]);
            assert.strictEqual(w1, w2, "Concurrent createMainTabWindow must return same BaseWindow instance");
            assert.strictEqual(baseWinCount, 1, "Must never instantiate duplicate BaseWindows");

            // 2. Open/close race: close arrives while ensureProfileServer is pending -> tab must NOT resurrect
            const openP = tm.openOrActivateAccount("acc_race");
            await new Promise((r) => setTimeout(r, 15));
            await tm.closeAccountTab("acc_race", { stopServer: true });
            assert(resolveSlowLs, "Slow LS promise must have started");
            resolveSlowLs();
            const openRes = await openP;
            assert.strictEqual(openRes.ok, false, "Superseded openOrActivateAccount must not succeed");
            assert(!tm.getOpenAccountIds().includes("acc_race"), "Closed account tab must never resurrect");

            // 3. Normal open + close must call webContents.destroy(), removeChildView(), and stopMainActuatorClient()
            const okOpen = await tm.openOrActivateAccount("default");
            assert.strictEqual(okOpen.ok, true);
            assert(tm.getOpenAccountIds().includes("default"));
            await tm.closeAccountTab("default", { stopServer: true });
            assert(destroyedWcs >= 1, "Closing a tab must call webContents.destroy()");
            assert(removedChildViews >= 1, "Closing a tab must call contentView.removeChildView()");
            assert(stopActuatorCalls >= 1, "Closing last tab with stopServer must stop mainActuator");

            // 4. Failed open with no open tabs must fall back to picker view
            failNextLs = true;
            const failRes = await tm.openOrActivateAccount("default");
            assert.strictEqual(failRes.ok, false);
            assert.strictEqual(tm.getViewMode(), "picker", "Failed start with zero open tabs must show picker");

            // 5. Isolated WebContentsView sessions are routed via Unlocker proxy with loopback bypass
            let mockProxy = { host: "127.0.0.1", port: 10809, hostPort: "127.0.0.1:10809", url: "http://127.0.0.1:10809", source: "registry" };
            tmStubs["./agyWinUserIsolation"] = { resolveUnlockerProxy: async () => mockProxy };
            const proxyCalls = [];
            const pxSes = { setProxy: async (cfg) => { proxyCalls.push(cfg); } };
            const defSes = { setProxy: async (cfg) => { proxyCalls.push({ def: cfg }); } };
            assert.strictEqual(await tm.applyAccountSessionProxy(defSes, "default"), null, "Default session must keep system proxy");
            assert.strictEqual(proxyCalls.length, 0);
            await tm.applyAccountSessionProxy(pxSes, "acc_px");
            assert.deepStrictEqual(proxyCalls[0], { proxyRules: "http://127.0.0.1:10809", proxyBypassRules: "localhost,127.0.0.1" });
            mockProxy = null;
            await tm.applyAccountSessionProxy(pxSes, "acc_px");
            assert.deepStrictEqual(proxyCalls[1], { mode: "system" }, "Unlocker off must revert previously proxied session to system");
            await tm.applyAccountSessionProxy(pxSes, "acc_px");
            assert.strictEqual(proxyCalls.length, 2, "Never-proxied session must not be touched when unlocker is off");
            delete tmStubs["./agyWinUserIsolation"];
        } finally {
            Module._load = prevTmLoad;
        }
    }

    console.log("[20/20] Testing P1-10 agyMediaDaemon & P1-11/P1-12 wallpaperEngine resilience...");
    const mediaCode = fs.readFileSync(path.join(ROOT, "customization/modules/agyMediaDaemon.js"), "utf8");
    assert(mediaCode.includes('appRef.on("will-quit"'), "agyMediaDaemon must dispose on will-quit, not before-quit");
    assert(mediaCode.includes('child.stdin?.on?.("error"'), "agyMediaDaemon must handle child.stdin EPIPE errors");
    assert(mediaCode.includes("rl.close()"), "agyMediaDaemon must close readline interface on cleanup");
    assert(mediaCode.includes("this._statusInFlight"), "agyMediaDaemon must coalesce concurrent getStatus calls");

    const wpCode = fs.readFileSync(path.join(ROOT, "customization/modules/wallpaperEngine.js"), "utf8");
    assert(wpCode.includes('bgVideo.removeAttribute("src"); bgVideo.load()'), "wallpaperEngine must release 4K video decoder on static switch");
    assert(wpCode.includes("const activeTint = resolveEffectiveTintRgb();"), "setAccentRgbEverywhere must use Personalization resolved tint");
    assert(!wpCode.includes("function isHostLightMode("), "Native host .light/data-theme detection must be completely disabled");
    assert(wpCode.includes('window.matchMedia("(prefers-color-scheme: dark)")'), "System theme mode must listen to prefers-color-scheme media query");
    assert(wpCode.includes("e.isSymbolicLink"), "wallpaper scanner must skip symlinks to avoid cycles");
    assert(wpCode.includes("fs.promises.copyFile"), "custom wallpaper add must use async copyFile");
    assert(wpCode.includes('srv.on("error"'), "local HTTP server must handle error events");

    console.log("[21/23] Testing P1-1 & P1-4 cross-profile isolation (customScheme, partition purge, paths sandbox, grantWorkspaceAccess)...");
    {
        // 1. customScheme per-session extensionAuthorities + loopback-only check
        const prevCsLoad = Module._load;
        const defaultSession = { name: "default" };
        const sesA = { name: "acc_a" };
        const sesB = { name: "acc_b" };
        Module._load = function (request, parent, isMain) {
            if (request === "electron") {
                return { session: { defaultSession }, protocol: { registerSchemesAsPrivileged() {}, handle() {} } };
            }
            if (request === "./faviconStore") return { FAVICON_SCHEME: "agy-favicon", lookupFaviconToken: () => undefined };
            if (request === "./redirects") return { fetchWithoutFollowing: async () => new Response(), pluginResponse: (r) => r };
            if (request === "./wallpaperEngine") return { registerWallpaperScheme() {}, registerWallpaperProtocol() {} };
            return prevCsLoad.apply(this, arguments);
        };
        try {
            const csPath = path.join(ROOT, "customization/patched_system/customScheme.js");
            delete require.cache[require.resolve(csPath)];
            const cs = require(csPath);

            assert.strictEqual(cs.isAllowedSidecarAuthorityUrl("http://127.0.0.1:41234"), true);
            assert.strictEqual(cs.isAllowedSidecarAuthorityUrl("https://localhost:8443"), true);
            assert.strictEqual(cs.isAllowedSidecarAuthorityUrl("https://evil.example:443"), false, "External authority URL must be rejected");
            assert.strictEqual(cs.isAllowedSidecarAuthorityUrl("file:///etc/passwd"), false, "file:// authority URL must be rejected");

            cs.setExtensionAuthoritiesForSession(sesA, {
                ext1: "http://127.0.0.1:40001",
                evil: "https://attacker.example",
            });
            cs.setExtensionAuthoritiesForSession(sesB, {
                ext1: "http://127.0.0.1:40002",
            });
            assert.strictEqual(cs.getExtensionAuthoritiesForSession(sesA).get("ext1"), "http://127.0.0.1:40001");
            assert.strictEqual(cs.getExtensionAuthoritiesForSession(sesA).has("evil"), false, "Non-loopback authority must be filtered");
            assert.strictEqual(cs.getExtensionAuthoritiesForSession(sesB).get("ext1"), "http://127.0.0.1:40002", "Session B must not overwrite Session A");
            assert.strictEqual(cs.extensionAuthorities.has("ext1"), false, "Default session must remain isolated from secondary sessions");
        } finally {
            Module._load = prevCsLoad;
        }

        // 2. agyAccounts.deleteAccount(purgeData=true) clears Chromium partition storage/cache and removes Partitions/agy_<id>
        const purgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-purge-"));
        const partDir = path.join(purgeRoot, "Partitions", "agy_acc_purge1");
        fs.mkdirSync(partDir, { recursive: true });
        fs.writeFileSync(path.join(partDir, "Cookies"), "secret_cookie");
        let clearedStorage = 0;
        let clearedCache = 0;
        const prevPurgeLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === "electron") {
                return {
                    app: { getPath: () => purgeRoot, getVersion: () => "2.35.0", isPackaged: false },
                    session: {
                        fromPartition: (part) => {
                            assert.strictEqual(part, "persist:agy_acc_purge1");
                            return {
                                clearStorageData: async () => { clearedStorage++; },
                                clearCache: async () => { clearedCache++; },
                            };
                        },
                    },
                };
            }
            if (request === "./paths") return { getSharedConfigDir: () => purgeRoot, getActiveProfileName: () => "default" };
            if (request === "./agyTabManager") return { hasMainWindow: () => true, closeAccountTab: async () => ({ ok: true }) };
            if (request === "./languageServer") return { stopProfileServer: async () => ({ ok: true }) };
            return prevPurgeLoad.apply(this, arguments);
        };
        try {
            const accPath = path.join(ROOT, "customization/modules/agyAccounts.js");
            delete require.cache[require.resolve(accPath)];
            const accMod = require(accPath);
            accMod.saveAccounts([
                { id: "default", displayName: "Primary" },
                { id: "acc_purge1", displayName: "To Delete" },
            ]);
            const delRes = await accMod.deleteAccount("acc_purge1", "default", true);
            assert.strictEqual(delRes.ok, true, "deleteAccount must succeed");
            assert.strictEqual(clearedStorage, 1, "deleteAccount must call ses.clearStorageData()");
            assert.strictEqual(clearedCache, 1, "deleteAccount must call ses.clearCache()");
            assert.strictEqual(fs.existsSync(partDir), false, "deleteAccount must delete Partitions/agy_<id>");
        } finally {
            Module._load = prevPurgeLoad;
            fs.rmSync(purgeRoot, { recursive: true, force: true });
        }

        // 3. paths.js::getGeminiDirForProfile must reject out-of-sandbox explicitDir
        const prevPathsLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === "./constants") return {};
            return prevPathsLoad.apply(this, arguments);
        };
        try {
            const pathsFile = path.join(ROOT, "customization/patched_system/paths.js");
            delete require.cache[require.resolve(pathsFile)];
            const pathsMod = require(pathsFile);
            const escapedDir = pathsMod.getGeminiDirForProfile("acc_sandbox", os.homedir());
            assert(
                escapedDir.toLowerCase().includes("acc_sandbox"),
                `Out-of-sandbox explicitDir must be rejected; got: ${escapedDir}`
            );
            const validExplicit = path.join(os.homedir(), ".gemini-profiles", "acc_sandbox", "sub");
            assert.strictEqual(
                pathsMod.getGeminiDirForProfile("acc_sandbox", validExplicit),
                path.resolve(validExplicit),
                "Valid subpath inside profile root must be accepted"
            );
        } finally {
            Module._load = prevPathsLoad;
        }

        // 4. agyWinUserIsolation.grantWorkspaceAccess validation (P1-4)
        if (process.platform === "win32") {
            const badUserRes = await iso.grantWorkspaceAccess("Administrator", "D:\\SomeProject");
            assert.strictEqual(badUserRes.ok, false);
            assert.strictEqual(badUserRes.error, "invalid_win_user", "Non-AgyAcc_* user must be rejected");
            const rootRes = await iso.grantWorkspaceAccess("AgyAcc_abcd1234", "C:\\");
            assert.strictEqual(rootRes.ok, false);
            assert.strictEqual(rootRes.error, "blocked_sensitive_root", "Drive root must be rejected");
            const homeRes = await iso.grantWorkspaceAccess("AgyAcc_abcd1234", os.homedir());
            assert.strictEqual(homeRes.ok, false);
            assert.strictEqual(homeRes.error, "blocked_sensitive_root", "User homedir root must be rejected");
            const otherAccRes = await iso.grantWorkspaceAccess("AgyAcc_abcd1234", path.join(iso.ACCOUNTS_DATA_ROOT, "acc_other"));
            assert.strictEqual(otherAccRes.ok, false);
            assert.strictEqual(otherAccRes.error, "blocked_sensitive_root", "Other isolated account directory must be rejected");
        }
    }

    console.log("[22/23] Testing P1-3 CSP tightening, config CSS sanitization, avatar validation & esc()...");
    {
        // 1. sanitizeAppearanceConfig blocks CSS injection & preserves valid values
        const cleanCfg = wp.sanitizeAppearanceConfig({
            accentRgb: "96, 165, 250",
            tintRgb: "12, 14, 20; background: url(https://evil.example)",
            uiFontChoice: "Segoe UI; } body { background: url(http://evil) }",
            customAccentHex: "#a855f7",
            privacyMode: true,
            panelAlpha: 99,
        });
        assert.strictEqual(cleanCfg.accentRgb, "96, 165, 250");
        assert.strictEqual(cleanCfg.tintRgb, undefined, "CSS-injected tintRgb must be stripped");
        assert.strictEqual(cleanCfg.uiFontChoice, undefined, "CSS-injected uiFontChoice must be stripped");
        assert.strictEqual(cleanCfg.customAccentHex, "#a855f7");
        assert.strictEqual(cleanCfg.privacyMode, true);
        assert.strictEqual(cleanCfg.panelAlpha, 1, "panelAlpha must clamp cleanly to 0..1");

        const safeFontCfg = wp.sanitizeAppearanceConfig({ uiFontChoice: "'Segoe UI Variable', system-ui, sans-serif" });
        assert.strictEqual(safeFontCfg.uiFontChoice, "'Segoe UI Variable', system-ui, sans-serif");

        // 2. Shell CSP header & no wildcard 127.0.0.1:* in attachWallpaperCspToSession
        const cspHeader = wp.buildShellCspHeader(43210);
        assert(cspHeader.includes("http://127.0.0.1:43210"), "Shell CSP must pin exact serverPort");
        assert(!cspHeader.includes("127.0.0.1:*"), "Shell CSP must never contain wildcard port");
        assert(cspHeader.includes("object-src 'none'") && cspHeader.includes("frame-ancestors 'none'"), "Shell CSP must forbid object/frame-ancestors");
        assert(!wpCode.includes("media-src http://127.0.0.1:*"), "wallpaperEngine.js must not inject wildcard media-src into session CSP");
        assert(!wpCode.includes("img-src http://127.0.0.1:*"), "wallpaperEngine.js must not inject wildcard img-src into session CSP");
        assert(!wpCode.includes("connect-src http://127.0.0.1:*"), "wallpaperEngine.js must not inject wildcard connect-src into session CSP");
        assert(wpCode.includes("const localOrigin = serverPort > 0 ? `http://127.0.0.1:${serverPort}`"), "attachWallpaperCspToSession must pin exact serverPort");

        // 3. Avatar URL sanitization
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("https://lh3.googleusercontent.com/a/avatar.png"), "https://lh3.googleusercontent.com/a/avatar.png");
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("http://127.0.0.1:12345/evil"), "", "Plain HTTP avatar must be stripped");
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("file://///evil-smb/share/a.png"), "", "file:// / SMB UNC avatar must be stripped");
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("javascript:alert(1)"), "", "javascript: avatar must be stripped");
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("data:image/svg+xml;base64,PHN2Zz4="), "", "SVG data URI avatar must be stripped");
        assert.strictEqual(agyAccMod.sanitizeAvatarUrl("data:image/png;base64," + "A".repeat(70000)), "", "Oversized data URI avatar must be stripped");

        // 4. agyShellViews esc() escapes single quotes too
        const shellCode = fs.readFileSync(path.join(ROOT, "customization/modules/agyShellViews.js"), "utf8");
        assert(shellCode.includes(`.replace(/'/g, "&#39;")`), "agyShellViews esc() must escape single quotes");
    }

    console.log("[23/23] Testing P1-5 Privacy Mode leak closure (OS title, tabbar/picker HTML, Shadow DOM) & P1-2 LS log redaction...");
    {
        // 1. OS window title must omit email when privacyMode is enabled
        let lastTitle = "";
        let mockPrivacy = true;
        let stopCalls = 0;
        const prevTitleLoad = Module._load;
        const titleStubs = {
            electron: {
                BaseWindow: class {
                    constructor() {
                        this.contentView = { addChildView() {}, removeChildView() {}, on() {}, off() {} };
                    }
                    isDestroyed() { return false; }
                    isMinimized() { return false; }
                    restore() {} show() {} focus() {}
                    setTitle(t) { lastTitle = t; }
                    getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
                    on() {} off() {}
                },
                WebContentsView: class {
                    constructor() {
                        this.webContents = {
                            id: 1,
                            isDestroyed: () => false,
                            destroy() {},
                            close() {},
                            loadURL: async () => {},
                            executeJavaScript: async () => {},
                            setWindowOpenHandler() {},
                            removeAllListeners() {},
                            on() {}, once() {}, off() {},
                            getURL: () => "https://127.0.0.1:5000/",
                            focus() {},
                        };
                    }
                    setVisible() {} setBounds() {} setBackgroundColor() {}
                },
                View: class {},
                app: { getPath: () => os.tmpdir(), getName: () => "Antigravity", getVersion: () => "2.35.0", quit() {} },
                session: {
                    defaultSession: { closeAllConnections: async () => {} },
                    fromPartition: () => ({ closeAllConnections: async () => {} }),
                },
            },
            "./constants": { WINDOW_ORIGIN: "https://127.0.0.1" },
            "./windowState": { MIN_WINDOW_WIDTH: 800, MIN_WINDOW_HEIGHT: 600, resolveInitialWindowState: () => ({ width: 1200, height: 800 }), trackWindowState() {} },
            "./utils": {
                getHubCurtainColor: () => "#0a0b0f",
                buildHubCurtainDataUrl: () => "data:text/html,",
                isMacOS: () => false,
                registerTabHostWindow() {},
                registerWindowWebContents() {},
                registerAccountTabWebContents() {},
                setActiveHubViewForWindow() {},
                setTabBarHeightForWindow() {},
                setShowQuitConfirmation() {},
            },
            "./languageServer": {
                setupLocalCertTrustForSession() {},
                setActiveProfileServer() {},
                ensureProfileServer: async () => ({ port: 55222, csrf: "csrf_priv" }),
                stopProfileServer: async () => { stopCalls++; return { ok: true }; },
            },
            "./authBootstrap": {
                mintBootstrapTokenForInstance: async () => "btok",
                withBootstrapTokenFragment: (u) => u,
                redactUrlTokens: (u) => u,
                buildBootstrapEntryUrl: (u) => u,
                buildAuthenticatedWindowUrl: (u) => u,
                buildLsRestartWindowUrl: (u) => u,
            },
            "./customScheme": { registerCustomSchemeHandlersForSession() {} },
            "./externalUrl": { isSameOrigin: () => true, openExternalSafely: async () => {} },
            "./debugConsole": { isDebugConsoleEnabled: () => false },
            "./keybindings": { registerKeybindings() {} },
            "./computer/previewViewers": { registerPreviewViewer() {} },
            "./wsl": { getActiveWslDistro: () => "" },
            "./actuator/mainClient": { startMainActuatorClient() {}, stopMainActuatorClient() {} },
            "./wallpaperEngine": {
                readAppearanceConfig: () => ({ privacyMode: mockPrivacy, stopServerOnTabClose: false }),
                ensureLocalServer() {},
                getLocalServerPort: () => 12345,
                getLocalServerToken: () => "tok_mock",
                attachWallpaperCspToSession() {},
                injectWallpaperUi() {},
            },
            "./agyAccounts": {
                getAccountById: (id) => ({ id, customLabel: "", displayName: "", email: "private.user@gmail.com", isolationReady: true }),
                updateRuntimeState() {},
                emitAccountsChanged() {},
                loadAccounts: () => [],
            },
        };
        Module._load = function (request, parent, isMain) {
            if (Object.prototype.hasOwnProperty.call(titleStubs, request)) return titleStubs[request];
            return prevTitleLoad.apply(this, arguments);
        };
        try {
            const tmPath = path.join(ROOT, "customization/modules/agyTabManager.js");
            delete require.cache[require.resolve(tmPath)];
            const tmPriv = require(tmPath);

            await tmPriv.createMainTabWindow(null);
            await tmPriv.openOrActivateAccount("default");
            assert(!lastTitle.includes("private.user@gmail.com"), `OS window title leaked email in privacy mode: ${lastTitle}`);

            mockPrivacy = false;
            tmPriv.updateWindowTitle();
            assert(lastTitle.includes("private.user@gmail.com"), `OS window title should show fallback email when privacy mode is off: ${lastTitle}`);

            // Also verify real stopServerOnTabClose=false is respected when closing tab without explicit stopServer flag
            await tmPriv.closeAccountTab("default", {});
            assert.strictEqual(stopCalls, 0, "closeAccountTab must NOT stop LS when stopServerOnTabClose is false");
        } finally {
            Module._load = prevTitleLoad;
        }

        // 2. Shell views & wallpaperEngine privacy invariants
        const shellHtmlTab = shell.renderTabBarHtml(12345, "t");
        const shellHtmlPick = shell.renderPickerHtml(12345, "t");
        assert(shellHtmlTab.includes("safeTipTitle"), "TabBar must hide email from tab.title in privacy mode");
        assert(shellHtmlTab.includes("title.includes(\"@\") ? ' tab-email'"), "TabBar must tag fallback email with .tab-email");
        assert(!shellHtmlTab.includes(".tab:hover .tab-email"), "TabBar must NOT reveal email merely by hovering entire .tab");
        assert(!shellHtmlPick.includes(".card:hover .ident-email"), "Picker must NOT reveal email merely by hovering entire .card");
        assert(shellHtmlPick.includes('[data-agy-privacy-reveal="hover"] .ident-email:hover'), "Picker hover reveal must apply only directly to the hidden element");
        assert(shellHtmlPick.includes(".ident-name.is-email"), "Picker must blur fallback email in .ident-name");
        assert(wpCode.includes("const INITIAL_PRIVACY ="), "wallpaperEngine must pass synchronous INITIAL_PRIVACY to avoid flash");
        assert(wpCode.includes("function formatPrimaryAccountOption(acc)"), "wallpaperEngine must mask email in Shadow DOM primary-account dropdown");

        // 3. P1-2: languageServer.js redacts auth/open URLs and blocks non-OAuth openExternal from isolated LS
        const lsCode = fs.readFileSync(path.join(ROOT, "customization/patched_system/languageServer.js"), "utf8");
        assert(lsCode.includes("redactUrlTokens)(authMatch[0])"), "languageServer.js must redact AUTH_URL_PATTERN in logs");
        assert(lsCode.includes("Blocked non-OAuth openExternal from isolated LS"), "languageServer.js must block non-OAuth openExternal for isolated LS");
        assert(lsCode.includes("openExternalSafely(openUrl, 'unconfirmed')"), "languageServer.js must route openUrl through openExternalSafely");
    }

    console.log("[24/25] Testing P2-1/P2-2/P2-3/P2-7 runtime optimizations (background tab pause, i18n EN disconnect, shell rename guard, port-0 guard)...");
    {
        // P2-1: Background tabs stop polling /media/rich, 250ms karaoke timer, and wallpaper rotation; SSE closes on pagehide
        assert(exWithTok.includes("if (!exState.showPlayer || !isTabVisible || document.visibilityState === \"hidden\") return;"), "refreshMedia must pause in hidden tabs");
        assert(exWithTok.includes("if (reqSeq !== mediaReqSeq) return;"), "refreshMedia must drop out-of-order responses");
        assert(exWithTok.includes("if (isTabVisible && mediaState.data.status === \"Playing\") updateProgressUi();"), "250ms karaoke timer must pause in hidden tabs");
        assert(exWithTok.includes("if (!r || !r.ok) return null;"), "syncRealUserToServer must commit lastSyncTs only after r.ok");
        assert(exWithTok.includes('window.addEventListener("pagehide"'), "agyExtras must close shared EventSource on pagehide");
        assert(wpCode.includes("if (!state.paused && tabVisible && document.visibilityState !== \"hidden\")"), "wallpaperEngine rotation timer must pause in hidden tabs");

        // P2-2: agyI18n disconnects MutationObserver in EN mode and fast-paths Cyrillic/numeric text
        let disconnectCalls = 0;
        let observeCalls = 0;
        const MockCustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
        const i18nSandbox = {
            window: {
                addEventListener() {},
                dispatchEvent() {},
                CustomEvent: MockCustomEvent,
            },
            CustomEvent: MockCustomEvent,
            localStorage: { getItem: () => null },
            document: {
                documentElement: { nodeType: 1, tagName: "HTML", matches: () => false, querySelectorAll: () => [], getAttribute: () => null, closest: () => null },
                body: { nodeType: 1, tagName: "BODY", matches: () => false, querySelectorAll: () => [], getAttribute: () => null, closest: () => null },
                createTreeWalker: () => ({ nextNode: () => null }),
            },
            NodeFilter: { SHOW_TEXT: 4 },
            MutationObserver: class {
                observe() { observeCalls++; }
                disconnect() { disconnectCalls++; }
                takeRecords() { return []; }
            },
            WeakMap, Map, Set, Object, Array, String, Number, Boolean, RegExp, JSON,
        };
        i18nSandbox.globalThis = i18nSandbox;
        vm.runInNewContext(buildI18nClientJs(), i18nSandbox, { filename: "agyI18n.p2.test.js" });
        assert.strictEqual(i18nSandbox.window.__agyI18n._isObserverActiveForTest(), true, "Observer should be active in default RU mode");
        assert(observeCalls >= 1, "Observer must start in RU mode");
        i18nSandbox.window.__agyI18n.setLang("en");
        assert.strictEqual(i18nSandbox.window.__agyI18n._isObserverActiveForTest(), false, "P2-2: Observer must disconnect in EN mode");
        assert(disconnectCalls >= 1, "disconnect() must be called when switching to EN");
        i18nSandbox.window.__agyI18n.setLang("ru");
        assert.strictEqual(i18nSandbox.window.__agyI18n._isObserverActiveForTest(), true, "Observer must re-activate when switching back to RU");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Уже переведённый текст"), null, "Fast-path must skip Cyrillic text");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("123456"), null, "Fast-path must skip pure digits");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("2m"), "2м", "Fast-path must NOT break short duration regexes");

        // P2-3: agyShellViews 30s interval must not clobber active rename/delete confirmation
        const shellCodeP2 = fs.readFileSync(path.join(ROOT, "customization/modules/agyShellViews.js"), "utf8");
        assert(shellCodeP2.includes("if (isVisible && !editingId && !confirmDelId) render();"), "P2-3: 30s interval must skip render during rename or delete confirm");
        assert(shellCodeP2.includes('window.addEventListener("pagehide"'), "agyShellViews must close EventSource on pagehide");

        // P2-7: wallpaperEngine port-0 guard + sequential exJs->wpJs chain; agyTabManager zoom finally + focus guard
        assert(wpCode.includes("Skipping UI injection: local server port unavailable"), "P2-7: waitAndInject must abort when serverPort is 0");
        assert(
            /\.finally\(\(\)\s*=>\s*\{\s*if\s*\(!hubContents\s*\|\|\s*hubContents\.isDestroyed\?\.\(\)\)\s*return;\s*Promise\.resolve\(hubContents\.executeJavaScript\(js,\s*true\)\)/.test(wpCode),
            "P2-7: wpJs must chain after exJs"
        );
        const tmCodeP2 = fs.readFileSync(path.join(ROOT, "customization/modules/agyTabManager.js"), "utf8");
        assert(
            /wc\.setZoomLevel\(stored\);\s*\}\s*finally\s*\{\s*restoring\s*=\s*false;\s*\}/.test(tmCodeP2),
            "P2-7: zoom restoring flag must reset in finally"
        );
        assert(tmCodeP2.includes("if (_pendingActivationAccountId && _pendingActivationAccountId !== accountId)"), "P2-7: activateNow must guard against stealing focus");
    }

    console.log("[25/25] Testing P2-4 & P2-5 hardening (MPRIS arg validation, LRU lyricsCache TTL, phantom account block, openPath & ACL cleanup)...");
    {
        // P2-4: MPRIS target & D-Bus object path validation
        assert.strictEqual(mediaTest.isValidMprisTarget("spotify"), true);
        assert.strictEqual(mediaTest.isValidMprisTarget("org.mpris.MediaPlayer2.vlc"), true);
        assert.strictEqual(mediaTest.isValidMprisTarget("--player=evil"), false, "Leading '-' flag injection must be rejected");
        assert.strictEqual(mediaTest.isValidMprisTarget("-f"), false, "Short flag injection must be rejected");
        assert.strictEqual(mediaTest.isValidMprisTarget("foo;rm -rf /"), false, "Shell metacharacters must be rejected");
        assert.strictEqual(mediaTest.isValidDbusObjectPath("/org/mpris/MediaPlayer2/track/1"), true);
        assert.strictEqual(mediaTest.isValidDbusObjectPath("--dest=evil"), false, "Invalid D-Bus path must be rejected");
        assert(mediaCode.includes('"--", trackId, String(usec)'), "gdbus seek must pass '--' before positional arguments");

        // P2-4: Bounded LRU lyricsCache + 30s TTL for negative misses
        mediaTest.lyricsCache.clear();
        const baseNow = 1_000_000;
        mediaTest.setLyricsCached("miss||track", { synced: "", plain: "", found: false }, baseNow);
        assert.strictEqual(mediaTest.getLyricsCached("miss||track", baseNow + 5000)?.found, false, "Recent miss should be cached within TTL");
        assert.strictEqual(mediaTest.getLyricsCached("miss||track", baseNow + mediaTest.LYRICS_MISS_TTL_MS + 1), null, "Negative miss must expire after 30s TTL");
        for (let i = 0; i < mediaTest.MAX_LYRICS_CACHE + 25; i++) {
            mediaTest.setLyricsCached(`k_${i}`, { synced: "[00:01.00]hi", plain: "hi", found: true }, baseNow + i);
        }
        assert.strictEqual(mediaTest.lyricsCache.size, mediaTest.MAX_LYRICS_CACHE, "lyricsCache must be bounded to MAX_LYRICS_CACHE (100)");
        assert.strictEqual(mediaTest.getLyricsCached("k_0", baseNow + 999), null, "Oldest LRU entry must be evicted");
        assert.strictEqual(mediaTest.getLyricsCached(`k_${mediaTest.MAX_LYRICS_CACHE + 24}`, baseNow + 999)?.found, true, "Newest entry must remain cached");

        // P2-5: syncCurrentAccount must NOT create phantom accounts for unknown accountId
        const phDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-phantom-"));
        const prevPhLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === "electron") return { app: { getPath: () => phDir, getVersion: () => "2.35.0", isPackaged: false } };
            if (request === "./paths") return { getSharedConfigDir: () => phDir, getActiveProfileName: () => "default" };
            return prevPhLoad.apply(this, arguments);
        };
        try {
            const accPath = path.join(ROOT, "customization/modules/agyAccounts.js");
            delete require.cache[require.resolve(accPath)];
            const accPh = require(accPath);
            accPh.saveAccounts([{ id: "default", displayName: "Primary" }]);
            const phRes = accPh.syncCurrentAccount("acc_phantom_999", { displayName: "Ghost", email: "ghost@example.com" });
            assert.strictEqual(phRes.ok, false, "Unknown accountId must be rejected by syncCurrentAccount");
            assert.strictEqual(phRes.error, "unknown_account");
            assert(!accPh.loadAccounts().some((a) => a.id === "acc_phantom_999"), "Phantom account must never be written to disk");
        } finally {
            Module._load = prevPhLoad;
            fs.rmSync(phDir, { recursive: true, force: true });
        }

        // P2-5: wallpaperEngine.isSafeOpenDirectory rejects UNC/relative/non-dir
        assert.strictEqual(wp.isSafeOpenDirectory(os.tmpdir()), true, "Existing absolute directory must be accepted");
        assert.strictEqual(wp.isSafeOpenDirectory("\\\\evil-smb-host\\share"), false, "UNC path must be rejected");
        assert.strictEqual(wp.isSafeOpenDirectory("relative/folder"), false, "Relative path must be rejected");
        assert.strictEqual(wp.isSafeOpenDirectory(path.join(os.tmpdir(), "definitely_missing_xyz_999")), false, "Non-existent path must be rejected");

        // P2-5: agyWinUserIsolation runs icacls /remove BEFORE Remove-LocalUser
        const adminRemoveIdx = adminPs.indexOf('if ($Action -eq "remove")');
        const removeSection = adminPs.slice(adminRemoveIdx);
        const icaclsRemIdx = removeSection.indexOf("/remove $winUser");
        const removeUserIdx = removeSection.indexOf("Remove-LocalUser -Name $winUser");
        assert(icaclsRemIdx > 0 && removeUserIdx > icaclsRemIdx, "P2-5: icacls /remove must run BEFORE Remove-LocalUser");
    }

    console.log("[26/26] Testing Personalization theme modes (Dark/Light/System), contrast, custom colors, custom fonts & native Appearance hider...");
    {
        const { EventEmitter } = require("events");
        const contrast = require(path.join(ROOT, "customization/modules/agyUiContrast.js"));

        // 1. Config sanitization for themeMode, uiContrast, customBgHex, customTextHex
        const validCfg = wp.sanitizeAppearanceConfig({
            themeMode: "light",
            uiContrast: "high",
            useCustomBg: true,
            customBgHex: "#FAF8F5",
            useCustomText: true,
            customTextHex: "#1E293B",
            customAccentHex: "#10B981",
            uiFontChoice: "'MyCustomFont', 'Segoe UI', system-ui, sans-serif",
        });
        assert.strictEqual(validCfg.themeMode, "light");
        assert.strictEqual(validCfg.uiContrast, "high");
        assert.strictEqual(validCfg.useCustomBg, true);
        assert.strictEqual(validCfg.customBgHex, "#faf8f5");
        assert.strictEqual(validCfg.useCustomText, true);
        assert.strictEqual(validCfg.customTextHex, "#1e293b");
        assert.strictEqual(validCfg.customAccentHex, "#10b981");
        assert.strictEqual(validCfg.uiFontChoice, "'MyCustomFont', 'Segoe UI', system-ui, sans-serif");

        const badCfg = wp.sanitizeAppearanceConfig({
            themeMode: "solarized",
            uiContrast: "ultra",
            customBgHex: "red; background: url(http://evil)",
            customTextHex: "#fff",
            uiFontChoice: "Bad; } body { color: red }",
        });
        assert.strictEqual(badCfg.themeMode, undefined, "Invalid themeMode must be stripped");
        assert.strictEqual(badCfg.uiContrast, undefined, "Invalid uiContrast must be stripped");
        assert.strictEqual(badCfg.customBgHex, undefined, "Invalid customBgHex must be stripped");
        assert.strictEqual(badCfg.customTextHex, undefined, "Non-6-hex customTextHex must be stripped");
        assert.strictEqual(badCfg.uiFontChoice, undefined, "CSS-injected uiFontChoice must be stripped");

        // 2. Custom fonts directory, upload, list, HTTP delivery (/fonts/...), path traversal & token rules
        const tmpFontsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fonts-test-"));
        const tmpFontsDir = path.join(tmpFontsRoot, "custom_fonts");
        fs.mkdirSync(tmpFontsDir, { recursive: true });
        try {
            const callFontsRoute = (method, urlPath, bodyObj = null) => new Promise((resolve) => {
                const req = new EventEmitter();
                req.method = method;
                req.headers = { host: "127.0.0.1:43210" };
                req.destroy = () => {};
                const chunks = [];
                const res = new EventEmitter();
                res.headersSent = false;
                res.statusCode = 200;
                res.headers = {};
                res.writeHead = (code, hdrs = {}) => {
                    res.statusCode = code;
                    res.headersSent = true;
                    Object.assign(res.headers, hdrs);
                };
                res.write = (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; };
                res.end = (c) => {
                    if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
                };
                const handled = wp.handleFontsRequest(
                    new URL("http://127.0.0.1:43210" + urlPath),
                    req,
                    res,
                    { getFontsDir: () => tmpFontsDir, broadcast: () => {} }
                );
                assert.strictEqual(handled, true, `Route ${urlPath} must be handled by handleFontsRequest`);
                if (bodyObj !== null) {
                    req.emit("data", Buffer.from(JSON.stringify(bodyObj)));
                    req.emit("end");
                }
            });

            // Upload all 4 supported font formats
            const fontSamples = [
                ["BrandSans.woff2", Buffer.from("wOF2test_woff2_payload"), "font/woff2", "woff2"],
                ["BrandMono.woff", Buffer.from("wOFFtest_woff_payload"), "font/woff", "woff"],
                ["ClassicUI.ttf", Buffer.from([0x00, 0x01, 0x00, 0x00, 0x54, 0x54, 0x46]), "font/ttf", "truetype"],
                ["DisplayPro.otf", Buffer.from("OTTOtest_otf_payload"), "font/otf", "opentype"],
            ];
            for (const [fname, payload, expectedMime, expectedFmt] of fontSamples) {
                const upRes = await callFontsRoute("POST", "/fonts/upload", {
                    fileName: fname,
                    dataBase64: payload.toString("base64"),
                });
                assert.strictEqual(upRes.status, 200, `Upload failed for ${fname}`);
                const parsed = JSON.parse(upRes.body.toString("utf8"));
                assert.strictEqual(parsed.ok, true);
                assert.strictEqual(parsed.font.fileName, fname);
                assert.strictEqual(parsed.font.mime, expectedMime);
                assert.strictEqual(parsed.font.format, expectedFmt);

                // Serve font file over HTTP /fonts/<fileName>
                const getRes = await callFontsRoute("GET", "/fonts/" + encodeURIComponent(fname));
                assert.strictEqual(getRes.status, 200, `GET /fonts/${fname} must return 200`);
                assert.strictEqual(getRes.headers["Content-Type"], expectedMime, `Wrong MIME for ${fname}`);
                assert.deepStrictEqual(getRes.body, payload, `Served bytes must match uploaded bytes for ${fname}`);
            }

            // List returns all 4 fonts
            const listRes = await callFontsRoute("GET", "/fonts/list");
            assert.strictEqual(listRes.status, 200);
            const listJson = JSON.parse(listRes.body.toString("utf8"));
            assert.strictEqual(listJson.fonts.length, 4, "All 4 uploaded fonts must be listed");

            // Reject invalid extension & path traversal
            const badExtRes = await callFontsRoute("POST", "/fonts/upload", {
                fileName: "malware.js",
                dataBase64: Buffer.from("alert(1)").toString("base64"),
            });
            assert.strictEqual(badExtRes.status, 400, "Non-font extension must be rejected");
            const travRes = await callFontsRoute("GET", "/fonts/..%2F..%2Fpackage.json");
            assert.strictEqual(travRes.status, 404, "Path traversal on /fonts/ must return 404");
            assert.strictEqual(wp.resolveCustomFontFile("../secret.ttf", tmpFontsDir), null);

            // Delete font
            const delRes = await callFontsRoute("POST", "/fonts/delete", { fileName: "DisplayPro.otf" });
            assert.strictEqual(delRes.status, 200);
            assert.strictEqual(JSON.parse(delRes.body.toString("utf8")).fonts.length, 3);

            // Token auth rules: ?t= allowed for /fonts/<file>, blocked for /fonts/upload and /fonts/list
            const tok = wp.getLocalServerToken();
            const fontFileQueryAuth = wp.validateLocalServerRequest(
                { method: "GET", headers: { host: "127.0.0.1:43210" } },
                new URL(`http://127.0.0.1:43210/fonts/BrandSans.woff2?t=${tok}`),
                { serverPort: 43210, token: tok, isAllowedOrigin: () => true }
            );
            assert.strictEqual(fontFileQueryAuth.ok, true, "@font-face URL with ?t= must be authorized");
            const fontUploadQueryAuth = wp.validateLocalServerRequest(
                { method: "POST", headers: { host: "127.0.0.1:43210" } },
                new URL(`http://127.0.0.1:43210/fonts/upload?t=${tok}`),
                { serverPort: 43210, token: tok, isAllowedOrigin: () => true }
            );
            assert.strictEqual(fontUploadQueryAuth.ok, false, "/fonts/upload must reject query token and require X-Agy-Token header");

            // CSP includes font-src for pinned serverPort
            const shellCsp = wp.buildShellCspHeader(43210);
            assert(shellCsp.includes("font-src 'self' http://127.0.0.1:43210 data: blob:"), "Shell CSP must allow font-src from local server");
            assert(wpCode.includes("font-src ${localOrigin} data: blob:"), "Session CSP hook must allow font-src from local server");
        } finally {
            fs.rmSync(tmpFontsRoot, { recursive: true, force: true });
        }

        // 3. Real client bundle VM test: Dark / Light / System live media query, Contrast, Custom Colors, FontFace registration, and Native Appearance tab hider
        const wpClientJs = wp.buildInjectedJs("default", wp.BASE_THEME, 43210, "tok_theme_test");
        new vm.Script(wpClientJs, { filename: "wallpaperEngine.client.js" });

        // Minimal realistic DOM tree for executing buildInjectedJs in Node VM
        const mkNode = (tag = "div", opts = {}) => {
            const attrs = new Map(Object.entries(opts.attrs || {}));
            const styleMap = new Map();
            const classSet = new Set(opts.classes || []);
            const children = [];
            const node = {
                tagName: tag.toUpperCase(),
                nodeType: 1,
                id: opts.id || "",
                _ownText: opts.text || "",
                innerHTML: "",
                value: "",
                parentElement: null,
                children,
                isConnected: true,
                dataset: {},
                classList: {
                    add: (...a) => a.forEach((x) => classSet.add(x)),
                    remove: (...a) => a.forEach((x) => classSet.delete(x)),
                    toggle: (x, f) => (f === undefined ? (classSet.has(x) ? (classSet.delete(x), false) : (classSet.add(x), true)) : (f ? (classSet.add(x), true) : (classSet.delete(x), false))),
                    contains: (x) => classSet.has(x),
                },
                style: {
                    colorScheme: "",
                    get color() { return styleMap.get("color") || ""; },
                    set color(v) { styleMap.set("color", String(v)); },
                    setProperty: (k, v) => styleMap.set(k, String(v)),
                    getPropertyValue: (k) => styleMap.get(k) || "",
                },
                get textContent() {
                    if (children.length === 0) return node._ownText;
                    return node._ownText + children.map((c) => c.textContent).join(" ");
                },
                set textContent(v) {
                    node._ownText = String(v ?? "");
                    children.length = 0;
                },
                get nextElementSibling() {
                    if (!node.parentElement) return null;
                    const idx = node.parentElement.children.indexOf(node);
                    return idx >= 0 && idx + 1 < node.parentElement.children.length ? node.parentElement.children[idx + 1] : null;
                },
                setAttribute: (k, v) => attrs.set(k, String(v)),
                getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
                removeAttribute: (k) => attrs.delete(k),
                hasAttribute: (k) => attrs.has(k),
                addEventListener() {},
                removeEventListener() {},
                appendChild(c) {
                    if (c && typeof c === "object") {
                        c.parentElement = node;
                        children.push(c);
                    }
                    return c;
                },
                prepend(c) {
                    if (c && typeof c === "object") {
                        c.parentElement = node;
                        children.unshift(c);
                    }
                },
                append(...items) {
                    for (const c of items) node.appendChild(c);
                },
                remove() {},
                play: () => Promise.resolve(),
                pause() {},
                load() {},
                getContext: () => null,
                getBoundingClientRect: () => ({ top: 0, bottom: 32, left: 0, right: 300, width: 300, height: 32 }),
                contains(target) {
                    let cur = target;
                    while (cur) {
                        if (cur === node) return true;
                        cur = cur.parentElement;
                    }
                    return false;
                },
                matches(sel) {
                    return sel.split(",").map((s) => s.trim()).some((part) => {
                        if (part.startsWith("#")) return node.id === part.slice(1);
                        if (part.startsWith(".")) return classSet.has(part.slice(1));
                        const attrSub = /^\[([a-z0-9-]+)\*=["']([^"']+)["']\]$/i.exec(part);
                        if (attrSub) {
                            if (attrSub[1] === "style") return Array.from(styleMap.entries()).some(([k, v]) => `${k}:${v}`.includes(attrSub[2]));
                            return String(node.getAttribute(attrSub[1]) || "").includes(attrSub[2]);
                        }
                        const attrEq = /^\[([a-z0-9-]+)=["']([^"']+)["']\]$/i.exec(part);
                        if (attrEq) return node.getAttribute(attrEq[1]) === attrEq[2];
                        const attrHas = /^\[([a-z0-9-]+)\]$/i.exec(part);
                        if (attrHas) return node.hasAttribute(attrHas[1]);
                        return node.tagName.toLowerCase() === part.toLowerCase();
                    });
                },
                closest(sel) {
                    let cur = node;
                    while (cur) {
                        if (cur.matches(sel)) return cur;
                        cur = cur.parentElement;
                    }
                    return null;
                },
                querySelectorAll(sel) {
                    const out = [];
                    const walk = (n) => {
                        for (const ch of n.children) {
                            if (ch.matches(sel)) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(node);
                    return out;
                },
                querySelector(sel) {
                    return node.querySelectorAll(sel)[0] || null;
                },
                attachShadow() {
                    const sr = mkNode("shadow-root");
                    const dummyCache = new Map();
                    const getDummy = (sel) => {
                        if (!dummyCache.has(sel)) {
                            const d = mkNode("div", { id: sel.replace(/^#/, "") });
                            d.querySelectorAll = () => [];
                            d.querySelector = (s) => getDummy(s);
                            dummyCache.set(sel, d);
                        }
                        return dummyCache.get(sel);
                    };
                    sr.getElementById = (id) => sr.querySelector("#" + id);
                    sr.querySelector = (sel) => {
                        const real = mkNode("div").querySelector.call(sr, sel);
                        return real || getDummy(sel);
                    };
                    sr.querySelectorAll = (sel) => {
                        const out = [];
                        const walk = (n) => {
                            for (const ch of n.children) {
                                if (ch.matches(sel)) out.push(ch);
                                walk(ch);
                            }
                        };
                        walk(sr);
                        return out;
                    };
                    node.shadowRoot = sr;
                    return sr;
                },
            };
            return node;
        };

        const docEl = mkNode("html");
        const headEl = mkNode("head");
        const bodyEl = mkNode("body");
        docEl.append(headEl, bodyEl);

        // Construct realistic Antigravity Settings -> Appearance DOM (RU)
        const splitRoot = mkNode("div", { attrs: { "data-split-root": "true" } });
        const sidebarWrap = mkNode("div");
        const settingsSidebar = mkNode("div", { attrs: { "data-testid": "settings-sidebar" } });
        const navAppearance = mkNode("button", {
            attrs: { "data-testid": "settings-nav-item-appearance" },
            classes: ["bg-sidebar-secondary"],
            text: "Внешний вид",
        });
        settingsSidebar.appendChild(navAppearance);
        sidebarWrap.appendChild(settingsSidebar);

        const settingsPane = mkNode("div", { attrs: { "data-main-content-body": "true" } });
        const secAppearance = mkNode("section", { id: "sec-appearance" });
        secAppearance.append(
            mkNode("h2", { text: "Внешний вид" }),
            mkNode("div", { text: "Тема Контрастность Шрифт Размер шрифта" })
        );
        const secLight = mkNode("section", { id: "sec-light" });
        secLight.append(
            mkNode("h2", { text: "Светлая тема" }),
            mkNode("div", { text: "Пресет Фон Текст Акцент Предпросмотр кода" })
        );
        const secDark = mkNode("section", { id: "sec-dark" });
        secDark.append(
            mkNode("h2", { text: "Тёмная тема" }),
            mkNode("div", { text: "Пресет Фон Текст Акцент Предпросмотр кода" })
        );
        const secChat = mkNode("section", { id: "sec-chat" });
        secChat.append(
            mkNode("h2", { text: "Чат" }),
            mkNode("div", { text: "Шаги диалога Подробно" })
        );
        const secChatLayout = mkNode("section", { id: "sec-chat-layout" });
        secChatLayout.append(
            mkNode("h2", { text: "Макет чата" }),
            mkNode("div", { text: "Ширина диалога Стандартный" })
        );
        const secA11y = mkNode("section", { id: "sec-a11y" });
        secA11y.append(
            mkNode("h2", { text: "Спецвозможности" }),
            mkNode("div", { text: "Режим экранного диктора" })
        );
        settingsPane.append(secAppearance, secLight, secDark, secChat, secChatLayout, secA11y);
        splitRoot.append(sidebarWrap, settingsPane);
        bodyEl.appendChild(splitRoot);

        // Controllable matchMedia mock for System theme live change testing
        const mqListeners = [];
        const mockMq = {
            matches: true,
            addEventListener: (ev, fn) => { if (ev === "change") mqListeners.push(fn); },
            removeEventListener() {},
        };
        const addedFontFaces = [];
        const docFonts = { add: (ff) => addedFontFaces.push(ff) };
        class MockFontFace {
            constructor(family, source, desc) {
                this.family = family;
                this.source = source;
                this.desc = desc;
            }
            load() { return Promise.resolve(this); }
        }

        const MockCustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
        const wpSandbox = {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                matchMedia: (q) => (q === "(prefers-color-scheme: dark)" ? mockMq : { matches: false, addEventListener() {} }),
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() {},
                CustomEvent: MockCustomEvent,
            },
            CustomEvent: MockCustomEvent,
            document: {
                documentElement: docEl,
                head: headEl,
                body: bodyEl,
                hidden: false,
                visibilityState: "visible",
                fonts: docFonts,
                createElement: (t) => mkNode(t),
                getElementById: (id) => docEl.querySelector("#" + id),
                querySelector: (sel) => docEl.querySelector(sel),
                querySelectorAll: (sel) => docEl.querySelectorAll(sel),
                addEventListener() {},
                removeEventListener() {},
            },
            FontFace: MockFontFace,
            localStorage: { getItem: () => null, setItem() {} },
            MutationObserver: class { observe() {} disconnect() {} },
            EventSource: class { addEventListener() {} close() {} },
            fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ videos: [], fonts: [] }) }),
            requestAnimationFrame: (fn) => { fn(); return 1; },
            setTimeout: () => 1,
            clearTimeout() {},
            setInterval: () => 1,
            clearInterval() {},
            console,
            Math, Date, Number, String, Boolean, Array, Object, Set, Map, JSON, RegExp, Error, Promise, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent,
        };
        wpSandbox.window.window = wpSandbox.window;
        wpSandbox.window.document = wpSandbox.document;
        wpSandbox.globalThis = wpSandbox;

        vm.runInNewContext(wpClientJs, wpSandbox, { filename: "wallpaperEngine.runtime.test.js" });

        const api = wpSandbox.window.__agyThemeApi;
        assert(api, "__agyThemeApi must be exposed on window");

        // 3a. Native Appearance blocks hidden, functional blocks & sidebar preserved
        assert.strictEqual(secAppearance.getAttribute("data-agy-hidden-native-appearance"), "1", "Native 'Внешний вид' block must be hidden");
        assert.strictEqual(secLight.getAttribute("data-agy-hidden-native-appearance"), "1", "Native 'Светлая тема' block must be hidden");
        assert.strictEqual(secDark.getAttribute("data-agy-hidden-native-appearance"), "1", "Native 'Тёмная тема' block must be hidden");
        assert.strictEqual(secChat.getAttribute("data-agy-hidden-native-appearance"), null, "'Чат' (Шаги диалога) MUST stay visible");
        assert.strictEqual(secChatLayout.getAttribute("data-agy-hidden-native-appearance"), null, "'Макет чата' (Ширина диалога) MUST stay visible");
        assert.strictEqual(secA11y.getAttribute("data-agy-hidden-native-appearance"), null, "'Спецвозможности' (Режим экранного диктора) MUST stay visible");
        assert.strictEqual(navAppearance.getAttribute("data-agy-hidden-native-appearance"), null, "Settings sidebar nav item MUST stay visible");

        // Also test English flat sibling layout (heading + card without <section> wrapper)
        settingsPane.children.length = 0;
        const enHApp = mkNode("h2", { text: "Appearance" });
        const enCardApp = mkNode("div", { text: "Theme Contrast Font Font Size" });
        const enHLight = mkNode("h2", { text: "Light Theme" });
        const enCardLight = mkNode("div", { text: "Preset Background Foreground Accent Code Preview" });
        const enHDark = mkNode("h2", { text: "Dark Theme" });
        const enCardDark = mkNode("div", { text: "Preset Background Foreground Accent Code Preview" });
        const enHChat = mkNode("h2", { text: "Chat" });
        const enCardChat = mkNode("div", { text: "Conversation Steps" });
        const enHLayout = mkNode("h2", { text: "Chat Layout" });
        const enCardLayout = mkNode("div", { text: "Conversation Width" });
        const enHA11y = mkNode("h2", { text: "Accessibility" });
        const enCardA11y = mkNode("div", { text: "Screen Reader Mode" });
        settingsPane.append(enHApp, enCardApp, enHLight, enCardLight, enHDark, enCardDark, enHChat, enCardChat, enHLayout, enCardLayout, enHA11y, enCardA11y);
        wpSandbox.window.__agyAppearanceSanitizer.scan(wpSandbox.document);
        for (const hiddenEl of [enHApp, enCardApp, enHLight, enCardLight, enHDark, enCardDark]) {
            assert.strictEqual(hiddenEl.getAttribute("data-agy-hidden-native-appearance"), "1", `EN visual block '${hiddenEl.textContent}' must be hidden`);
        }
        for (const keptEl of [enHChat, enCardChat, enHLayout, enCardLayout, enHA11y, enCardA11y]) {
            assert.strictEqual(keptEl.getAttribute("data-agy-hidden-native-appearance"), null, `EN functional block '${keptEl.textContent}' MUST remain visible`);
        }

        // 3b. Native host .light / data-theme / data-color-mode MUST NOT affect our dark theme!
        docEl.classList.add("light");
        docEl.setAttribute("data-theme", "light");
        docEl.setAttribute("data-color-mode", "light");
        const darkPal = api.setState({ themeMode: "dark", darkUseCustomBg: false, darkUseCustomText: false });
        assert.strictEqual(darkPal.effectiveMode, "dark");
        assert.strictEqual(darkPal.isLightSurface, false);
        assert.strictEqual(docEl.dataset.agyThemeMode, "dark");
        assert.strictEqual(docEl.style.getPropertyValue("--agy-tint-rgb"), "12, 14, 20");
        assert.strictEqual(docEl.style.getPropertyValue("--foreground"), "#f8fafc");

        // 3b-reg. Chat mentioning "Внешний вид"/"Светлая тема"/"Тёмная тема" + composer MUST NEVER be hidden when Settings is closed!
        bodyEl.children.length = 0;
        const chatBody = mkNode("div", { attrs: { "data-main-content-body": "true" } });
        const chatMsgH = mkNode("h2", { text: "Светлая тема" });
        const chatMsgP = mkNode("div", { text: "Внешний вид Светлая тема Тёмная тема Чат Макет чата Спецвозможности" });
        const chatComposer = mkNode("div", { classes: ["surface-composer"] });
        chatComposer.append(mkNode("div", { attrs: { contenteditable: "true" }, text: "Спросите что угодно" }));
        chatBody.append(chatMsgH, chatMsgP, chatComposer);
        bodyEl.appendChild(chatBody);
        const hiddenInChat = wpSandbox.window.__agyAppearanceSanitizer.scan(wpSandbox.document);
        assert.strictEqual(hiddenInChat, 0, "Regular chat viewport must NEVER hide any elements");
        assert.strictEqual(chatComposer.getAttribute("data-agy-hidden-native-appearance"), null, "Chat prompt composer must NEVER be hidden");
        assert.strictEqual(chatMsgH.getAttribute("data-agy-hidden-native-appearance"), null, "Chat messages mentioning themes must NEVER be hidden");

        // 3c. Real Light theme mode -> clean light translucent surface + dark readable text
        const lightPal = api.setState({ themeMode: "light", uiContrast: "default", lightUseCustomBg: false, lightUseCustomText: false });
        assert.strictEqual(lightPal.effectiveMode, "light");
        assert.strictEqual(lightPal.isLightSurface, true);
        assert.strictEqual(docEl.dataset.agyThemeMode, "light");
        assert.strictEqual(docEl.style.getPropertyValue("--agy-tint-rgb"), "250, 251, 254");
        assert.strictEqual(docEl.style.getPropertyValue("--foreground"), "#111827");
        assert(
            contrast.contrastRatio(contrast.parseRgb(lightPal.fg), contrast.parseRgb(lightPal.tintRgb)) >= 12,
            "Light mode text must have high WCAG contrast on light surface"
        );

        // 3c-reg. Panel opacity slider directly controls --agy-effective-alpha & --agy-surface-modal-alpha without being pinned at 0.95 by autoContrast
        api.setState({ themeMode: "light", uiContrast: "default", autoContrast: true, panelAlpha: 0.30, dim: 0.36 });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-effective-alpha"), "0.300", "Panel opacity 30% must directly reflect in --agy-effective-alpha");
        api.setState({ panelAlpha: 0.85 });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-effective-alpha"), "0.850", "Panel opacity 85% must directly reflect in --agy-effective-alpha");

        // 3c-reg2. Auto-contrast toggle OFF -> ON properly recomputes lumaBoost even when wallpaperDarkLuma === 0
        api.setState({ themeMode: "light", autoContrast: false, dim: 0.30 });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-luma-boost"), "0.000", "Auto-contrast OFF must set luma-boost to 0");
        api.setState({ themeMode: "light", autoContrast: true, dim: 0.30 });
        assert(parseFloat(docEl.style.getPropertyValue("--agy-luma-boost")) > 0, "Auto-contrast re-enabled in light mode must restore non-zero luma-boost");

        // 3d. System theme mode live reaction to OS matchMedia change
        mockMq.matches = true;
        api.setState({ themeMode: "system" });
        assert.strictEqual(docEl.dataset.agyThemeMode, "dark", "System mode with dark OS must resolve to dark");
        mockMq.matches = false;
        assert(mqListeners.length >= 1, "System theme mode must register matchMedia change listener");
        mqListeners.forEach((fn) => fn({ matches: false }));
        assert.strictEqual(docEl.dataset.agyThemeMode, "light", "System mode must react live when OS switches to light");
        assert.strictEqual(docEl.style.getPropertyValue("--agy-tint-rgb"), "250, 251, 254");

        // 3e. High contrast mode strengthens borders & text contrast
        const defaultLightBorder = docEl.style.getPropertyValue("--agy-border");
        const hcLightPal = api.setState({ themeMode: "light", uiContrast: "high" });
        assert.strictEqual(docEl.dataset.agyContrast, "high");
        assert.strictEqual(hcLightPal.fg, "#000000", "High contrast light mode must use pure black primary text");
        assert.notStrictEqual(docEl.style.getPropertyValue("--agy-border"), defaultLightBorder, "High contrast must strengthen border color");

        // 3f. Separate custom colors for Dark and Light themes + no native OS color input
        assert(!wpCode.includes('type="color"'), "Must use custom HSL/HEX picker instead of native OS color input");
        api.setState({
            themeMode: "dark",
            uiContrast: "default",
            darkUseCustomBg: true,
            darkCustomBgHex: "#1e1b4b",
            darkUseCustomText: true,
            darkCustomTextHex: "#fef08a",
            darkCustomAccentHex: "#10b981",
            lightUseCustomBg: true,
            lightCustomBgHex: "#fffbeb",
            lightUseCustomText: true,
            lightCustomTextHex: "#1c1917",
            lightCustomAccentHex: "#d97706",
            adaptiveAccent: false,
        });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-tint-rgb"), "30, 27, 75");
        assert.strictEqual(docEl.style.getPropertyValue("--foreground"), "#fef08a");
        assert.strictEqual(docEl.style.getPropertyValue("--agy-accent-rgb"), "16, 185, 129");
        api.setState({ themeMode: "light" });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-tint-rgb"), "255, 251, 235", "Light theme must use its own separate custom background");
        assert.strictEqual(docEl.style.getPropertyValue("--foreground"), "#1c1917", "Light theme must use its own separate custom text color");
        assert.strictEqual(docEl.style.getPropertyValue("--agy-accent-rgb"), "217, 119, 6", "Light theme must use its own separate custom accent");

        // 3g. Custom font registration via @font-face & FontFace API + application
        api.registerCustomFonts([
            {
                id: "font_TestSans.woff2",
                fileName: "TestSans.woff2",
                name: "TestSans",
                family: "TestSans",
                cssValue: "'TestSans', 'Segoe UI', system-ui, sans-serif",
                format: "woff2",
                urlPath: "/fonts/TestSans.woff2",
            },
        ]);
        const fontStyleEl = docEl.querySelector("#agy-custom-fonts-css");
        assert(fontStyleEl && fontStyleEl.textContent.includes('@font-face{font-family:"TestSans"'), "@font-face must be injected into document");
        assert(fontStyleEl.textContent.includes("/fonts/TestSans.woff2?t=tok_theme_test"), "@font-face src must include auth token");
        assert(addedFontFaces.some((f) => f.family === "TestSans"), "FontFace API must register uploaded font in document.fonts");
        api.setState({ uiFontChoice: "'TestSans', 'Segoe UI', system-ui, sans-serif" });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-ui-font"), "'TestSans', 'Segoe UI', system-ui, sans-serif");
        assert.strictEqual(docEl.style.getPropertyValue("--font-sans"), "'TestSans', 'Segoe UI', system-ui, sans-serif");

        // 4. Regression: Strict CSS isolation (never use :has(.code-line) or :has() on [data-tiling-pane] / [data-main-content-body])
        const injectedCss = wp.buildInjectedCss(wp.BASE_THEME);
        assert(!injectedCss.includes(":has(.code-line)"), "CSS must NEVER use fragile :has(.code-line) selector");
        assert(!/\[data-tiling-pane\][^\n{]*:has\(/i.test(injectedCss), "CSS must NEVER attach :has() to [data-tiling-pane]");
        assert(!/\[data-main-content-body\][^\n{]*:has\(/i.test(injectedCss), "CSS must NEVER attach :has() to [data-main-content-body]");
        assert(
            injectedCss.includes("[data-tiling-pane],\n[data-pane-id]") && injectedCss.includes("background-color: transparent !important;"),
            "Chat tiling panes must stay transparent so wallpaper remains visible"
        );
        assert(
            injectedCss.includes(":is(.file-viewer-root, [data-testid=\"file-viewer\"], .diff-view-mode-detail, .monaco-diff-editor, .monaco-editor, .cm-editor)"),
            "Editor/diff surface must target strictly editor/diff containers"
        );

        // 5. Regression: Unified Surface Layers scale linearly with panelAlpha across ALL layers regardless of reduceBackdropBlur, and data-agy-surface updates live
        const layerKeys = [
            "--agy-surface-base-alpha",
            "--agy-surface-sidebar-alpha",
            "--agy-surface-card-alpha",
            "--agy-surface-composer-alpha",
            "--agy-surface-editor-alpha",
            "--agy-surface-modal-alpha",
        ];
        api.setState({ themeMode: "light", uiContrast: "default", lightUseCustomBg: false, panelAlpha: 0.25, reduceBackdropBlur: true });
        assert.strictEqual(docEl.dataset.agySurface, "light", "data-agy-surface must update dynamically to light");
        const lowNoBlur = Object.fromEntries(layerKeys.map((k) => [k, parseFloat(docEl.style.getPropertyValue(k))]));
        api.setState({ reduceBackdropBlur: false });
        const lowWithBlur = Object.fromEntries(layerKeys.map((k) => [k, parseFloat(docEl.style.getPropertyValue(k))]));
        assert.deepStrictEqual(lowNoBlur, lowWithBlur, "Surface layer alphas must be identical with and without backdrop-blur");

        api.setState({ panelAlpha: 0.90, reduceBackdropBlur: true });
        const highNoBlur = Object.fromEntries(layerKeys.map((k) => [k, parseFloat(docEl.style.getPropertyValue(k))]));
        for (const k of layerKeys) {
            assert(highNoBlur[k] > lowNoBlur[k] + 0.30, `${k} must increase substantially with panelAlpha (${lowNoBlur[k]} -> ${highNoBlur[k]})`);
            const surfaceVar = k.replace(/-alpha$/, "");
            assert(docEl.style.getPropertyValue(surfaceVar).startsWith("rgba(250, 251, 254,"), `${surfaceVar} must resolve with light tint`);
        }

        // High contrast lifts scrim and surface alphas cleanly
        api.setState({ themeMode: "light", uiContrast: "high", panelAlpha: 0.50 });
        assert.strictEqual(docEl.style.getPropertyValue("--agy-hc-scrim-lift"), "0.12");
        const hcBaseAlpha = parseFloat(docEl.style.getPropertyValue("--agy-surface-base-alpha"));
        api.setState({ uiContrast: "default", panelAlpha: 0.50 });
        const defBaseAlpha = parseFloat(docEl.style.getPropertyValue("--agy-surface-base-alpha"));
        assert(hcBaseAlpha > defBaseAlpha, "High contrast must raise surface base alpha over default contrast");

        // Switching back to dark mode updates data-agy-surface to dark
        api.setState({ themeMode: "dark", darkUseCustomBg: false });
        assert.strictEqual(docEl.dataset.agySurface, "dark", "data-agy-surface must update dynamically back to dark");

        // 6. Regression: Chat containing .code-line stays isolated, while pale syntax tokens inside code/diff adapt cleanly in Light mode & restore in Dark mode
        bodyEl.children.length = 0;
        const chatPaneWithCode = mkNode("div", { attrs: { "data-tiling-pane": "true" } });
        const chatBodyWithCode = mkNode("div", { attrs: { "data-main-content-body": "true" } });
        const chatCodeBlock = mkNode("div", { classes: ["code-block"] });
        const chatCodeLine = mkNode("div", { classes: ["code-line"] });
        const pastelMintSpan = mkNode("span", { text: "const x = 1;" });
        pastelMintSpan.style.setProperty("color", "#a6e3a1");
        const pastelYellowSpan = mkNode("span", { text: "'hello'" });
        pastelYellowSpan.style.setProperty("color", "#f9e2af");
        chatCodeLine.append(pastelMintSpan, pastelYellowSpan);
        chatCodeBlock.appendChild(chatCodeLine);
        chatBodyWithCode.appendChild(chatCodeBlock);
        chatPaneWithCode.appendChild(chatBodyWithCode);
        bodyEl.appendChild(chatPaneWithCode);

        // Switch to Light mode -> pastel tokens must be adapted to WCAG >= 4.8:1
        api.setState({ themeMode: "light", uiContrast: "default", lightUseCustomBg: false });
        const adaptedCnt = api.adaptCodeSyntax(wpSandbox.document);
        assert.strictEqual(adaptedCnt, 2, "Both pastel tokens in .code-line must adapt in Light mode");
        assert.strictEqual(pastelMintSpan.getAttribute("data-agy-code-adapted"), "1");
        assert.strictEqual(pastelMintSpan.getAttribute("data-agy-orig-color"), "#a6e3a1");
        const adaptedMint = pastelMintSpan.style.getPropertyValue("color");
        const adaptedYellow = pastelYellowSpan.style.getPropertyValue("color");
        assert(
            contrast.contrastRatio(contrast.parseRgb(adaptedMint), [250, 251, 254]) >= 4.8,
            `Adapted green syntax color (${adaptedMint}) must have >= 4.8 contrast on light surface`
        );
        assert(
            contrast.contrastRatio(contrast.parseRgb(adaptedYellow), [250, 251, 254]) >= 4.8,
            `Adapted yellow syntax color (${adaptedYellow}) must have >= 4.8 contrast on light surface`
        );

        // Switch back to Dark mode -> original colors must be restored cleanly
        api.setState({ themeMode: "dark", darkUseCustomBg: false });
        api.adaptCodeSyntax(wpSandbox.document);
        assert.strictEqual(pastelMintSpan.getAttribute("data-agy-code-adapted"), null, "Dark mode must unmark adapted token when original is readable");
        assert.strictEqual(pastelMintSpan.style.getPropertyValue("color"), "#a6e3a1", "Dark mode must restore original syntax color");

        // 7. Regression: agyShellViews (TabBar & Picker) synchronize surface layers, contrast & per-mode custom colors
        const shellMod = require(path.join(ROOT, "customization/modules/agyShellViews.js"));
        const pickerHtml = shellMod.renderPickerHtml(43210, "tok_shell_sync");
        const pickerScript = pickerHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
        const shDocEl = mkNode("html");
        const shHead = mkNode("head");
        const shBody = mkNode("body");
        shDocEl.append(shHead, shBody);
        const shById = new Map();
        for (const id of ["bg-video", "bg-img", "banner", "banner-text", "grid", "hdr-title", "hdr-sub", "new-label", "lbl-add", "btn-lang", "add-form"]) {
            shById.set(id, mkNode(id === "add-form" ? "form" : "div", { id }));
        }
        const shMqListeners = [];
        const shMq = { matches: true, addEventListener: (ev, fn) => { if (ev === "change") shMqListeners.push(fn); } };
        const shCfg = {
            themeMode: "system",
            uiContrast: "high",
            panelAlpha: 0.45,
            reduceBackdropBlur: true,
            darkUseCustomBg: true,
            darkCustomBgHex: "#111827",
            lightUseCustomBg: true,
            lightCustomBgHex: "#fff7ed",
            lightUseCustomText: true,
            lightCustomTextHex: "#1c1917",
        };
        const shSandbox = {
            window: {
                innerWidth: 1200,
                innerHeight: 800,
                matchMedia: () => shMq,
                addEventListener() {},
                CustomEvent: MockCustomEvent,
            },
            document: {
                documentElement: shDocEl,
                head: shHead,
                body: shBody,
                createElement: (t) => mkNode(t),
                getElementById: (id) => shById.get(id) || shDocEl.querySelector("#" + id),
                addEventListener() {},
            },
            EventSource: class { addEventListener() {} close() {} },
            fetch: (url) => {
                if (String(url).includes("/extras/config")) return Promise.resolve({ json: () => Promise.resolve({ lang: "ru" }) });
                if (String(url).includes("/config")) return Promise.resolve({ json: () => Promise.resolve(shCfg) });
                if (String(url).includes("/list")) return Promise.resolve({ json: () => Promise.resolve({ videos: [] }) });
                if (String(url).includes("/accounts/list")) return Promise.resolve({ json: () => Promise.resolve({ accounts: [] }) });
                if (String(url).includes("/fonts/list")) return Promise.resolve({ json: () => Promise.resolve({ fonts: [] }) });
                return Promise.resolve({ json: () => Promise.resolve({}) });
            },
            setTimeout: () => 1,
            clearTimeout() {},
            setInterval: () => 1,
            console,
            Math, Date, Number, String, Boolean, Array, Object, Set, Map, JSON, RegExp, Error, Promise, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent,
        };
        shSandbox.window.window = shSandbox.window;
        shSandbox.window.document = shSandbox.document;
        shSandbox.globalThis = shSandbox;
        vm.runInNewContext(pickerScript, shSandbox, { filename: "agyShellViews.picker.sync.test.js" });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(shDocEl.dataset.agyThemeMode, "dark");
        assert.strictEqual(shDocEl.dataset.agyContrast, "high");
        assert.strictEqual(shDocEl.dataset.agyNoBlur, "1");
        assert.strictEqual(shDocEl.style.getPropertyValue("--agy-tint-rgb"), "17, 24, 39");
        assert(shDocEl.style.getPropertyValue("--agy-surface-card").startsWith("rgba(17, 24, 39,"), "Picker must compute --agy-surface-card");
        // OS switches to light while themeMode === "system"
        shMq.matches = false;
        shMqListeners.forEach((fn) => fn({ matches: false }));
        assert.strictEqual(shDocEl.dataset.agyThemeMode, "light");
        assert.strictEqual(shDocEl.dataset.agySurface, "light");
        assert.strictEqual(shDocEl.style.getPropertyValue("--agy-tint-rgb"), "255, 247, 237", "Picker system light mode must apply lightCustomBgHex");
        assert.strictEqual(shDocEl.style.getPropertyValue("--agy-fg"), "#1c1917", "Picker system light mode must apply lightCustomTextHex");

        // 8. Regression: agyExtras syncs Light/High-Contrast surface & hover tokens cleanly
        const exBundleForSync = require(path.join(ROOT, "customization/modules/agyExtras.js")).buildExtrasClientJs("default", 43210, "tok_ex_sync");
        assert(exBundleForSync.includes("--agy-extras-hover"), "agyExtras must sync --agy-extras-hover for Light/Dark compatibility");
        assert(exBundleForSync.includes("--agy-extras-surface-modal"), "agyExtras must sync --agy-extras-surface-modal");
        assert(exBundleForSync.includes("agy-fonts-sync"), "agyExtras must sync custom @font-face into its Shadow DOM");
    }

    console.log("[27/27] Testing Phase 1-4 audit regressions (UI contrast alpha/4-8 hex, SSRF IPv6 hex, HTTP shell/profile token isolation, Range/font magic, i18n, Picker/Extras DOM)...");
    {
        // 1. agyUiContrast: #RGBA / #RRGGBBAA + alpha blending + 0.45 threshold parity
        const contrastMod = require(path.join(ROOT, "customization/modules/agyUiContrast.js"));
        assert.deepStrictEqual(contrastMod.parseRgb("#38bdf880"), [56, 189, 248]);
        assert.deepStrictEqual(contrastMod.parseRgb("#f84c"), [255, 136, 68]);
        const medLightSurf = [184, 184, 184]; // L ~ 0.479 (in [0.45, 0.50))
        const fixedAcc = contrastMod.ensureReadableAccentOnSurface("#ffffff", medLightSurf, 4.5);
        assert(
            contrastMod.contrastRatio(contrastMod.parseRgb(fixedAcc), medLightSurf) >= 4.5,
            `ensureReadableAccentOnSurface on medium-light surface must reach >= 4.5 (got ${fixedAcc})`
        );
        const lowAlphaAdapted = contrastMod.ensureReadableSyntaxColor("rgba(100, 100, 100, 0.25)", "#fafafa", 4.8);
        assert(lowAlphaAdapted && lowAlphaAdapted.startsWith("rgba("), "Low-alpha text over light surface must be alpha-blended & adapted");
        const hex8Adapted = contrastMod.ensureReadableSyntaxColor("#a6e3a1cc", "#fafbfe", 4.8);
        assert(hex8Adapted && hex8Adapted.startsWith("rgba("), "8-digit hex syntax color must preserve alpha & adapt contrast");

        // 2. agyMediaDaemon: hex IPv4-mapped IPv6 SSRF + dispose unblocks ensureStarted + lyricsInFlight export
        const { _test: mdTest } = require(path.join(ROOT, "customization/modules/agyMediaDaemon.js"));
        for (const badV6 of ["::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:c0a8:101", "64:ff9b::127.0.0.1"]) {
            assert.strictEqual(mdTest.isPrivateOrReservedIp(badV6), true, `Must block hex/NAT64 IPv6 SSRF vector: ${badV6}`);
        }
        assert.strictEqual(mdTest.isPrivateOrReservedIp("::ffff:0808:0808"), false, "Public IPv4-mapped hex IPv6 must remain allowed");
        assert(mdTest.lyricsInFlight instanceof Map, "fetchLyrics must track in-flight requests");

        // 3. agyI18n: conversation rows, non-tree file/branch lists, non-duration trailing text, short branch/status labels, and setLang unchanged
        const convRow = makeMockNode("div", "", { "data-testid": "conversation-row-sidebar" });
        const convTitle = makeMockNode("span", "", {}, convRow);
        assert.strictEqual(window.__agyI18n._shouldSkipElementForTest(convTitle), true, "Sidebar conversation row must be skipped");
        const branchList = makeMockNode("div", "", { "data-testid": "branch-list" });
        const branchSpan = makeMockNode("span", "", {}, branchList);
        assert.strictEqual(window.__agyI18n._shouldSkipElementForTest(branchSpan), true, "Branch list item must be skipped");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Updated main.rs"), null, "Non-duration after Updated must not match");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Created feature_1m"), null, "Non-duration after Created must not corrupt token");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Updated 5m ago"), "Обновлено 5 мин назад");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Restart to Update →"), "Перезапустить для обновления →");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Raw"), "Исходник");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Switch to RTL text direction"), "Переключить направление текста (RTL)");
        assert.strictEqual(window.__agyI18n._translateTextForTest("View Diff"), "Показать отличия");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Open in Antigravity IDE"), "Открыть в Antigravity IDE");
        assert.strictEqual(window.__agyI18n._translateTextForTest("Updated 0:30"), "Обновлено 0:30");

        // 4. wallpaperEngine & agyExtras: SHELL_TOKEN isolation, per-profile binding, readJsonBody 400/413, grant-folder/rename validation, font magic bytes, Range & CSP chaining
        const shellTok = wp.getShellServerToken();
        assert(/^[a-f0-9]{64}$/.test(shellTok), "SHELL_TOKEN must be 64-char hex");
        assert.notStrictEqual(shellTok, tok, "SHELL_TOKEN must be distinct from SERVER_TOKEN");
        const acc1Tok = wp.getProfileServerToken("acc_1");
        assert.notStrictEqual(acc1Tok, tok, "Isolated profile token must be distinct from default token");
        assert.notStrictEqual(acc1Tok, shellTok, "Profile token must be distinct from SHELL_TOKEN");
        assert.strictEqual(wp.getProfileIdForToken(acc1Tok), "acc_1");

        const acc1Js = wp.buildInjectedJs("acc_1", wp.BASE_THEME, 12345, acc1Tok);
        const acc1Ex = buildExtrasClientJs("acc_1", 12345, acc1Tok);
        assert(!acc1Js.includes(shellTok) && !acc1Ex.includes(shellTok), "Tab bundles must NEVER embed SHELL_TOKEN");

        const tabDelDeny = wp.validateLocalServerRequest(
            mkReq("POST", { host: "127.0.0.1:12345", "x-agy-token": acc1Tok }),
            new URL("http://127.0.0.1:12345/accounts/delete"),
            { serverPort: 12345, token: tok, shellToken: shellTok, resolveProfileToken: wp.getProfileIdForToken }
        );
        assert.strictEqual(tabDelDeny.ok, false);
        assert.strictEqual(tabDelDeny.status, 403, "Tab token must be rejected from shell-only route /accounts/delete");

        const tabPickerDeny = wp.validateLocalServerRequest(
            mkReq("GET", { host: "127.0.0.1:12345" }),
            new URL(`http://127.0.0.1:12345/shell/picker?t=${acc1Tok}`),
            { serverPort: 12345, token: tok, shellToken: shellTok, resolveProfileToken: wp.getProfileIdForToken }
        );
        assert.strictEqual(tabPickerDeny.ok, false);
        assert.strictEqual(tabPickerDeny.status, 403, "Tab token must not fetch /shell/picker even via header or query");

        const shellDelAllow = wp.validateLocalServerRequest(
            mkReq("POST", { host: "127.0.0.1:12345", "x-agy-token": shellTok }),
            new URL("http://127.0.0.1:12345/accounts/delete"),
            { serverPort: 12345, token: tok, shellToken: shellTok, resolveProfileToken: wp.getProfileIdForToken }
        );
        assert.strictEqual(shellDelAllow.ok, true);
        assert.strictEqual(shellDelAllow.authRole, "shell");

        // Spoofed sync-current & missing-id rename / grant-folder / bad JSON / oversized JSON
        const extrasMod = require(path.join(ROOT, "customization/modules/agyExtras.js"));
        const callWithCtx = (method, urlPath, rawBody, ctx = {}) => new Promise((resolve) => {
            const req = new EventEmitter();
            req.method = method;
            req.headers = { host: "127.0.0.1:12345", "content-type": "application/json", "x-agy-token": acc1Tok };
            req.destroy = () => {};
            const res = {
                status: 0, headersSent: false, writableEnded: false, destroyed: false, body: "",
                writeHead(code) { this.status = code; this.headersSent = true; },
                end(chunk = "") { this.body += String(chunk); this.writableEnded = true; resolve(this); },
            };
            extrasMod.handleExtrasRequest(new URL(`http://127.0.0.1:12345${urlPath}`), req, res, 12345, null, ctx);
            if (rawBody !== null) {
                req.emit("data", Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
                req.emit("end");
            }
        });

        const spoofSync = await callWithCtx("POST", "/accounts/sync-current", JSON.stringify({ accountId: "default", email: "evil@attacker" }), { authRole: "tab", authProfile: "acc_1" });
        assert.strictEqual(spoofSync.status, 403, "Tab acc_1 must not spoof sync-current for default");

        const badRename = await callWithCtx("POST", "/accounts/rename", JSON.stringify({ label: "NewName" }), { authRole: "shell" });
        assert.strictEqual(badRename.status, 400, "/accounts/rename without id must fail 400 instead of renaming default");

        const badGrant = await callWithCtx("POST", "/accounts/grant-folder", JSON.stringify({}), { authRole: "shell" });
        assert.strictEqual(badGrant.status, 400, "/accounts/grant-folder without id must fail 400 before native dialog");

        const badExtrasJson = await callWithCtx("POST", "/extras/config", "{broken", { authRole: "shell" });
        assert.strictEqual(badExtrasJson.status, 400, "Malformed JSON on /extras/config must return 400");

        const hugePayload = await callWithCtx("POST", "/extras/config", Buffer.alloc(210000, 65), { authRole: "shell" });
        assert.strictEqual(hugePayload.status, 413, "Oversized JSON on /extras/config must return 413");

        const sanitizedExtras = extrasMod.sanitizeExtrasConfig({
            lang: "en",
            showPlayer: false,
            evilKey: "dropme",
            onboardingDismissedProfiles: { acc_1: true, default: false },
        }, { authRole: "tab", authProfile: "acc_1" });
        assert.strictEqual(sanitizedExtras.lang, "en");
        assert.strictEqual(sanitizedExtras.evilKey, undefined, "Unknown keys must be stripped from extras config");
        assert.deepStrictEqual(sanitizedExtras.onboardingDismissedProfiles, { acc_1: true }, "Tab must only write its own onboarding profile flag");

        // Font magic bytes & stream Range helper & CSP chaining
        assert.strictEqual(wp.saveCustomFontBuffer("evil.ttf", Buffer.from("<html>alert</html>")), null, "Fake TTF magic bytes must be rejected");
        assert.deepStrictEqual(wp.parseByteRangeHeader("bytes=-100", 1000), { ok: true, start: 900, end: 999 });
        assert.strictEqual(wp.parseByteRangeHeader("bytes=-0", 1000).ok, false);
        assert.strictEqual(wp.parseByteRangeHeader("bytes=-", 1000).ok, false);
        assert.strictEqual(wp.parseByteRangeHeader("items=0-10", 1000).ok, false);

        let registeredMaster = null;
        const mockSession = {
            webRequest: {
                onHeadersReceived(_f, fn) { registeredMaster = fn; },
            },
        };
        wp.attachWallpaperCspToSession(mockSession);
        assert.strictEqual(typeof registeredMaster, "function");
        let extCalled = false;
        mockSession.webRequest.onHeadersReceived((d, cb) => {
            extCalled = true;
            cb({ responseHeaders: { ...(d.responseHeaders || {}), "X-Ext": ["1"] } });
        });
        let chainedOut = null;
        registeredMaster({ url: "https://example.com/page", responseHeaders: { "Content-Security-Policy": ["default-src 'self'"] } }, (out) => {
            chainedOut = out;
        });
        assert.strictEqual(extCalled, true, "Chained external onHeadersReceived listener must still invoke");
        assert.deepStrictEqual(chainedOut.responseHeaders["X-Ext"], ["1"]);

        // 5. CSS & UI contracts: --accent-foreground, .filter-tabs 4 cols, Picker .st-sq & Escape guard
        const builtCss = wp.buildInjectedCss(wp.BASE_THEME);
        assert(builtCss.includes("--accent-foreground: var(--agy-on-solid-accent)"), "--accent-foreground must map to --agy-on-solid-accent");
        assert(!wpCode.includes("#cpicker-wrap") && !wpCode.includes("#s-primary-acc"), "Dead #cpicker-wrap and #s-primary-acc must be removed");
        assert(wpCode.includes("grid-template-columns: 1fr 1fr 1fr auto"), ".filter-tabs must fit all 4 buttons in one row");

        const shellViewsSrc = fs.readFileSync(path.join(ROOT, "customization/modules/agyShellViews.js"), "utf8");
        assert(shellViewsSrc.includes('class="st-sq \' + esc(st.key)'), "Picker .st-sq must include st.key class");
        assert(shellViewsSrc.includes("deferredAccountsRender"), "Picker must defer SSE accounts re-render during rename/confirm");
        assert(shellViewsSrc.includes("cancelRename"), "Picker inline rename must guard Escape against blur commit");

        // 6. agyAccounts serializeAccount preserves legacy isolationMode on Windows
        const savedSer = agyAccMod.serializeAccount({ id: "acc_leg", isolationMode: "legacy", email: "leg@example.com" });
        const expectedIsoMode = process.platform === "win32" ? "legacy" : "profile";
        assert.strictEqual(savedSer.isolationMode, expectedIsoMode, "serializeAccount must preserve 'legacy' isolationMode on win32");
    }

    console.log("[28/28] Testing unified contrast tokens, player open-mode state machine, recording-safe privacy, and full settings sync...");
    {
        const contrast = require(path.join(ROOT, "customization/modules/agyUiContrast.js"));
        const extrasMod = require(path.join(ROOT, "customization/modules/agyExtras.js"));
        const wp = require(path.join(ROOT, "customization/modules/wallpaperEngine.js"));
        const shell = require(path.join(ROOT, "customization/modules/agyShellViews.js"));

        // 1. Unified buildUiDesignTokens & computeEffectiveScrimOpacity
        assert.strictEqual(
            contrast.computeEffectiveScrimOpacity(0.36, 0.10, false),
            0.46,
            "computeEffectiveScrimOpacity must combine dim + boost when highContrast=false"
        );
        assert.strictEqual(
            contrast.computeEffectiveScrimOpacity(0.36, 0.10, true),
            0.479,
            "computeEffectiveScrimOpacity must combine boost & scaled hcLift smoothly without over-darkening"
        );
        assert(
            contrast.computeEffectiveScrimOpacity(0.85, 0.25, true) <= 0.90,
            "computeEffectiveScrimOpacity must clamp safely at 0.90 in high contrast"
        );
        const hcDarkBadCustom = contrast.buildUiDesignTokens({
            effectiveMode: "dark",
            tintRgb: "12, 14, 20",
            accentRgb: "96, 165, 250",
            uiContrast: "high",
            panelAlpha: 0.68,
            reduceBackdropBlur: true,
            panelBlurPx: 20,
            useCustomText: true,
            customTextHex: "#475569", // unreadable low contrast on dark bg
        });
        assert(
            contrast.contrastRatio(contrast.parseRgb(hcDarkBadCustom.fg), [12, 14, 20]) >= 7.0,
            "High contrast must enforce >= 7.0:1 text contrast even with dim customTextHex"
        );
        assert.strictEqual(hcDarkBadCustom.panelBlurPx, 0, "reduceBackdropBlur must force panelBlurPx to 0");
        assert(hcDarkBadCustom.surfacePopover.includes("0.980") || hcDarkBadCustom.surfacePopover.includes("0.97"), "Popover surface must stay opaque enough without blur");

        const lightTok = contrast.buildUiDesignTokens({
            effectiveMode: "light",
            tintRgb: "250, 251, 254",
            accentRgb: "245, 158, 11",
            uiContrast: "default",
            panelAlpha: 0.65,
            reduceBackdropBlur: false,
            panelBlurPx: 16,
        });
        assert(lightTok.isLightSurface, "Light palette must detect light surface");
        assert.strictEqual(lightTok.panelBlurPx, 16, "panelBlurPx must apply when reduceBackdropBlur is false");
        assert.strictEqual(lightTok.sliderThumbBg, "#0f172a", "Light surface slider thumb must be dark for clear edge visibility");
        assert(
            contrast.contrastRatio(contrast.parseRgb(lightTok.accentText), [250, 251, 254]) >= 4.5,
            "Light accentText must satisfy WCAG 4.5:1"
        );

        // 2. Font sanitization preserves Unicode family names & sanitization parity
        assert.strictEqual(wp.sanitizeFontFileName("Шрифт Бета.woff2"), "Шрифт Бета.woff2");
        assert.strictEqual(wp.deriveFontFamilyName("Шрифт_Бета.woff2"), "Шрифт Бета");
        const parsedAppearance = wp.sanitizeAppearanceConfig({
            panelBlurPx: 50,
            privacyRevealMode: "never",
            privacyHideStyle: "mask",
            privacyHidePaths: false,
        });
        assert.strictEqual(parsedAppearance.panelBlurPx, 32, "panelBlurPx must clamp to max 32");
        assert.strictEqual(parsedAppearance.privacyRevealMode, "never");
        assert.strictEqual(parsedAppearance.privacyHideStyle, "mask");
        assert.strictEqual(parsedAppearance.privacyHidePaths, false);

        const sanEx = extrasMod.sanitizeExtrasConfig({
            playerOpenMode: "hover",
            lyricsOffsetSec: 5,
        });
        assert.strictEqual(sanEx.playerOpenMode, "hover");
        assert.strictEqual(sanEx.hoverOpenPlayer, true, "playerOpenMode='hover' must mirror hoverOpenPlayer=true");
        assert.strictEqual(sanEx.lyricsOffsetSec, 5, "lyricsOffsetSec must support full [-5, 5] range");
        const sanExLegacy = extrasMod.sanitizeExtrasConfig({ hoverOpenPlayer: false });
        assert.strictEqual(sanExLegacy.playerOpenMode, "click", "Legacy hoverOpenPlayer=false must migrate to 'click'");

        // 3. Monaco CSS & adaptCodeSyntax never double-invert Monaco editors
        const wpCss = wp.buildInjectedCss(wp.BASE_THEME);
        assert(!wpCss.includes(".monaco-editor:is(.vs-dark, .hc-black) :is(.view-lines, .margin-view-overlays"), "Monaco inversion CSS must NOT invert .margin-view-overlays diff gutters");
        assert(!wpCss.includes('html[data-agy-theme-mode="light"] {\n    --agy-tint-rgb'), "Conflicting unconditional data-agy-theme-mode='light' --agy-tint-rgb override must be removed");

        // 4. Live VM test for agyExtras strict hover vs click player open mode + recording privacy (mask & mixed parents)
        const timers = [];
        let nextTimerId = 1;
        const fakeMkEl = (tag, id = "") => {
            const attrs = new Map();
            const classes = new Set();
            const listeners = new Map();
            const styleMap = new Map();
            if (id) attrs.set("id", id);
            const node = {
                nodeType: 1,
                tagName: tag.toUpperCase(),
                id,
                children: [],
                childNodes: [],
                dataset: {},
                className: "",
                textContent: "",
                value: "",
                disabled: false,
                isConnected: true,
                parentElement: null,
                parentNode: null,
                classList: {
                    add: (...c) => c.forEach((x) => classes.add(x)),
                    remove: (...c) => c.forEach((x) => classes.delete(x)),
                    toggle: (c, force) => {
                        const on = force === undefined ? !classes.has(c) : Boolean(force);
                        if (on) classes.add(c);
                        else classes.delete(c);
                        return on;
                    },
                    contains: (c) => classes.has(c),
                },
                style: {
                    setProperty: (k, v) => styleMap.set(k, String(v)),
                    getPropertyValue: (k) => styleMap.get(k) || "",
                    cssText: "",
                },
                setAttribute: (k, v) => attrs.set(k, String(v)),
                getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
                hasAttribute: (k) => attrs.has(k),
                removeAttribute: (k) => attrs.delete(k),
                addEventListener: (ev, fn) => {
                    if (!listeners.has(ev)) listeners.set(ev, []);
                    listeners.get(ev).push(fn);
                },
                removeEventListener: () => {},
                dispatchEvent: (ev) => {
                    for (const fn of listeners.get(ev.type) || []) fn(ev);
                },
                trigger(evName, evObj = {}) {
                    const event = Object.assign({ type: evName, stopPropagation() {}, preventDefault() {}, composedPath: () => [node] }, evObj);
                    for (const fn of listeners.get(evName) || []) fn(event);
                },
                click() {
                    this.trigger("click");
                },
                append(...kids) {
                    for (const k of kids) this.appendChild(k);
                },
                appendChild(k) {
                    k.parentElement = this;
                    k.parentNode = this;
                    if (k.nodeType === 1) this.children.push(k);
                    this.childNodes.push(k);
                    return k;
                },
                replaceChild(n, o) {
                    const idx = this.childNodes.indexOf(o);
                    if (idx >= 0) {
                        this.childNodes[idx] = n;
                        n.parentElement = this;
                        n.parentNode = this;
                        const cIdx = this.children.indexOf(o);
                        if (n.nodeType === 1) {
                            if (cIdx >= 0) this.children[cIdx] = n;
                            else this.children.push(n);
                        }
                    }
                    return o;
                },
                prepend(k) { return this.appendChild(k); },
                matches: () => false,
                closest: () => null,
                contains: (other) => {
                    let cur = other;
                    while (cur) {
                        if (cur === node) return true;
                        cur = cur.parentElement || cur.parentNode;
                    }
                    return false;
                },
                getBoundingClientRect: () => ({ top: 10, left: 10, right: 200, bottom: 50, width: 190, height: 40 }),
                querySelectorAll: () => [],
                querySelector: () => null,
            };
            Object.defineProperty(node, "innerHTML", {
                get() { return node._innerHtml || ""; },
                set(v) { node._innerHtml = String(v); },
            });
            return node;
        };

        const shadowWidgets = new Map();
        for (const id of [
            "player-wrap", "player-bar", "bar-info-zone", "bar-controls", "player-card",
            "i-vol-wrap", "i-vol-track", "i-vol-fill", "i-vol-mute", "i-quick-prev", "i-quick-play", "i-quick-next",
            "i-cover", "i-text", "i-eq", "c-cover", "c-title", "c-artist", "c-app", "c-seek-wrap",
            "c-seek", "c-prog", "c-tip", "c-pos", "c-dur", "c-vol-wrap", "c-vol-track", "c-vol-fill",
            "c-vol-mute", "c-expand", "c-sess-bar", "fs-modal", "fs-bg", "fs-cover", "fs-title",
            "fs-artist", "fs-app", "fs-seek-wrap", "fs-seek", "fs-prog", "fs-tip", "fs-pos", "fs-dur",
            "fs-vol-wrap", "fs-vol-track", "fs-vol-fill", "fs-vol-mute", "fs-lyrics", "fs-close",
            "fs-close-lbl", "p-prev", "p-play", "p-next", "fs-prev", "fs-play", "fs-next",
            "switch-overlay", "switch-overlay-text",
        ]) {
            const el = fakeMkEl("div", id);
            if (id === "player-wrap") el.classList.add("player-wrap");
            shadowWidgets.set("#" + id, el);
        }
        shadowWidgets.get("#player-wrap").append(shadowWidgets.get("#player-bar"), shadowWidgets.get("#player-card"));
        shadowWidgets.get("#player-bar").append(shadowWidgets.get("#bar-info-zone"), shadowWidgets.get("#bar-controls"));

        const createdShadowHost = fakeMkEl("div", "agy-extras-shadow-host");
        createdShadowHost.attachShadow = () => ({
            querySelector: (sel) => shadowWidgets.get(sel) || (sel === ".player-wrap" ? shadowWidgets.get("#player-wrap") : null),
            querySelectorAll: () => [],
            getElementById: (id) => shadowWidgets.get("#" + id) || null,
            addEventListener: () => {},
            removeEventListener: () => {},
            append: () => {},
            appendChild: () => {},
            prepend: () => {},
        });

        const privEmailNode = { nodeType: 3, nodeValue: "stream.secret@example.com", parentElement: null, parentNode: null };
        const privEmailSpan = fakeMkEl("span");
        privEmailSpan.appendChild(privEmailNode);
        const mixedRow = fakeMkEl("div");
        const mixedLabel = fakeMkEl("span");
        const mixedText = { nodeType: 3, nodeValue: " mixed@example.com", parentElement: mixedRow, parentNode: mixedRow };
        mixedRow.appendChild(mixedLabel);
        mixedRow.appendChild(mixedText);
        const fakeSecretHomePath = "/" + "home/" + "demo/secret";
        const privTipBtn = fakeMkEl("button");
        privTipBtn.setAttribute("title", "Account stream.secret@example.com in " + fakeSecretHomePath);

        const privTextNodes = [privEmailNode, mixedText];
        const allDomEls = [privEmailSpan, mixedRow, mixedLabel, privTipBtn];
        const sharedQueryAll = (sel) => {
            if (sel === '[data-agy-spoiler="1"]') return allDomEls.filter((n) => n.getAttribute("data-agy-spoiler") === "1");
            if (sel === '[data-agy-spoiler-wrap="1"]') return allDomEls.filter((n) => n.getAttribute("data-agy-spoiler-wrap") === "1");
            if (sel === "[title], [aria-label], [data-agy-tip]") return allDomEls.filter((n) => n.hasAttribute("title") || n.hasAttribute("aria-label") || n.hasAttribute("data-agy-tip"));
            if (sel === "[data-agy-priv-attr]") return allDomEls.filter((n) => n.hasAttribute("data-agy-priv-attr"));
            if (sel === "[data-agy-privacy-masked]") return allDomEls.filter((n) => n.hasAttribute("data-agy-privacy-masked"));
            return [];
        };
        const docElMock = fakeMkEl("html");
        docElMock.querySelectorAll = sharedQueryAll;
        docElMock.dataset = {
            agyPrivacy: "1",
            agyPrivacyReveal: "never",
            agyPrivacyStyle: "mask",
            agyPrivacyPaths: "1",
        };
        const bodyMock = fakeMkEl("body");
        bodyMock.querySelectorAll = sharedQueryAll;
        const winListeners = new Map();
        const flushPendingTimers = () => {
            while (timers.length > 0) {
                const t = timers.shift();
                if (!t.cleared) t.fn();
            }
        };

        const exSandbox = {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                addEventListener: (ev, fn) => {
                    if (!winListeners.has(ev)) winListeners.set(ev, []);
                    winListeners.get(ev).push(fn);
                },
                removeEventListener: () => {},
                dispatchEvent: (ev) => {
                    for (const fn of winListeners.get(ev.type) || []) fn(ev);
                },
                CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
            },
            document: {
                documentElement: docElMock,
                body: bodyMock,
                readyState: "complete",
                visibilityState: "visible",
                createElement: (tag) => {
                    if (tag === "div" && !docElMock._hostCreated) {
                        docElMock._hostCreated = true;
                        return createdShadowHost;
                    }
                    const created = fakeMkEl(tag);
                    allDomEls.push(created);
                    return created;
                },
                createTextNode: (txt) => ({ nodeType: 3, nodeValue: txt, parentElement: null, parentNode: null }),
                createTreeWalker: () => {
                    let i = 0;
                    return { nextNode: () => (i < privTextNodes.length ? privTextNodes[i++] : null) };
                },
                getElementById: (id) => (id === "agy-extras-shadow-host" ? createdShadowHost : null),
                querySelector: () => null,
                querySelectorAll: sharedQueryAll,
                addEventListener: () => {},
                removeEventListener: () => {},
            },
            NodeFilter: { SHOW_TEXT: 4 },
            WeakMap,
            Set,
            localStorage: { getItem: () => null, setItem() {} },
            getComputedStyle: () => ({ getPropertyValue: () => "" }),
            MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
            fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
            performance: { now: () => 0 },
            requestAnimationFrame: (fn) => { fn(); return 1; },
            cancelAnimationFrame() {},
            setTimeout: (fn) => { const entry = { id: nextTimerId++, fn, cleared: false }; timers.push(entry); return entry.id; },
            clearTimeout: (id) => { const f = timers.find((x) => x.id === id); if (f) f.cleared = true; },
            setInterval: () => 1,
            clearInterval() {},
            console,
            Math, Date, Number, String, Boolean, Array, Object, Map, JSON, RegExp, Error, Promise, parseInt, parseFloat, isFinite, encodeURIComponent,
        };
        exSandbox.window.window = exSandbox.window;
        exSandbox.window.document = exSandbox.document;
        exSandbox.globalThis = exSandbox;

        const exClientCode = extrasMod.buildExtrasClientJs("default", 19000, "tok_28");
        vm.runInNewContext(exClientCode, exSandbox, { filename: "agyExtras.statePrivacy.test.js" });

        // Privacy assertions (mask mode & WeakMap restore with zero DOM attribute leaks)
        assert(!privEmailNode.nodeValue.includes("stream.secret@example.com"), "Mask mode must scrub email from textNode.nodeValue");
        assert(!privTipBtn.getAttribute("title").includes("stream.secret@example.com"), "Privacy must scrub email from title attribute");
        assert(!privTipBtn.getAttribute("title").includes(fakeSecretHomePath), "Privacy with hidePaths must mask home path in title");
        assert(!privTipBtn.hasAttribute("data-agy-orig-title"), "Privacy must store originals in WeakMap rather than leaking in data-agy-orig-title attribute");

        // Switch to blur mode -> mixed container wraps email text node cleanly rather than blurring whole parent container
        docElMock.dataset.agyPrivacyStyle = "blur";
        exSandbox.window.dispatchEvent(new exSandbox.window.CustomEvent("agy-privacy-sync", { detail: { privacyMode: true } }));
        assert.strictEqual(privEmailNode.nodeValue, "stream.secret@example.com", "Switching back to blur restores original text node");
        assert.strictEqual(privEmailSpan.getAttribute("data-agy-spoiler"), "1", "Leaf email span must get spoiler attribute in blur mode");
        assert.strictEqual(mixedRow.getAttribute("data-agy-spoiler"), null, "Mixed container with sibling child elements must NOT have entire parent blurred");

        // Player hover vs click strict exclusion
        const barInfo = shadowWidgets.get("#bar-info-zone");
        const pCard = shadowWidgets.get("#player-card");

        exSandbox.window.dispatchEvent(new exSandbox.window.CustomEvent("agy-extras-pref", { detail: { playerOpenMode: "hover" } }));
        barInfo.trigger("mouseenter");
        flushPendingTimers();
        assert(pCard.classList.contains("open"), "In hover mode, mouseenter must open player-card");
        barInfo.trigger("click");
        assert(pCard.classList.contains("open"), "Clicking info zone in hover mode stays benign");
        barInfo.trigger("mouseleave");
        flushPendingTimers();
        assert(!pCard.classList.contains("open"), "CRITICAL: Clicking info zone in hover mode MUST NOT pin card; mouseleave must still close it");

        exSandbox.window.dispatchEvent(new exSandbox.window.CustomEvent("agy-extras-pref", { detail: { playerOpenMode: "click" } }));
        barInfo.trigger("mouseenter");
        flushPendingTimers();
        assert(!pCard.classList.contains("open"), "In click mode, mouseenter MUST NOT open player-card");
        barInfo.trigger("click");
        assert(pCard.classList.contains("open"), "In click mode, click must open player-card");
        barInfo.trigger("mouseleave");
        flushPendingTimers();
        assert(pCard.classList.contains("open"), "In click mode, mouseleave must NOT close pinned player-card");
        barInfo.trigger("click");
        assert(!pCard.classList.contains("open"), "Second click in click mode must close player-card");

        // 5. Shell views recording-safe privacy rendering (mask + modifier + no whole-card hover)
        const tabRenderOut = shell.renderTabBarHtml(19000, "tok_28");
        const pickRenderOut = shell.renderPickerHtml(19000, "tok_28");
        assert(tabRenderOut.includes("formatPrivacyValue") && tabRenderOut.includes('[data-agy-privacy-reveal="modifier"][data-agy-mod-held="1"]'));
        assert(pickRenderOut.includes("formatPrivacyValue") && pickRenderOut.includes('[data-agy-privacy-style="mask"]'));

        // 6. wallpaperEngine UI code invariants & UX fixes (panelAlpha 0..100, unlocked blur, light preview-card, adaptive scrim)
        assert(wpCode.includes('id="r-w-loffset" type="range" min="-5" max="5"'), "Karaoke offset slider must use [-5, 5] range");
        assert(wpCode.includes('id="r-alpha" type="range" min="0" max="100" step="1"'), "Panel density slider must expose intuitive 0..100% range");
        assert(wpCode.includes('panelAlphaToPct') && wpCode.includes('pctToPanelAlpha'), "wallpaperEngine must normalize panelAlpha between UI 0..100% and 0.00..1.00");
        assert(wpCode.includes('$("#r-panel-blur").disabled = false'), "Panel blur slider must remain interactive so users can adjust blur without hunting in Performance tab");
        assert(wpCode.includes(':host([data-agy-surface="light"])') && wpCode.includes('--m-preview-grad'), "Preview card in Wallpapers tab must adapt cleanly to Light theme");
        assert(wpCode.includes('--m-panel-bg'), "Modal settings dialog must maintain readable backing even at minimum panel density");
        const backdropBlockMatch = wpCode.match(/\.modal-backdrop\s*\{[\s\S]*?\}/);
        assert(backdropBlockMatch && !backdropBlockMatch[0].includes("blur("), ".modal-backdrop must NOT blur the full viewport behind Settings when panel blur changes");
        const noBlurBackdropMatch = wpCode.match(/\.modal-backdrop\.no-blur\s*\{[\s\S]*?\}/);
        assert(noBlurBackdropMatch && noBlurBackdropMatch[0].includes("var(--m-backdrop)") && !noBlurBackdropMatch[0].includes("--m-backdrop-noblur"), ".modal-backdrop.no-blur must NOT darken/lighten the screen when toggling blur 0 <-> 1+");
        assert(wpCode.includes(".modal-backdrop {\n            position: fixed;") || wpCode.includes(".modal-backdrop {\r\n            position: fixed;"), "Expected clean .modal-backdrop rule");
        assert(wpCode.includes("backdrop-filter: blur(var(--agy-panel-blur, 20px)) !important;"), "All panel rules should share unified --agy-panel-blur variable");
        assert(!wpCode.includes("var(--agy-panel-blur, 18px)") && !wpCode.includes("var(--agy-panel-blur, 22px)"), "Outdated inconsistent panel-blur fallbacks must not remain");
        assert(wpCode.includes('.monaco-editor-background, .margin, .minimap') && wpCode.includes('backdrop-filter: none !important;'), "Nested Monaco surfaces must not stack double backdrop-filter");
        const extrasSrcCheck = require("fs").readFileSync(require("path").join(__dirname, "..", "customization", "modules", "agyExtras.js"), "utf8");
        assert(extrasSrcCheck.includes("function syncAdaptiveTextColors(evt)") && extrasSrcCheck.includes("evt.detail.panelBlurPx"), "agyExtras must sync --agy-extras-panel-blur from agy-visual-sync event details as fallback");
        assert(
            contrast.getContrastBoost(140, 0.36) > 0,
            "Adaptive contrast boost must activate measurably on medium-bright/colorful wallpapers even with default dim=0.36"
        );
        assert(
            hcDarkBadCustom.surfaceDialog && parseFloat(hcDarkBadCustom.surfaceDialog.split(",")[3]) >= 0.90,
            "surfaceDialog must keep high legibility backing when reduceBackdropBlur is active"
        );
        const lowGlassTok = contrast.buildUiDesignTokens({
            effectiveMode: "light",
            tintRgb: "250, 251, 254",
            accentRgb: "96, 165, 250",
            uiContrast: "high",
            panelAlpha: 0.225,
            reduceBackdropBlur: false,
            panelBlurPx: 23,
        });
        assert(
            parseFloat(lowGlassTok.surfaceDialog.split(",")[3]) <= 0.60,
            "With frosted blur active at 9% density, surfaceDialog must allow genuine glass translucency"
        );
        assert(
            parseFloat(lowGlassTok.surfacePopover.split(",")[3]) <= 0.70,
            "With frosted blur active at 9% density, surfacePopover must allow genuine glass translucency"
        );
        assert(
            parseFloat(lowGlassTok.surfaceEditor.split(",")[3]) <= 0.50,
            "With frosted blur active at 9% density, surfaceEditor must align harmoniously with glass surfaces"
        );
        assert(
            wpCode.includes('[data-testid="title-menu-bar"]') && wpCode.includes('[data-agy-editor-pane="1"]'),
            "Top menu/tab bar and tagged editor/review panes must share cohesive frosted glass without leaking into chat panes"
        );
        assert(
            wpCode.includes('[data-testid="diff-gutter-strip"]') && wpCode.includes('syncEditorPaneTags'),
            "Review/Diff Changes view must also receive runtime frosted glass backing"
        );
        assert(
            wpCode.includes('html[data-agy-surface="light"] body[data-agy-theme]') && wpCode.includes('[class*="bg-foreground/"]'),
            "Light mode must neutralize dark charcoal pill/badge backgrounds"
        );
        const i18nMod = require(require("path").join(__dirname, "..", "customization", "modules", "agyI18n.js"));
        const i18nSandbox = vm.createContext({
            window: {},
            localStorage: { getItem: () => JSON.stringify({ lang: "en" }) },
            document: { querySelectorAll: () => [], documentElement: { nodeType: 1 }, createTreeWalker: () => ({ nextNode: () => null }) },
            MutationObserver: function() { return { observe() {}, disconnect() {} }; },
        });
        vm.runInContext(i18nMod.buildI18nClientJs(), i18nSandbox);
        assert.strictEqual(
            i18nSandbox.window.__agyI18n._translateTextForTest("Так должно быть? (4 image attachments)"),
            "Так должно быть? (4 вложенных изображения)",
            "Mixed Cyrillic prompt + trailing English image attachment count must translate cleanly"
        );
        assert.strictEqual(
            i18nSandbox.window.__agyI18n._translateTextForTest("(1 image attachment)"),
            "(1 вложенное изображение)"
        );
        assert.strictEqual(
            i18nSandbox.window.__agyI18n._translateTextForTest("5 file attachments"),
            "5 вложенных файлов"
        );
        assert.strictEqual(
            i18nSandbox.window.__agyI18n._translateTextForTest("Available on paid Google AI Pro and Ultra plans. Not included with your current plan."),
            "Доступно на платных тарифах Google AI Pro и Ultra. Не входит в ваш текущий тариф."
        );
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("View Split Diff"), "Раздельный дифф");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Hide Whitespace Changes"), "Скрыть изменения пробелов");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Collapse All"), "Свернуть все");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("No Results"), "Нет результатов");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Match Whole Word (ab)"), "Слово целиком (ab)");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Match Case (Aa)"), "Учитывать регистр (Aa)");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Use Regular Expression (.*)"), "Регулярное выражение (.*)");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Previous Match (Shift+Enter)"), "Предыдущее совпадение (Shift+Enter)");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Next Match (Enter)"), "Следующее совпадение (Enter)");
        assert.strictEqual(i18nSandbox.window.__agyI18n._translateTextForTest("Close (Escape)"), "Закрыть (Escape)");
        assert.strictEqual(
            i18nSandbox.window.__agyI18n._translateTextForTest("Applies to /btw and messages sent after this turn"),
            "Применяется к /btw и сообщениям, отправленным после этого шага"
        );
        assert.strictEqual(
            i18nSandbox.window.__agyI18n._translateTextForTest("Permissions cannot be changed while the agent is running"),
            "Нельзя изменить разрешения, пока агент работает"
        );
        assert(
            wpCode.includes('syncEditorPaneTags') && wpCode.includes('[data-agy-editor-pane="1"]') && wpCode.includes('syncLightDarkPills'),
            "wallpaperEngine must tag non-chat diff/editor panes and fix dark charcoal pills in Light mode"
        );
        assert(wpCode.includes('panel.addEventListener("pointerdown"'), "Shadow panel outside-dismiss must use pointerdown so dragging cpicker sliders doesn't dismiss it");
        assert(wpCode.includes('wpEs.addEventListener("extras"'), "wallpaperEngine SSE must listen for extras updates");
        assert(wpCode.includes('#r-w-lsize') && wpCode.includes('setR("#r-w-lsize"') && wpCode.includes('setR("#r-w-loffset"'), "syncControlsFromState must sync karaoke size & offset back from state");
    }

    // [29/29] Runtime pill polarity & OKLab/sRGB/OKLCH fix for BOTH Dark and Light themes + Editor pane tagging
    {
        console.log("[29/29] Verifying Dark/Light inverted Turn pill detection & OKLab/color(srgb) runtime fix...");
        const wpMod29 = require("../customization/modules/wallpaperEngine.js");
        const wpCss29 = wpMod29.buildInjectedCss(wpMod29.BASE_THEME);
        const wpJs29 = wpMod29.buildInjectedJs("default", wpMod29.BASE_THEME, 19000, "tok_29");

        assert(
            wpCss29.includes('html[data-agy-surface="dark"] body[data-agy-theme]')
            && wpCss29.includes('[class*="bg-white"]')
            && wpCss29.includes('html:is([data-agy-surface="light"], [data-agy-surface="dark"]) body[data-agy-theme] [data-agy-light-fix="1"]'),
            "CSS must neutralize inverted bright pills in Dark mode as well as dark pills in Light mode"
        );

        const toKebab = (s) => s.replace(/([A-Z])/g, "-$1").toLowerCase();
        const splitTop = (str, sep) => {
            const out = [];
            let cur = "", paren = 0, bracket = 0, quote = "";
            for (let i = 0; i < str.length; i++) {
                const c = str[i];
                if (quote) { cur += c; if (c === quote && str[i - 1] !== "\\") quote = ""; continue; }
                if (c === '"' || c === "'") { quote = c; cur += c; continue; }
                if (c === "(") paren++;
                else if (c === ")" && paren > 0) paren--;
                else if (c === "[") bracket++;
                else if (c === "]" && bracket > 0) bracket--;
                if (paren === 0 && bracket === 0 && ((sep === " " && /\s/.test(c)) || c === sep)) {
                    if (cur.trim()) out.push(cur.trim());
                    cur = "";
                } else {
                    cur += c;
                }
            }
            if (cur.trim()) out.push(cur.trim());
            return out;
        };
        const matchesCompound = (el, compound) => {
            if (!el || el.nodeType !== 1) return false;
            const s = compound.trim();
            if (!s) return false;
            let i = 0;
            while (i < s.length) {
                if (s[i] === "*") { i++; continue; }
                if (s[i] === "#") {
                    i++;
                    let id = "";
                    while (i < s.length && !".#[]:* ".includes(s[i])) id += s[i++];
                    if (el.id !== id) return false;
                } else if (s[i] === ".") {
                    i++;
                    let cls = "";
                    while (i < s.length && !".#[]:* ".includes(s[i])) cls += s[i++];
                    if (!el.classList.contains(cls)) return false;
                } else if (s[i] === "[") {
                    const end = s.indexOf("]", i);
                    if (end === -1) return false;
                    const body = s.slice(i + 1, end);
                    i = end + 1;
                    const eqStar = body.indexOf("*=");
                    const eq = body.indexOf("=");
                    if (eqStar !== -1) {
                        const k = body.slice(0, eqStar).trim();
                        const v = body.slice(eqStar + 2).trim().replace(/^['"]|['"]$/g, "");
                        if (!String(el.getAttribute(k) || "").includes(v)) return false;
                    } else if (eq !== -1) {
                        const k = body.slice(0, eq).trim();
                        const v = body.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
                        if (el.getAttribute(k) !== v) return false;
                    } else if (!el.hasAttribute(body.trim())) {
                        return false;
                    }
                } else if (s.startsWith(":is(", i) || s.startsWith(":not(", i)) {
                    const isNot = s.startsWith(":not(", i);
                    const open = i + (isNot ? 5 : 4);
                    let depth = 1, j = open;
                    while (j < s.length && depth > 0) {
                        if (s[j] === "(") depth++;
                        else if (s[j] === ")") depth--;
                        j++;
                    }
                    const inner = s.slice(open, j - 1);
                    i = j;
                    const subOk = splitTop(inner, ",").some((sub) => matchesOne(el, sub));
                    if (isNot ? subOk : !subOk) return false;
                } else if (s[i] === ":") {
                    return false;
                } else {
                    let tag = "";
                    while (i < s.length && !".#[]:* ".includes(s[i])) tag += s[i++];
                    if (el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
                }
            }
            return true;
        };
        const matchesOne = (el, sel) => {
            const parts = splitTop(sel.trim(), " ");
            if (!parts.length) return false;
            if (!matchesCompound(el, parts[parts.length - 1])) return false;
            let cur = el.parentElement;
            for (let pi = parts.length - 2; pi >= 0; pi--) {
                while (cur && !matchesCompound(cur, parts[pi])) cur = cur.parentElement;
                if (!cur) return false;
                cur = cur.parentElement;
            }
            return true;
        };
        const matchesSel = (el, selList) => splitTop(String(selList || ""), ",").some((s) => matchesOne(el, s));

        const mkDom29 = (tag, opts = {}) => {
            const attrs = Object.assign({}, opts.attrs || {});
            const classes = new Set(opts.classes || (opts.className ? String(opts.className).split(/\s+/).filter(Boolean) : []));
            if (opts.id) attrs.id = opts.id;
            const styleMap = new Map();
            const children = [];
            const el = {
                nodeType: 1,
                tagName: tag.toUpperCase(),
                children,
                parentElement: null,
                parentNode: null,
                _bg: opts.bg || "",
                _rect: opts.rect || { width: 120, height: 28 },
                _text: opts.text !== undefined ? opts.text : null,
                isConnected: true,
                innerHTML: "",
                value: "",
                checked: false,
                get id() { return attrs.id || ""; },
                set id(v) { attrs.id = v; },
                get className() { return Array.from(classes).join(" "); },
                set className(v) { classes.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
                classList: {
                    add: (...cs) => cs.forEach((c) => classes.add(c)),
                    remove: (...cs) => cs.forEach((c) => classes.delete(c)),
                    contains: (c) => classes.has(c),
                    toggle: (c, force) => {
                        const next = force === undefined ? !classes.has(c) : Boolean(force);
                        if (next) classes.add(c);
                        else classes.delete(c);
                        return next;
                    },
                },
                get nextElementSibling() {
                    if (!el.parentElement) return null;
                    const idx = el.parentElement.children.indexOf(el);
                    return idx >= 0 && idx + 1 < el.parentElement.children.length ? el.parentElement.children[idx + 1] : null;
                },
                style: {
                    setProperty: (k, v) => styleMap.set(k, String(v)),
                    getPropertyValue: (k) => styleMap.get(k) || "",
                    cssText: "",
                },
                dataset: new Proxy({}, {
                    get: (_, prop) => attrs["data-" + toKebab(String(prop))],
                    set: (_, prop, val) => { attrs["data-" + toKebab(String(prop))] = String(val); return true; },
                    deleteProperty: (_, prop) => { delete attrs["data-" + toKebab(String(prop))]; return true; },
                }),
                setAttribute: (k, v) => { attrs[k] = String(v); },
                getAttribute: (k) => (k in attrs ? attrs[k] : null),
                hasAttribute: (k) => k in attrs,
                removeAttribute: (k) => { delete attrs[k]; },
                get textContent() { return el._text !== null ? el._text : children.map((c) => c.textContent).join(""); },
                set textContent(v) { el._text = String(v); },
                appendChild: (ch) => { ch.parentElement = el; ch.parentNode = el; children.push(ch); return ch; },
                append: (...chs) => chs.forEach((ch) => el.appendChild(ch)),
                prepend: (ch) => { if (ch && typeof ch === "object") { ch.parentElement = el; ch.parentNode = el; children.unshift(ch); } return ch; },
                contains: (target) => { let cur = target; while (cur) { if (cur === el) return true; cur = cur.parentElement; } return false; },
                play: () => Promise.resolve(),
                pause() {},
                load() {},
                getContext: () => null,
                remove: () => {
                    if (el.parentElement) {
                        const idx = el.parentElement.children.indexOf(el);
                        if (idx !== -1) el.parentElement.children.splice(idx, 1);
                        el.parentElement = null;
                        el.parentNode = null;
                    }
                },
                attachShadow: () => {
                    const sr = mkDom29("shadow-root");
                    const dummyCache = new Map();
                    const getDummy = (sel) => {
                        if (!dummyCache.has(sel)) {
                            const d = mkDom29("div", { id: sel.replace(/^#/, "") });
                            d.querySelectorAll = () => [];
                            d.querySelector = (s) => getDummy(s);
                            dummyCache.set(sel, d);
                        }
                        return dummyCache.get(sel);
                    };
                    sr.getElementById = (id) => sr.querySelector("#" + id);
                    sr.querySelector = (sel) => {
                        const real = sr.querySelectorAll(sel)[0];
                        return real || getDummy(sel);
                    };
                    return sr;
                },
                getBoundingClientRect: () => el._rect,
                matches: (sel) => matchesSel(el, sel),
                closest: (sel) => {
                    let cur = el;
                    while (cur && cur.nodeType === 1) {
                        if (matchesSel(cur, sel)) return cur;
                        cur = cur.parentElement;
                    }
                    return null;
                },
                querySelectorAll: (sel) => {
                    const res = [];
                    const walk = (n) => {
                        for (const ch of n.children) {
                            if (matchesSel(ch, sel)) res.push(ch);
                            walk(ch);
                        }
                    };
                    walk(el);
                    return res;
                },
                querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
                addEventListener() {},
                removeEventListener() {},
            };
            return el;
        };

        const root29 = mkDom29("html", { rect: { width: 1280, height: 800 } });
        const head29 = mkDom29("head");
        const body29 = mkDom29("body", { rect: { width: 1280, height: 800 } });
        root29.append(head29, body29);

        const split29 = mkDom29("div", { attrs: { "data-split-panes": "true" }, rect: { width: 1280, height: 800 } });
        const leftPane29 = mkDom29("div", { attrs: { "data-tiling-pane": "true" }, rect: { width: 640, height: 800 } });
        const chatBody29 = mkDom29("div", { attrs: { "data-main-content-body": "true" }, rect: { width: 640, height: 800 } });
        const chatPill29 = mkDom29("div", { text: "Chat bubble", bg: "rgba(255, 255, 255, 0.40)", rect: { width: 160, height: 28 } });
        chatBody29.appendChild(chatPill29);
        leftPane29.appendChild(chatBody29);

        const rightPane29 = mkDom29("div", { attrs: { "data-tiling-pane": "true" }, rect: { width: 640, height: 800 } });
        const turnOuter29 = mkDom29("div", { classes: ["rounded-lg"], bg: "color(srgb 1 1 1 / 0.25)", rect: { width: 320, height: 32 } });
        const turnBadge29 = mkDom29("span", { text: "За ход", bg: "oklab(0.98 0 0 / 0.35)", rect: { width: 56, height: 22 } });
        const turnLabel29 = mkDom29("span", { text: "нет матовости в diff", bg: "transparent", rect: { width: 200, height: 22 } });
        turnOuter29.append(turnBadge29, turnLabel29);
        const oklchPill29 = mkDom29("button", { text: "+10", bg: "oklch(0.95 0.002 250 / 0.28)", rect: { width: 42, height: 22 } });
        const accentBtn29 = mkDom29("button", { text: "Apply", bg: "rgb(96, 165, 250)", rect: { width: 70, height: 26 } });
        const diffRemoved29 = mkDom29("div", { attrs: { "data-diff-type": "remove" }, text: "- old", bg: "rgba(255, 255, 255, 0.50)", rect: { width: 400, height: 22 } });
        const codeHost29 = mkDom29("div", { classes: ["monaco-diff-editor"], rect: { width: 600, height: 400 } });
        rightPane29.append(turnOuter29, oklchPill29, accentBtn29, diffRemoved29, codeHost29);

        split29.append(leftPane29, rightPane29);
        const looseShell29 = mkDom29("div", { classes: ["agy-inset-shell"], rect: { width: 640, height: 120 } });
        const looseTurnPill29 = mkDom29("div", { text: "За ход (outside pane)", bg: "oklch(0.96 0 none / 0.35)", rect: { width: 220, height: 30 } });
        looseShell29.appendChild(looseTurnPill29);
        const embeddedReview29 = mkDom29("div", { attrs: { "data-testid": "review-panel" }, rect: { width: 500, height: 120 } });
        const embeddedPill29 = mkDom29("button", { text: "Embedded review pill", bg: "rgba(10, 14, 22, 0.40)", rect: { width: 180, height: 28 } });
        embeddedReview29.appendChild(embeddedPill29);
        chatBody29.appendChild(embeddedReview29);
        body29.append(split29, looseShell29);

        const moHandlers29 = [];
        const timers29 = [];
        const CustomEvent29 = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
        const sb29 = {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() {},
                CustomEvent: CustomEvent29,
            },
            CustomEvent: CustomEvent29,
            document: {
                documentElement: root29,
                head: head29,
                body: body29,
                hidden: false,
                visibilityState: "visible",
                fonts: { add() {} },
                createElement: (t) => mkDom29(t),
                getElementById: (id) => root29.querySelector("#" + id),
                querySelector: (sel) => root29.querySelector(sel),
                querySelectorAll: (sel) => root29.querySelectorAll(sel),
                addEventListener() {},
                removeEventListener() {},
            },
            getComputedStyle: (el) => ({
                backgroundColor: el && el._bg ? el._bg : "rgba(0, 0, 0, 0)",
                color: "rgb(255, 255, 255)",
                getPropertyValue: (k) => (el && el.style ? el.style.getPropertyValue(k) : ""),
            }),
            FontFace: class { constructor() {} load() { return Promise.resolve(this); } },
            localStorage: { getItem: () => null, setItem() {} },
            MutationObserver: class {
                constructor(cb) { this._cb = cb; }
                observe(tgt) { moHandlers29.push({ cb: this._cb, tgt }); }
                disconnect() {}
            },
            EventSource: class { addEventListener() {} close() {} },
            fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ videos: [], fonts: [] }) }),
            requestAnimationFrame: (fn) => { fn(); return 1; },
            setTimeout: (fn, ms) => { const entry = { id: timers29.length + 1, fn, ms, ran: false }; timers29.push(entry); return entry.id; },
            clearTimeout: (id) => { const f = timers29.find((t) => t.id === id); if (f) f.ran = true; },
            setInterval: () => 1,
            clearInterval() {},
            console,
            Math, Date, Number, String, Boolean, Array, Object, Set, Map, JSON, RegExp, Error, Promise, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent,
        };
        sb29.window.window = sb29.window;
        sb29.window.document = sb29.document;
        sb29.globalThis = sb29;

        vm.runInNewContext(wpJs29, sb29, { filename: "wallpaperEngine.pills.test.js" });
        const api29 = sb29.window.__agyThemeApi;

        // Check editor pane tagging isolates diff pane from chat pane
        api29.syncEditorPaneTags(sb29.document);
        assert.strictEqual(rightPane29.getAttribute("data-agy-editor-pane"), "1", "Diff pane must receive data-agy-editor-pane='1'");
        assert.strictEqual(leftPane29.getAttribute("data-agy-editor-pane"), null, "Chat pane containing [data-main-content-body] must NOT get data-agy-editor-pane");

        // Phase A: Dark mode fixes bright white color(srgb), oklab(), and oklch() pills
        api29.setState({ themeMode: "dark" });
        api29.syncLightDarkPills(sb29.document);
        assert.strictEqual(turnOuter29.getAttribute("data-agy-light-fix"), "1", "Dark mode outer bright pill (color(srgb)) must be tagged '1'");
        assert.strictEqual(turnOuter29.getAttribute("data-agy-pill-surface"), "dark");
        assert.strictEqual(turnBadge29.getAttribute("data-agy-light-fix"), "2", "Dark mode nested bright badge (oklab) must be tagged '2'");
        assert.strictEqual(turnBadge29.getAttribute("data-agy-pill-surface"), "dark");
        assert.strictEqual(oklchPill29.getAttribute("data-agy-light-fix"), "1", "Dark mode bright oklch() pill must be tagged '1'");
        assert.strictEqual(looseTurnPill29.getAttribute("data-agy-light-fix"), "1", "Dark mode pill outside panes with oklch 'none' hue must be fixed");
        assert.strictEqual(turnLabel29.getAttribute("data-agy-light-fix"), null, "Transparent inner text label must stay untagged");
        assert.strictEqual(accentBtn29.getAttribute("data-agy-light-fix"), null, "Saturated accent button must stay untouched");
        assert.strictEqual(diffRemoved29.getAttribute("data-agy-light-fix"), null, "Diff row [data-diff-type] must stay untouched");
        assert.strictEqual(chatPill29.getAttribute("data-agy-light-fix"), null, "Chat panel elements must stay untouched");

        // Phase B: Re-scan under same Dark polarity preserves fixed tags (no flicker even when computed bg updates)
        turnOuter29._bg = "rgba(20, 24, 34, 0.85)";
        api29.syncLightDarkPills(sb29.document);
        assert.strictEqual(turnOuter29.getAttribute("data-agy-light-fix"), "1", "Same-surface re-scan must keep fixed pill without flicker");

        // Phase C: Switch to Light mode -> stale Dark-fixed non-inverted pills clear, and inverted dark pills get fixed
        turnOuter29._bg = "color(srgb 0.02 0.03 0.05 / 0.35)";
        turnBadge29._bg = "oklab(0.12 0 0 / 0.45)";
        oklchPill29._bg = "rgba(248, 250, 252, 0.85)";
        looseTurnPill29._bg = "oklch(0.18 0 none / 0.45)";
        api29.setState({ themeMode: "light" });
        api29.syncLightDarkPills(sb29.document);
        assert.strictEqual(turnOuter29.getAttribute("data-agy-light-fix"), "1", "Light mode outer dark pill must be tagged '1'");
        assert.strictEqual(turnOuter29.getAttribute("data-agy-pill-surface"), "light");
        assert.strictEqual(turnBadge29.getAttribute("data-agy-light-fix"), "2", "Light mode nested dark badge must be tagged '2'");
        assert.strictEqual(turnBadge29.getAttribute("data-agy-pill-surface"), "light");
        assert.strictEqual(oklchPill29.getAttribute("data-agy-light-fix"), null, "Stale dark-mode pill that is already light in Light mode must clear");
        assert.strictEqual(looseTurnPill29.getAttribute("data-agy-light-fix"), "1", "Pill outside editor/tiling/split-panes with oklch 'none' hue must be fixed in Light mode");
        assert.strictEqual(embeddedPill29.getAttribute("data-agy-light-fix"), "1", "Review pill inside [data-testid*='review'] must be fixed even under chat wrapper");

        // Phase D: Dynamic MutationObserver outside PANE_OBSERVER_SEL schedules pill sync
        const dynWrapper29 = mkDom29("div", { rect: { width: 320, height: 60 } });
        const dynPill29 = mkDom29("div", { text: "За ход dynamic", bg: "color(srgb 0 0 0 / 0.45)", rect: { width: 220, height: 28 } });
        dynWrapper29.appendChild(dynPill29);
        body29.appendChild(dynWrapper29);
        for (const h of moHandlers29) {
            if (h.tgt === body29) {
                h.cb([{ type: "childList", target: body29, addedNodes: [dynWrapper29] }]);
            }
        }
        for (const t of timers29) {
            if (!t.ran && t.ms === 80) { t.ran = true; t.fn(); }
        }
        assert.strictEqual(dynPill29.getAttribute("data-agy-light-fix"), "1", "MutationObserver outside pane selectors must still schedule & fix newly mounted pills");

        // Phase E: syncPanelSurfaces runtime tagging (Settings modal/backdrop/sticky header & Launcher)
        const backdrop29 = mkDom29("div", { rect: { width: 1280, height: 800 } });
        const settingsWrap29 = mkDom29("div", { rect: { width: 920, height: 640 } });
        const settingsSidebar29 = mkDom29("aside", { attrs: { "data-testid": "settings-sidebar" }, rect: { width: 240, height: 640 } });
        const settingsHeader29 = mkDom29("header", { text: "Ave Maria Patcher AG", rect: { width: 680, height: 64 } });
        settingsWrap29.appendChild(settingsSidebar29);
        settingsWrap29.appendChild(settingsHeader29);
        backdrop29.appendChild(settingsWrap29);
        body29.appendChild(backdrop29);

        const launcherCard29 = mkDom29("div", { rect: { width: 520, height: 320 } });
        launcherCard29.appendChild(mkDom29("input", { attrs: { type: "text" }, rect: { width: 480, height: 36 } }));
        launcherCard29.appendChild(mkDom29("button", { text: "Проверка", rect: { width: 480, height: 32 } }));
        launcherCard29.appendChild(mkDom29("button", { text: "Побочный вопрос", rect: { width: 480, height: 32 } }));
        body29.appendChild(launcherCard29);

        api29.syncPanelSurfaces(sb29.document);
        assert.strictEqual(settingsWrap29.getAttribute("data-agy-surface-panel"), "modal", "Settings wrapper must be tagged as modal panel");
        assert.strictEqual(backdrop29.getAttribute("data-agy-modal-backdrop"), "1", "Full-screen Settings overlay must be tagged as modal backdrop");
        assert.strictEqual(settingsHeader29.getAttribute("data-agy-sticky-header"), "1", "Settings header must be tagged as sticky header");
        assert.strictEqual(launcherCard29.getAttribute("data-agy-surface-panel"), "launcher", "Quick-launcher card must be tagged as launcher panel");
    }

    // =========================================================================
    // [30/30] Light-mode washes, unified frosted panels & anti-nesting runtime
    // =========================================================================
    {
        console.log("[30/30] Testing Light washes, unified panel frost CSS, syncPanelSurfaces & shell blur=0...");
        const { buildUiDesignTokens } = require("../customization/modules/agyUiContrast");
        const wallpaperEngine = require("../customization/modules/wallpaperEngine");
        const agyShellViews = require("../customization/modules/agyShellViews");
        const lightTok30 = buildUiDesignTokens({
            effectiveMode: "light",
            tintRgb: "250, 251, 254",
            accentRgb: "59, 130, 246",
            uiContrast: "default",
            panelAlpha: 0.45,
            reduceBackdropBlur: false,
            panelBlurPx: 32,
        });
        assert(!lightTok30.subtleBg.includes("15, 23, 42"), "Light subtleBg must not use dark slate soot");
        assert(!lightTok30.navBg.includes("15, 23, 42"), "Light navBg must not use dark slate soot");
        assert(!lightTok30.cardBg.includes("15, 23, 42"), "Light cardBg must not use dark slate soot");
        assert(!lightTok30.backdropBg.includes("15, 23, 42"), "Light backdropBg must not use dark slate veil");
        assert(typeof lightTok30.surfaceSticky === "string" && lightTok30.surfaceSticky.startsWith("rgba("), "surfaceSticky token must be emitted");

        const css30 = wallpaperEngine.buildInjectedCss({
            accentRgb: "59, 130, 246",
            tintRgb: "250, 251, 254",
            uiFont: "'Segoe UI', sans-serif",
            monoFont: "'Consolas', monospace",
            baseFontSizePx: 14,
            radiusPx: 10,
        });
        assert(css30.includes('[data-radix-popper-content-wrapper] > *'), "CSS must style Radix popper children");
        assert(css30.includes('[data-slot="hover-card-content"]'), "CSS must style hover-card popovers");
        assert(css30.includes('[data-agy-surface-panel="launcher"]'), "CSS must style centered launcher panel");
        assert(css30.includes('[data-agy-sticky-header="1"]'), "CSS must style sticky modal headers");
        assert(css30.includes('[data-agy-modal-backdrop="1"]'), "CSS must isolate modal backdrop scrims");
        assert(css30.includes('[class*="bg-ide-"]'), "CSS must neutralize dark bg-ide-* classes in Light mode");
        assert(css30.includes(':is([role="tab"], .tab, [data-testid*="tab"])'), "CSS must apply radius to open file tabs");
        assert(css30.includes('.breadcrumbs-below-tabs, .breadcrumbs-control'), "CSS must remove extra pill background on breadcrumbs");
        assert(css30.includes('[class*="animate-pulse"]'), "CSS must keep animated activity dots readable");
        const extrasSrc30 = fs.readFileSync(path.join(__dirname, "../customization/modules/agyExtras.js"), "utf8");
        assert(extrasSrc30.includes("height: 26px;"), "Compact player bar height must fit natively inside titlebar without overlapping content below");

        const tabBarHtml30 = agyShellViews.renderTabBarHtml(0, "");
        assert(tabBarHtml30.includes("panelBlurPx: safeBlur"), "Shared theme script must pass clamped panelBlurPx including 0");
    }

    // =========================================================================
    // [31/31] Comprehensive overhaul: Plain BG toggle, 0%..100% true glass, Backdrop Roots & Light/Dark Settings parity
    // =========================================================================
    {
        console.log("[31/31] Testing Plain background mode, full 0%..100% panel opacity, ::before backdrop-filter & Backdrop Root cleanup...");
        const contrast31 = require("../customization/modules/agyUiContrast");
        const wp31 = require("../customization/modules/wallpaperEngine");
        const shell31 = require("../customization/modules/agyShellViews");

        // 1. sanitizeAppearanceConfig supports wallpaperEnabled boolean & full [0, 1] panelAlpha range
        const sanZero = wp31.sanitizeAppearanceConfig({ wallpaperEnabled: false, panelAlpha: 0, panelBlurPx: 32 });
        assert.strictEqual(sanZero.wallpaperEnabled, false);
        assert.strictEqual(sanZero.panelAlpha, 0);
        const sanFull = wp31.sanitizeAppearanceConfig({ wallpaperEnabled: true, panelAlpha: 1 });
        assert.strictEqual(sanFull.wallpaperEnabled, true);
        assert.strictEqual(sanFull.panelAlpha, 1);

        // 2. Full 0%..100% opacity without dead zone when !reduceBackdropBlur (both Default & High Contrast, Dark & Light)
        for (const mode of ["dark", "light"]) {
            for (const uiContrast of ["default", "high"]) {
                const tintRgb = mode === "light" ? "250, 251, 254" : "12, 14, 20";
                const zeroTok = contrast31.buildUiDesignTokens({
                    effectiveMode: mode,
                    tintRgb,
                    accentRgb: "96, 165, 250",
                    uiContrast,
                    panelAlpha: 0,
                    reduceBackdropBlur: false,
                    panelBlurPx: 32,
                });
                const L0 = zeroTok.layers;
                for (const v of [L0.baseAlpha, L0.sidebarAlpha, L0.cardAlpha, L0.composerAlpha, L0.editorAlpha, L0.modalAlpha]) {
                    assert(v >= 0 && v <= 0.08, `${mode}/${uiContrast} 0% surface layer alpha must be in [0, 0.08], got ${v}`);
                }
                const popA0 = parseFloat(zeroTok.surfacePopover.split(",")[3]);
                const dlgA0 = parseFloat(zeroTok.surfaceDialog.split(",")[3]);
                const stkA0 = parseFloat(zeroTok.surfaceSticky.split(",")[3]);
                const bdA0 = parseFloat(zeroTok.backdropBg.split(",")[3]);
                const cardA0 = parseFloat(zeroTok.cardBg.split(",")[3]);
                const navA0 = parseFloat(zeroTok.navBg.split(",")[3]);
                assert(popA0 <= 0.08 && dlgA0 <= 0.08 && stkA0 <= 0.08, `${mode}/${uiContrast} 0% popup/dialog/sticky must be <= 0.08 (got pop=${popA0}, dlg=${dlgA0}, stk=${stkA0})`);
                assert(bdA0 <= 0.08 && cardA0 <= 0.08 && navA0 <= 0.08, `${mode}/${uiContrast} 0% Shadow DOM tokens must be clear glass (bd=${bdA0}, card=${cardA0}, nav=${navA0})`);

                const fullTok = contrast31.buildUiDesignTokens({
                    effectiveMode: mode,
                    tintRgb,
                    accentRgb: "96, 165, 250",
                    uiContrast,
                    panelAlpha: 1,
                    reduceBackdropBlur: false,
                    panelBlurPx: 32,
                });
                const L100 = fullTok.layers;
                assert(L100.sidebarAlpha >= 0.94 && L100.cardAlpha >= 0.96 && L100.modalAlpha >= 0.99, `${mode}/${uiContrast} 100% density must reach near-opaque (${JSON.stringify(L100)})`);
                assert(parseFloat(fullTok.surfaceDialog.split(",")[3]) >= 0.99, `${mode}/${uiContrast} 100% dialog must reach >= 0.99`);
            }
        }
        // High legibility floors MUST still be preserved when reduceBackdropBlur: true even at 0% panelAlpha
        const zeroNoBlurTok = contrast31.buildUiDesignTokens({
            effectiveMode: "light",
            tintRgb: "250, 251, 254",
            accentRgb: "37, 99, 235",
            uiContrast: "default",
            panelAlpha: 0,
            reduceBackdropBlur: true,
            panelBlurPx: 20,
        });
        assert(parseFloat(zeroNoBlurTok.surfaceDialog.split(",")[3]) >= 0.90, "reduceBackdropBlur:true must preserve >= 0.90 dialog legibility backing");
        assert(parseFloat(zeroNoBlurTok.surfacePopover.split(",")[3]) >= 0.92, "reduceBackdropBlur:true must preserve >= 0.92 popover legibility backing");

        // 3. CSS structure: ::before isolation, no opacity<1 animation, Light bg-white neutralization, plain-bg CSS
        const css31 = wp31.buildInjectedCss({ accentRgb: "96, 165, 250", tintRgb: "12, 14, 20" });
        assert(css31.includes('html[data-agy-plain-bg="1"] #agy-wallpaper-layer video'), "CSS must hide wallpaper media & scrim in plain background mode");
        assert(css31.includes('[data-slot="dropdown-menu-sub-content"]') && css31.includes('::before'), "Submenus & menus must use isolated ::before glass layer");
        assert(css31.includes('[data-agy-clear-bd-root="1"]'), "CSS must expose runtime Backdrop Root clearer");
        assert(css31.includes('[class*="backdrop-blur"]'), "CSS must clear Tailwind v4 arbitrary backdrop-blur-[...] ancestor wrappers");
        assert(css31.includes('[class*="bg-white"]'), "Light mode CSS must neutralize opaque bg-white containers in modals/settings");
        assert(!css31.includes("@keyframes agyUiEnter") && css31.includes("animation: none !important;"), "Floating glass panels must suppress transform/opacity enter animations that block nested Chromium backdrop-filter");

        // 4. agyShellViews honors wallpaperEnabled: false & full [0, 1] panelAlpha
        const pickHtml31 = shell31.renderPickerHtml(0, "");
        assert(pickHtml31.includes('html[data-agy-plain-bg="1"]') && pickHtml31.includes("themeState.wallpaperEnabled === false"), "Picker shell view must honor plain background toggle");
        assert(!pickHtml31.includes("Math.max(0.15, Math.min(0.96, Number(cfg.panelAlpha)))"), "Shell views must not clamp panelAlpha to legacy [0.15, 0.96] dead-zone");
        const tabHtml31 = shell31.renderTabBarHtml(0, "");
        assert(tabHtml31.includes("root.dataset.agyPlainBg"), "Tab bar shell view must sync data-agy-plain-bg");

        // 5. Client VM test: #sw-plain-bg toggle, Shadow DOM --m-* at 0% & 100%, Backdrop Root & confirm header vs body parity
        const js31 = wp31.buildInjectedJs("default", { accentRgb: "96, 165, 250", tintRgb: "12, 14, 20" }, 0, "");
        const makeEl31 = (tag, opts = {}) => {
            const attrs = new Map(Object.entries(opts.attrs || {}));
            const styleMap = new Map();
            const children = [];
            const clsSet = new Set(opts.classes || []);
            const el = {
                tagName: tag.toUpperCase(),
                nodeType: 1,
                id: attrs.get("id") || "",
                parentElement: null,
                children,
                childNodes: children,
                dataset: {},
                textContent: opts.text || "",
                value: "",
                disabled: false,
                src: "",
                paused: false,
                readyState: 4,
                style: {
                    setProperty(k, v) { styleMap.set(k, String(v)); },
                    getPropertyValue(k) { return styleMap.get(k) || ""; },
                    removeProperty(k) { styleMap.delete(k); },
                },
                classList: {
                    add(...c) { c.forEach((x) => clsSet.add(x)); },
                    remove(...c) { c.forEach((x) => clsSet.delete(x)); },
                    toggle(c, f) { const on = f !== undefined ? !!f : !clsSet.has(c); if (on) clsSet.add(c); else clsSet.delete(c); return on; },
                    contains(c) { return clsSet.has(c); },
                },
                get className() { return Array.from(clsSet).join(" "); },
                set className(s) { clsSet.clear(); String(s || "").split(/\s+/).filter(Boolean).forEach((x) => clsSet.add(x)); },
                setAttribute(k, v) { attrs.set(k, String(v)); if (k === "id") this.id = String(v); },
                getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
                hasAttribute(k) { return attrs.has(k); },
                removeAttribute(k) { attrs.delete(k); },
                appendChild(c) { if (c) { c.parentElement = this; children.push(c); } return c; },
                prepend(c) { if (c) { c.parentElement = this; children.unshift(c); } return c; },
                append(...cs) { cs.forEach((c) => this.appendChild(c)); },
                getBoundingClientRect: () => opts.rect || { width: 320, height: 180 },
                getContext: () => null,
                pause() { this.paused = true; },
                play() { this.paused = false; return Promise.resolve(); },
                load() {},
                addEventListener() {},
                matches(sel) {
                    const role = attrs.get("role");
                    const slot = attrs.get("data-slot");
                    const tid = attrs.get("data-testid");
                    for (const part of String(sel).split(",").map((s) => s.trim())) {
                        if (!part) continue;
                        if (part.startsWith("#") && this.id === part.slice(1)) return true;
                        if (part.startsWith(".") && clsSet.has(part.slice(1))) return true;
                        if (part === '[role="dialog"]' && role === "dialog") return true;
                        if (part === '[role="alertdialog"]' && role === "alertdialog") return true;
                        if (part === '[role="menu"]' && role === "menu") return true;
                        if (part === '[aria-modal="true"]' && attrs.get("aria-modal") === "true") return true;
                        if (part === '[data-slot="hover-card-content"]' && slot === "hover-card-content") return true;
                        if (part === '[data-slot="dropdown-menu-sub-content"]' && slot === "dropdown-menu-sub-content") return true;
                        if (part === '[data-slot="dropdown-menu-content"]' && slot === "dropdown-menu-content") return true;
                        if (part === '[data-testid="settings-sidebar"]' && tid === "settings-sidebar") return true;
                        if (part === '[data-testid="settings-modal"]' && tid === "settings-modal") return true;
                        if (part === 'header' && this.tagName === "HEADER") return true;
                        if (part.startsWith("[") && part.endsWith("]")) {
                            const inner = part.slice(1, -1);
                            const eq = inner.indexOf("=");
                            if (eq > 0) {
                                const ak = inner.slice(0, eq).trim();
                                const av = inner.slice(eq + 1).replace(/^"|"$/g, "");
                                if (attrs.get(ak) === av) return true;
                            } else if (attrs.has(inner)) return true;
                        }
                    }
                    return false;
                },
                closest(sel) { let cur = this; while (cur) { if (cur.matches && cur.matches(sel)) return cur; cur = cur.parentElement; } return null; },
                querySelectorAll(sel) {
                    const out = [];
                    const walk = (n) => {
                        for (const ch of n.children || []) {
                            if (ch.matches && ch.matches(sel)) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(this);
                    return out;
                },
                querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
                attachShadow() {
                    const host = this;
                    const sr = makeEl31("shadow-root");
                    let _html = "";
                    sr.getElementById = (id) => sr.querySelector("#" + id);
                    sr.querySelector = (sel) => {
                        if (sel.startsWith("#")) return sr._byId?.get(sel.slice(1)) || null;
                        return makeEl31.prototype?.querySelector ? sr.querySelectorAll(sel)[0] : null;
                    };
                    sr.appendChild = (c) => {
                        if (c && typeof c.innerHTML === "string" && c.innerHTML.includes('id="sw-plain-bg"')) {
                            const map = new Map();
                            for (const idMatch of c.innerHTML.matchAll(/id="([^"]+)"/g)) {
                                map.set(idMatch[1], makeEl31("div", { attrs: { id: idMatch[1] } }));
                            }
                            sr._byId = map;
                        }
                        host._shadowRootRef = sr;
                        return c;
                    };
                    host.shadowRoot = sr;
                    return sr;
                },
            };
            el._computed = Object.assign({
                position: "fixed",
                backdropFilter: "none",
                webkitBackdropFilter: "none",
                opacity: "1",
                filter: "none",
                clipPath: "none",
                maskImage: "none",
                mixBlendMode: "normal",
                backgroundColor: "rgba(0, 0, 0, 0)",
                borderTopWidth: "0px",
                borderLeftWidth: "0px",
                transform: "none",
                isolation: "auto",
                contain: "none",
                overflow: "visible",
                willChange: "auto",
                zIndex: "auto",
            }, opts.computed || {});
            return el;
        };

        const docEl31 = makeEl31("html");
        const body31 = makeEl31("body");
        docEl31.appendChild(body31);
        const doc31 = {
            documentElement: docEl31,
            body: body31,
            visibilityState: "visible",
            hidden: false,
            createElement: (t) => makeEl31(t),
            getElementById: (id) => body31.querySelector("#" + id) || docEl31.querySelector("#" + id),
            querySelectorAll: (s) => docEl31.querySelectorAll(s),
            querySelector: (s) => docEl31.querySelector(s),
            addEventListener() {},
        };
        const sb31 = vm.createContext({
            window: { addEventListener() {}, dispatchEvent() {}, innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }) },
            document: doc31,
            getComputedStyle: (el) => el?._computed || { position: "relative", backdropFilter: "none", opacity: "1", filter: "none", clipPath: "none", maskImage: "none", mixBlendMode: "normal", backgroundColor: "transparent" },
            localStorage: { getItem: () => null, setItem() {} },
            fetch: () => Promise.resolve({ json: () => Promise.resolve({ videos: [], fonts: [] }) }),
            EventSource: function () { return { addEventListener() {}, close() {} }; },
            MutationObserver: function () { return { observe() {}, disconnect() {} }; },
            CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
            setTimeout: (fn) => 0,
            clearTimeout() {},
            setInterval: () => 0,
            clearInterval() {},
            requestAnimationFrame: (fn) => fn(),
            Date, Math, Number, String, Boolean, Array, Object, Set, Map, JSON, Promise, RegExp, encodeURIComponent, parseInt, parseFloat,
        });
        sb31.window.document = doc31;
        sb31.self = sb31.window;
        vm.runInContext(js31, sb31);
        const api31 = sb31.window.__agyThemeApi;
        assert(api31 && typeof api31.inspectBackdropChain === "function", "__agyThemeApi must expose inspectBackdropChain");

        // Test Shadow DOM --m-* and 0% -> 100% alpha + plain background toggle
        api31.setState({ themeMode: "light", panelAlpha: 0, reduceBackdropBlur: false, panelBlurPx: 32, wallpaperEnabled: false });
        assert.strictEqual(docEl31.dataset.agyPlainBg, "1", "Disabling wallpapers must set data-agy-plain-bg=1");
        assert.strictEqual(docEl31.style.getPropertyValue("--agy-scrim-opacity"), "0.000", "Plain background must zero scrim opacity");
        assert.strictEqual(docEl31.style.getPropertyValue("--agy-luma-boost"), "0.000", "Plain background must zero luma boost");
        const shadow31 = doc31.getElementById("agy-wp-shadow-host");
        assert(parseFloat(shadow31.style.getPropertyValue("--m-panel-bg").split(",")[3]) <= 0.08, "Personalization Shadow DOM modal must be genuine glass at 0%");
        assert(parseFloat(shadow31.style.getPropertyValue("--m-backdrop").split(",")[3]) <= 0.05, "Personalization backdrop must not black out 0% glass panel");
        const swPlain31 = shadow31.shadowRoot.getElementById("sw-plain-bg");
        assert(swPlain31 && swPlain31.classList.contains("on"), "#sw-plain-bg switch must reflect plain background ON");
        const secWpMedia31 = shadow31.shadowRoot.getElementById("sec-wp-media-group");
        assert(secWpMedia31 && secWpMedia31.classList.contains("section-disabled"), "Wallpaper controls group must dim via .section-disabled when plain background is active");

        api31.setState({ wallpaperEnabled: true, panelAlpha: 1 });
        assert.strictEqual(docEl31.dataset.agyPlainBg, undefined, "Re-enabling wallpapers must remove data-agy-plain-bg");
        assert(!secWpMedia31.classList.contains("section-disabled"), "Re-enabling wallpapers must restore wallpaper controls");
        assert(parseFloat(shadow31.style.getPropertyValue("--m-panel-bg").split(",")[3]) >= 0.99, "100% density must make Personalization Shadow DOM opaque");

        // Test syncPanelSurfaces + inspectBackdropChain: ancestor Backdrop Root removal & compact confirm modal uniform header
        const bdWrap31 = makeEl31("div", { attrs: { id: "bd-wrap" }, computed: { position: "fixed", opacity: "0.98", backdropFilter: "blur(4px)" }, rect: { width: 1280, height: 800 } });
        const confirmDlg31 = makeEl31("div", { attrs: { role: "alertdialog", "aria-modal": "true" }, computed: { position: "static" }, rect: { width: 380, height: 180 } });
        const confirmHdr31 = makeEl31("header", { text: "Подтвердить отмену", computed: { backgroundColor: "rgb(255, 255, 255)" }, rect: { width: 380, height: 40 } });
        confirmHdr31.appendChild(makeEl31("span", { text: "Confirm" }));
        confirmDlg31.appendChild(confirmHdr31);
        bdWrap31.appendChild(confirmDlg31);
        body31.appendChild(bdWrap31);
        api31.syncPanelSurfaces(doc31);
        assert.strictEqual(bdWrap31.getAttribute("data-agy-clear-bd-root"), "1", "Ancestor with opacity<1 / backdropFilter must be tagged data-agy-clear-bd-root=1");
        assert.strictEqual(confirmDlg31.getAttribute("data-agy-pos-rel"), "1", "Static-positioned dialog host must be tagged data-agy-pos-rel=1 for ::before anchoring");
        assert.strictEqual(confirmHdr31.getAttribute("data-agy-sticky-header"), null, "Compact confirmation modal header must NOT receive uneven sticky-header tint");
        assert.strictEqual(confirmHdr31.getAttribute("data-agy-panel-inner-clear"), "1", "Opaque white header wrapper inside modal must be cleared for uniform density");
        const chain31 = api31.inspectBackdropChain(confirmDlg31);
        assert(chain31.length >= 2 && chain31.some((n) => n.id === "bd-wrap" && n.blocksBackdropFilter === true), "inspectBackdropChain must diagnose ancestor backdrop-filter blockers");
    }

    // =========================================================================
    // [32/32] Runtime Performance & Anti-Cascade Regressions (rAF coalescing, fast-paths, diff-cache, zero-reflow)
    // =========================================================================
    {
        console.log("[32/32] Testing runtime performance invariants (slider fast-paths, diff-cache, zero-privacy-cascade, blur-skip, zero-reflow)...");
        const contrast32 = require("../customization/modules/agyUiContrast");
        const wp32 = require("../customization/modules/wallpaperEngine");

        // 1. Memoized contrast helpers preserve exact deterministic outputs
        const palA = contrast32.getAccessibleTextPalette([12, 14, 20]);
        const palB = contrast32.getAccessibleTextPalette([12, 14, 20]);
        assert.deepStrictEqual(palA, palB, "Memoized getAccessibleTextPalette must return identical palette");
        const accA = contrast32.ensureReadableAccentOnSurface([96, 165, 250], [250, 251, 254], 4.8);
        const accB = contrast32.ensureReadableAccentOnSurface([96, 165, 250], [250, 251, 254], 4.8);
        assert.strictEqual(accA, accB, "Memoized ensureReadableAccentOnSurface must return identical hex");
        assert(contrast32.contrastRatio(contrast32.parseRgb(accA), [250, 251, 254]) >= 4.8, "Memoized accent must meet WCAG >= 4.8");

        // 2. Client VM harness with counters for root CSS writes, events, storage, fetch, and getBoundingClientRect
        const js32 = wp32.buildInjectedJs("default", { accentRgb: "96, 165, 250", tintRgb: "12, 14, 20" }, 0, "");
        const metrics32 = {
            rootSetProp: 0,
            localStorageSet: 0,
            fetchConfigPost: 0,
            privacySyncEvents: 0,
            visualSyncEvents: 0,
            bcrCalls: 0,
            reset() {
                this.rootSetProp = 0;
                this.localStorageSet = 0;
                this.fetchConfigPost = 0;
                this.privacySyncEvents = 0;
                this.visualSyncEvents = 0;
                this.bcrCalls = 0;
            },
        };
        const makeEl32 = (tag, opts = {}) => {
            const attrs = new Map(Object.entries(opts.attrs || {}));
            const styleMap = new Map();
            const children = [];
            const clsSet = new Set(opts.classes || []);
            const isRoot = opts.isRoot === true;
            const el = {
                tagName: tag.toUpperCase(),
                nodeType: 1,
                id: attrs.get("id") || "",
                parentElement: null,
                children,
                childNodes: children,
                dataset: {},
                textContent: opts.text || "",
                value: "",
                disabled: false,
                src: "",
                paused: false,
                readyState: 4,
                style: {
                    setProperty(k, v) {
                        if (isRoot) metrics32.rootSetProp++;
                        styleMap.set(k, String(v));
                    },
                    getPropertyValue(k) { return styleMap.get(k) || ""; },
                    removeProperty(k) { styleMap.delete(k); },
                },
                classList: {
                    add(...c) { c.forEach((x) => clsSet.add(x)); },
                    remove(...c) { c.forEach((x) => clsSet.delete(x)); },
                    toggle(c, f) { const on = f !== undefined ? !!f : !clsSet.has(c); if (on) clsSet.add(c); else clsSet.delete(c); return on; },
                    contains(c) { return clsSet.has(c); },
                },
                get className() { return Array.from(clsSet).join(" "); },
                set className(s) { clsSet.clear(); String(s || "").split(/\s+/).filter(Boolean).forEach((x) => clsSet.add(x)); },
                setAttribute(k, v) { attrs.set(k, String(v)); if (k === "id") this.id = String(v); },
                getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
                hasAttribute(k) { return attrs.has(k); },
                removeAttribute(k) { attrs.delete(k); },
                appendChild(c) { if (c) { c.parentElement = this; children.push(c); } return c; },
                prepend(c) { if (c) { c.parentElement = this; children.unshift(c); } return c; },
                append(...cs) { cs.forEach((c) => this.appendChild(c)); },
                getBoundingClientRect() {
                    metrics32.bcrCalls++;
                    return opts.rect || { width: 160, height: 28 };
                },
                getContext: () => null,
                pause() { this.paused = true; },
                play() { this.paused = false; return Promise.resolve(); },
                load() {},
                addEventListener() {},
                matches(sel) {
                    const role = attrs.get("role");
                    const tid = attrs.get("data-testid");
                    for (const part of String(sel).split(",").map((s) => s.trim())) {
                        if (!part) continue;
                        if (part.startsWith("#") && this.id === part.slice(1)) return true;
                        if (part.startsWith(".") && clsSet.has(part.slice(1))) return true;
                        if (part === '[role="dialog"]' && role === "dialog") return true;
                        if (part === '[data-testid="settings-sidebar"]' && tid === "settings-sidebar") return true;
                        if (part === '[data-main-content-body]' && attrs.has("data-main-content-body")) return true;
                        if (part.toUpperCase() === this.tagName) return true;
                        if (part.startsWith("[") && part.endsWith("]")) {
                            const inner = part.slice(1, -1);
                            const eq = inner.indexOf("=");
                            if (eq > 0) {
                                const ak = inner.slice(0, eq).trim();
                                const av = inner.slice(eq + 1).replace(/^"|"$/g, "");
                                if (attrs.get(ak) === av) return true;
                            } else if (attrs.has(inner)) return true;
                        }
                    }
                    return false;
                },
                closest(sel) { let cur = this; while (cur) { if (cur.matches && cur.matches(sel)) return cur; cur = cur.parentElement; } return null; },
                querySelectorAll(sel) {
                    const out = [];
                    const walk = (n) => {
                        for (const ch of n.children || []) {
                            if (ch.matches && ch.matches(sel)) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(this);
                    return out;
                },
                querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
                attachShadow() {
                    const host = this;
                    const sr = makeEl32("shadow-root");
                    sr.getElementById = (id) => sr._byId?.get(id) || null;
                    sr.querySelector = (sel) => (sel.startsWith("#") ? sr._byId?.get(sel.slice(1)) || null : null);
                    sr.appendChild = (c) => {
                        if (c && typeof c.innerHTML === "string" && c.innerHTML.includes('id="r-alpha"')) {
                            const map = new Map();
                            for (const idMatch of c.innerHTML.matchAll(/id="([^"]+)"/g)) {
                                map.set(idMatch[1], makeEl32("input", { attrs: { id: idMatch[1] } }));
                            }
                            sr._byId = map;
                        }
                        host._shadowRootRef = sr;
                        return c;
                    };
                    host.shadowRoot = sr;
                    return sr;
                },
            };
            el._computed = Object.assign({ backgroundColor: "rgba(0, 0, 0, 0)" }, opts.computed || {});
            return el;
        };

        const docEl32 = makeEl32("html", { isRoot: true });
        const body32 = makeEl32("body");
        docEl32.appendChild(body32);
        const doc32 = {
            documentElement: docEl32,
            body: body32,
            visibilityState: "visible",
            hidden: false,
            createElement: (t) => makeEl32(t),
            getElementById: (id) => body32.querySelector("#" + id) || docEl32.querySelector("#" + id),
            querySelectorAll: (s) => docEl32.querySelectorAll(s),
            querySelector: (s) => docEl32.querySelector(s),
            addEventListener() {},
        };
        const rafQueue32 = [];
        const sb32 = vm.createContext({
            window: {
                addEventListener() {},
                dispatchEvent(ev) {
                    if (ev && ev.type === "agy-privacy-sync") metrics32.privacySyncEvents++;
                    if (ev && ev.type === "agy-visual-sync") metrics32.visualSyncEvents++;
                },
                innerWidth: 1280,
                innerHeight: 800,
                matchMedia: () => ({ matches: false, addEventListener() {} }),
            },
            document: doc32,
            getComputedStyle: (el) => el?._computed || { backgroundColor: "rgba(0, 0, 0, 0)" },
            localStorage: {
                getItem: () => null,
                setItem() { metrics32.localStorageSet++; },
            },
            fetch: (url, init) => {
                if (String(url).includes("/config") && init && init.method === "POST") metrics32.fetchConfigPost++;
                return Promise.resolve({ json: () => Promise.resolve({ videos: [], fonts: [] }) });
            },
            EventSource: function () { return { addEventListener() {}, close() {} }; },
            MutationObserver: function () { return { observe() {}, disconnect() {} }; },
            CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
            setTimeout: () => 1,
            clearTimeout() {},
            setInterval: () => 1,
            clearInterval() {},
            requestAnimationFrame: (fn) => { rafQueue32.push(fn); return rafQueue32.length; },
            Date, Math, Number, String, Boolean, Array, Object, Set, Map, JSON, Promise, RegExp, encodeURIComponent, parseInt, parseFloat,
        });
        sb32.window.document = doc32;
        sb32.self = sb32.window;
        vm.runInContext(js32, sb32);
        const flushRaf32 = () => {
            while (rafQueue32.length) {
                const fn = rafQueue32.shift();
                fn();
            }
        };
        flushRaf32();
        const api32 = sb32.window.__agyThemeApi;
        const sh32 = doc32.getElementById("agy-wp-shadow-host").shadowRoot;

        // 2a. Verify #r-dim oninput fast-path: ZERO root CSS writes, ZERO visual/privacy sync, ZERO disk/localStorage writes
        api32.setState({ themeMode: "dark", panelAlpha: 0.50, panelBlurPx: 20, reduceBackdropBlur: false, wallpaperEnabled: true });
        flushRaf32();
        metrics32.reset();
        const rDim = sh32.getElementById("r-dim");
        for (let i = 0; i < 10; i++) {
            rDim.value = (0.20 + i * 0.05).toFixed(2);
            rDim.oninput({ target: rDim });
        }
        flushRaf32();
        assert.strictEqual(metrics32.rootSetProp, 0, "#r-dim oninput drag must update scrim directly with 0 :root CSS var writes");
        assert.strictEqual(metrics32.privacySyncEvents, 0, "#r-dim oninput must NOT dispatch agy-privacy-sync");
        assert.strictEqual(metrics32.visualSyncEvents, 0, "#r-dim oninput must NOT dispatch agy-visual-sync");
        assert.strictEqual(metrics32.localStorageSet, 0, "#r-dim oninput drag must NOT write localStorage on every tick");
        assert.strictEqual(metrics32.fetchConfigPost, 0, "#r-dim oninput drag must NOT POST /config on every tick");
        rDim.onchange();
        assert(metrics32.localStorageSet >= 1 && metrics32.fetchConfigPost >= 1, "#r-dim onchange must commit config to localStorage & /config");

        // 2b. Verify #r-alpha oninput rAF coalescing + diff-cache + zero privacy cascade
        metrics32.reset();
        const rAlpha = sh32.getElementById("r-alpha");
        for (let i = 30; i < 40; i++) {
            rAlpha.value = String(i);
            rAlpha.oninput({ target: rAlpha });
        }
        // All 10 rapid oninput ticks before next frame must coalesce into ONE rAF flush
        assert.strictEqual(metrics32.visualSyncEvents, 0, "#r-alpha rapid oninput ticks must coalesce into next rAF");
        flushRaf32();
        assert.strictEqual(metrics32.visualSyncEvents, 1, "10 rapid #r-alpha ticks must coalesce into exactly 1 agy-visual-sync");
        assert.strictEqual(metrics32.privacySyncEvents, 0, "#r-alpha drag must NOT dispatch agy-privacy-sync");
        assert.strictEqual(metrics32.localStorageSet, 0, "#r-alpha drag must NOT write localStorage during drag");
        assert.strictEqual(metrics32.fetchConfigPost, 0, "#r-alpha drag must NOT POST /config during drag");
        assert(metrics32.rootSetProp < 35, `Diff-cache must write only alpha-dependent :root vars (<35), got ${metrics32.rootSetProp}`);

        // 2c. Verify blur-skip activates only at >= 96% opacity and restores real blur at <= 95%
        api32.setState({ panelAlpha: 0.50, panelBlurPx: 20, reduceBackdropBlur: false });
        assert.strictEqual(docEl32.dataset.agyBlurSkip, undefined, "50% panelAlpha must NOT set data-agy-blur-skip");
        assert.strictEqual(docEl32.style.getPropertyValue("--agy-panel-blur"), "20px", "50% panelAlpha must keep full 20px panel blur");
        api32.setState({ panelAlpha: 0.98, panelBlurPx: 20, reduceBackdropBlur: false });
        assert.strictEqual(docEl32.dataset.agyBlurSkip, "1", "98% opaque panelAlpha must set data-agy-blur-skip=1");
        assert.strictEqual(docEl32.style.getPropertyValue("--agy-panel-blur"), "0px", "98% opaque panelAlpha must zero effective panel blur");
        api32.setState({ panelAlpha: 0.65, panelBlurPx: 20, reduceBackdropBlur: false });
        assert.strictEqual(docEl32.dataset.agyBlurSkip, undefined, "Returning to 65% must clear data-agy-blur-skip");
        assert.strictEqual(docEl32.style.getPropertyValue("--agy-panel-blur"), "20px", "Returning to 65% must restore 20px blur");

        // 2d. Verify privacyMode change DOES still dispatch agy-privacy-sync immediately
        metrics32.reset();
        api32.setState({ privacyMode: true });
        assert.strictEqual(metrics32.privacySyncEvents, 1, "Toggling privacyMode must dispatch agy-privacy-sync");
        api32.setState({ panelAlpha: 0.72 });
        assert.strictEqual(metrics32.privacySyncEvents, 1, "Subsequent non-privacy setState must NOT re-dispatch agy-privacy-sync");

        // 2e. Verify syncLightDarkPills avoids getBoundingClientRect on transparent elements & prunes plain chat subtrees
        const chatBody32 = makeEl32("div", { attrs: { "data-main-content-body": "true" } });
        for (let i = 0; i < 40; i++) {
            chatBody32.appendChild(makeEl32("div", { text: "Chat turn " + i, computed: { backgroundColor: "rgb(255, 255, 255)" } }));
        }
        const transparentHolder = makeEl32("div", { text: "Transparent container", computed: { backgroundColor: "rgba(0, 0, 0, 0)" } });
        const invertedWhitePill = makeEl32("div", { text: "Inverted badge", computed: { backgroundColor: "rgb(255, 255, 255)" }, rect: { width: 140, height: 28 } });
        transparentHolder.appendChild(invertedWhitePill);
        body32.appendChild(chatBody32);
        body32.appendChild(transparentHolder);
        api32.setState({ themeMode: "dark" });
        metrics32.reset();
        const tagged32 = api32.syncLightDarkPills(doc32);
        assert.strictEqual(invertedWhitePill.getAttribute("data-agy-light-fix"), "1", "Inverted white pill in dark mode must still be tagged");
        assert(tagged32 >= 1, "syncLightDarkPills must tag inverted pill");
        assert.strictEqual(metrics32.bcrCalls, 1, `syncLightDarkPills must call getBoundingClientRect ONLY on inverted pill candidates (1), got ${metrics32.bcrCalls}`);
    }
})();

let asyncSuitesCompleted = false;
process.on("beforeExit", () => {
    if (!asyncSuitesCompleted) {
        console.error("FATAL: Async test suite hung without settling!");
        process.exit(1);
    }
});

phase1AsyncTests.then(() => {
    asyncSuitesCompleted = true;
    console.log("ALL MODULE BEHAVIOR TESTS PASSED!");
}).catch((err) => {
    asyncSuitesCompleted = true;
    console.error("ASYNC TEST FAILURE:", err);
    process.exit(1);
});
