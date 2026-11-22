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

console.log("[1/4] Checking JS syntax of all modified modules...");
for (const f of [
    "customization/modules/agyExtras.js",
    "customization/modules/wallpaperEngine.js",
    "customization/modules/agyI18n.js",
    "customization/modules/agyTabManager.js",
    "customization/patched_system/languageServer.js",
]) {
    testSyntax(f);
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
    "2m": "2м",
    "45s": "45с",
};
for (const [en, ru] of Object.entries(expectedI18n)) {
    assert.strictEqual(window.__agyI18n._translateTextForTest(en), ru, `Mismatch for "${en}"`);
}

console.log("[4/4] Testing player hover/volume/karaoke state machine conflict matrix...");
function makeStateMachine(hoverOpenPlayer) {
    let cardOpen = false;
    let cardPinned = false;
    let cardHoverOpen = false;
    let barVolOpen = false;
    let frozen = false;
    let displayedText = "Track A";
    let pendingText = "Track A";

    return {
        state: () => ({ cardOpen, cardPinned, cardHoverOpen, barVolOpen, frozen, displayedText }),
        setHoverPref(v) {
            hoverOpenPlayer = v;
            if (!v && cardHoverOpen && !cardPinned) { cardHoverOpen = false; cardOpen = false; }
        },
        enterBar() { frozen = true; },
        leaveBar() { frozen = false; displayedText = pendingText; },
        karaokeTick(line) { pendingText = line; if (!frozen) displayedText = line; },
        enterInfoZone() {
            if (hoverOpenPlayer && !barVolOpen) { cardHoverOpen = true; cardOpen = true; }
        },
        clickInfoZone() {
            if (cardPinned) { cardPinned = false; cardHoverOpen = false; cardOpen = false; }
            else if (cardHoverOpen && cardOpen) { cardPinned = true; cardHoverOpen = false; }
            else { cardPinned = true; cardOpen = true; }
        },
        openBarVol() {
            barVolOpen = true;
            if (cardHoverOpen && !cardPinned) { cardHoverOpen = false; cardOpen = false; }
        },
        closeBarVol() { barVolOpen = false; },
        leaveCard() {
            if (cardHoverOpen && !cardPinned) { cardHoverOpen = false; cardOpen = false; }
        },
    };
}

// Case 1: hoverOpenPlayer = true -> hover info zone opens mini-widget, opening volume closes hover-opened card
const sm1 = makeStateMachine(true);
sm1.enterBar();
sm1.karaokeTick("New Lyric Line");
assert.strictEqual(sm1.state().displayedText, "Track A", "Karaoke must stay frozen while hovering bar");
sm1.enterInfoZone();
assert.strictEqual(sm1.state().cardOpen, true);
assert.strictEqual(sm1.state().cardHoverOpen, true);
sm1.openBarVol();
assert.strictEqual(sm1.state().barVolOpen, true);
assert.strictEqual(sm1.state().cardOpen, false, "Volume popup must close hover-opened card to avoid overlap");
sm1.closeBarVol();
sm1.leaveBar();
assert.strictEqual(sm1.state().displayedText, "New Lyric Line", "Karaoke must flush pending line on mouseleave");

// Case 2: hover-opened card becomes pinned on click, and stays open when opening volume or leaving card
const sm2 = makeStateMachine(true);
sm2.enterInfoZone();
sm2.clickInfoZone();
assert.strictEqual(sm2.state().cardPinned, true);
sm2.openBarVol();
assert.strictEqual(sm2.state().cardOpen, true, "Pinned card stays open when adjusting volume");
sm2.leaveCard();
assert.strictEqual(sm2.state().cardOpen, true, "Pinned card stays open on mouseleave");
sm2.clickInfoZone();
assert.strictEqual(sm2.state().cardOpen, false, "Second click unpins and closes card");

// Case 3: hoverOpenPlayer = false -> hovering info zone NEVER opens card, only click does
const sm3 = makeStateMachine(false);
sm3.enterInfoZone();
assert.strictEqual(sm3.state().cardOpen, false);
sm3.clickInfoZone();
assert.strictEqual(sm3.state().cardOpen, true);

// Case 4: disabling hoverOpenPlayer while hover-opened closes card immediately
const sm4 = makeStateMachine(true);
sm4.enterInfoZone();
assert.strictEqual(sm4.state().cardOpen, true);
sm4.setHoverPref(false);
assert.strictEqual(sm4.state().cardOpen, false);

console.log("ALL MODULE BEHAVIOR TESTS PASSED!");
