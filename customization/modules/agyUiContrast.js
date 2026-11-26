"use strict";

function parseRgb(input, fallback = [18, 20, 25]) {
    let channels = [];
    if (Array.isArray(input)) {
        channels = input.slice(0, 3).map(Number);
    } else {
        const source = String(input || "");
        const hex = source.match(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/i);
        if (hex) {
            const rawHex = hex[1];
            const value = (rawHex.length === 3 || rawHex.length === 4)
                ? rawHex.slice(0, 3).split("").map((part) => part + part).join("")
                : rawHex.slice(0, 6);
            channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
        } else {
            channels = (source.match(/-?\d*\.?\d+/g) || []).slice(0, 3).map(Number);
        }
    }
    if (channels.length < 3 || channels.some((value) => !Number.isFinite(value))) {
        return fallback.slice(0, 3);
    }
    return channels.map((value) => Math.max(0, Math.min(255, Math.round(value))));
}

function relativeLuminance(rgb) {
    const [r, g, b] = parseRgb(rgb).map((v) => v / 255);
    const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(a, b) {
    const la = typeof a === "number" ? a : relativeLuminance(a);
    const lb = typeof b === "number" ? b : relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blendRgbOver(fgInput, alpha, bgInput) {
    const fg = parseRgb(fgInput, [96, 165, 250]);
    const bg = parseRgb(bgInput, [14, 17, 24]);
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return [
        Math.round(fg[0] * a + bg[0] * (1 - a)),
        Math.round(fg[1] * a + bg[1] * (1 - a)),
        Math.round(fg[2] * a + bg[2] * (1 - a)),
    ];
}

function rgbToHex(rgb) {
    const [r, g, b] = parseRgb(rgb);
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function getAccessibleTextPalette(input) {
    const rgb = parseRgb(input, [18, 20, 25]);
    const cache = getAccessibleTextPalette._cache || (getAccessibleTextPalette._cache = new Map());
    const cacheKey = rgb[0] + "," + rgb[1] + "," + rgb[2];
    const hit = cache.get(cacheKey);
    if (hit) return hit;

    const backgroundLuminance = relativeLuminance(rgb);
    const contrast = (luminance) => contrastRatio(luminance, backgroundLuminance);
    const lightLuminance = 1;
    const darkLuminance = 0;
    const useLightInk = contrast(lightLuminance) >= contrast(darkLuminance);
    const primary = useLightInk ? "#ffffff" : "#000000";
    const maxContrast = Math.max(contrast(lightLuminance), contrast(darkLuminance));
    const secondaryTarget = Math.max(4.5, Math.min(7, maxContrast * 0.72));
    const subtleTarget = Math.max(3, Math.min(4.5, maxContrast * 0.6));

    const toHex = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
    const grayForRatio = (target) => {
        const targetLuminance = useLightInk
            ? target * (backgroundLuminance + 0.05) - 0.05
            : (backgroundLuminance + 0.05) / target - 0.05;
        const linear = Math.max(0, Math.min(1, targetLuminance));
        const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * (linear ** (1 / 2.4)) - 0.055;
        const channel = toHex(srgb);
        return "#" + channel + channel + channel;
    };

    const result = {
        primary,
        secondary: grayForRatio(secondaryTarget),
        subtle: grayForRatio(subtleTarget),
        border: useLightInk ? "rgba(248,250,252,0.14)" : "rgba(17,24,39,0.16)",
        ringTrack: useLightInk ? "rgba(248,250,252,0.24)" : "rgba(17,24,39,0.22)",
    };
    if (cache.size >= 64) cache.clear();
    cache.set(cacheKey, result);
    return result;
}

function ensureReadableAccentOnSurface(accentInput, surfaceInput, minRatio = 4.5) {
    const acc = parseRgb(accentInput, [96, 165, 250]);
    const surf = parseRgb(surfaceInput, [14, 17, 24]);
    const cache = ensureReadableAccentOnSurface._cache || (ensureReadableAccentOnSurface._cache = new Map());
    const cacheKey = acc[0] + "," + acc[1] + "," + acc[2] + "|" + surf[0] + "," + surf[1] + "," + surf[2] + "|" + minRatio;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const store = (val) => {
        if (cache.size >= 256) cache.clear();
        cache.set(cacheKey, val);
        return val;
    };

    const surfLum = relativeLuminance(surf);
    if (contrastRatio(acc, surfLum) >= minRatio) return store(rgbToHex(acc));
    const target = surfLum < 0.45 ? [255, 255, 255] : [15, 23, 42];
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < 10; step++) {
        const mid = (lo + hi) * 0.5;
        const mixed = [
            Math.round(acc[0] + (target[0] - acc[0]) * mid),
            Math.round(acc[1] + (target[1] - acc[1]) * mid),
            Math.round(acc[2] + (target[2] - acc[2]) * mid),
        ];
        if (contrastRatio(mixed, surfLum) >= minRatio) hi = mid;
        else lo = mid;
    }
    const finalRgb = [
        Math.round(acc[0] + (target[0] - acc[0]) * hi),
        Math.round(acc[1] + (target[1] - acc[1]) * hi),
        Math.round(acc[2] + (target[2] - acc[2]) * hi),
    ];
    return store(rgbToHex(finalRgb));
}

function normalizeAdaptiveAccent(input) {
    let [r, g, b] = parseRgb(input, [96, 165, 250]);
    const maxC = Math.max(r, g, b, 1);
    const minC = Math.min(r, g, b);
    const sat = (maxC - minC) / maxC;
    if (sat < 0.14) {
        return [148, 163, 184];
    }
    if (maxC < 175) {
        const k = 175 / maxC;
        r = Math.min(255, Math.round(r * k));
        g = Math.min(255, Math.round(g * k));
        b = Math.min(255, Math.round(b * k));
    }
    const lum = relativeLuminance([r, g, b]);
    if (lum > 0.72) {
        const k = 0.84;
        r = Math.round(r * k);
        g = Math.round(g * k);
        b = Math.round(b * k);
    }
    return [r, g, b];
}

function getAdaptiveThemeTokens(tintInput, accentInput, tintAlpha = 0.24) {
    const tint = parseRgb(tintInput, [14, 17, 24]);
    const accent = parseRgb(accentInput, [96, 165, 250]);
    const surface = getAccessibleTextPalette(tint);
    const onSolidAccent = getAccessibleTextPalette(accent).primary;
    const tintedBg = blendRgbOver(accent, tintAlpha, tint);
    const onTintedAccent = getAccessibleTextPalette(tintedBg).primary;
    const accentText = ensureReadableAccentOnSurface(accent, tint, 4.8);
    return {
        surface,
        onSolidAccent,
        onTintedAccent,
        accentText,
    };
}

function getContrastBoost(wallpaperLuma, baseDim = 0) {
    const luma = Math.max(0, Math.min(255, Number(wallpaperLuma) || 0));
    const dim = Math.max(0, Math.min(0.92, Number(baseDim) || 0));
    if (luma <= 42) return 0;

    const pressure = (luma - 42) / (255 - 42);
    const maxExtra = Math.max(0, 0.90 - dim);
    const desiredLift = (0.04 + 0.34 * Math.pow(pressure, 0.85)) * Math.max(0.25, 1 - dim * 0.65);
    return Number(Math.min(maxExtra, Math.max(0, desiredLift)).toFixed(3));
}

function computeSurfaceLayers(panelAlpha = 0.68, highContrast = false) {
    const num = Number(panelAlpha);
    const p = Math.max(0, Math.min(1, Number.isFinite(num) ? num : 0.68));
    const lerp = (minVal, maxVal) => Number((minVal + (maxVal - minVal) * p).toFixed(3));
    if (highContrast) {
        return {
            panelAlpha: Number(p.toFixed(3)),
            baseAlpha: lerp(0.02, 0.78),
            sidebarAlpha: lerp(0.04, 0.965),
            cardAlpha: lerp(0.055, 0.98),
            composerAlpha: lerp(0.065, 0.99),
            editorAlpha: lerp(0.065, 0.995),
            modalAlpha: lerp(0.07, 1.0),
            hcScrimLift: 0.12,
        };
    }
    return {
        panelAlpha: Number(p.toFixed(3)),
        baseAlpha: lerp(0.00, 0.72),
        sidebarAlpha: lerp(0.02, 0.95),
        cardAlpha: lerp(0.04, 0.97),
        composerAlpha: lerp(0.05, 0.985),
        editorAlpha: lerp(0.05, 0.99),
        modalAlpha: lerp(0.06, 1.0),
        hcScrimLift: 0,
    };
}

function ensureReadableSyntaxColor(colorInput, surfaceInput, minRatio = 4.8) {
    const raw = String(colorInput || "").trim();
    if (!raw || raw === "inherit" || raw === "transparent" || raw === "currentColor") return null;
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw) && !/^rgba?\(/i.test(raw)) return null;

    const cache = ensureReadableSyntaxColor._cache || (ensureReadableSyntaxColor._cache = new Map());
    const cacheKey = raw + "|" + (Array.isArray(surfaceInput) ? surfaceInput.join(",") : String(surfaceInput || "")) + "|" + minRatio;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }
    const storeCache = (val) => {
        if (cache.size >= 512) cache.clear();
        cache.set(cacheKey, val);
        return val;
    };

    let alphaVal = 1;
    let alphaSuffix = "";
    const rgbaMatch = /^rgba?\(\s*(-?\d*\.?\d+)\s*[,\s]\s*(-?\d*\.?\d+)\s*[,\s]\s*(-?\d*\.?\d+)(?:\s*[,/]\s*(-?\d*\.?\d+%?))?\s*\)$/i.exec(raw);
    if (rgbaMatch && rgbaMatch[4] !== undefined) {
        const rawA = String(rgbaMatch[4]).trim();
        const aNum = rawA.endsWith("%") ? parseFloat(rawA) / 100 : parseFloat(rawA);
        if (!Number.isFinite(aNum) || aNum <= 0.05) return storeCache(null);
        if (aNum < 0.995) {
            alphaVal = Math.max(0.1, Math.min(1, Number(aNum.toFixed(3))));
            alphaSuffix = String(alphaVal);
        }
    } else if (/^#[0-9a-f]{4}$/i.test(raw) || /^#[0-9a-f]{8}$/i.test(raw)) {
        const hexBody = raw.slice(1);
        const alphaByte = hexBody.length === 4 ? parseInt(hexBody[3] + hexBody[3], 16) : parseInt(hexBody.slice(6, 8), 16);
        const aNum = alphaByte / 255;
        if (!Number.isFinite(aNum) || aNum <= 0.05) return storeCache(null);
        if (aNum < 0.995) {
            alphaVal = Math.max(0.1, Math.min(1, Number(aNum.toFixed(3))));
            alphaSuffix = String(alphaVal);
        }
    }

    const rgb = parseRgb(raw, [128, 128, 128]);
    const surf = parseRgb(surfaceInput, [12, 14, 20]);
    const surfLum = relativeLuminance(surf);
    const hasAlpha = alphaVal < 0.995;
    const effectiveRgb = hasAlpha ? blendRgbOver(rgb, alphaVal, surf) : rgb;
    if (contrastRatio(effectiveRgb, surfLum) >= minRatio) return storeCache(null);

    // Convert RGB to HSL so lightness moves toward readable ink while preserving hue & saturation
    let r = rgb[0] / 255;
    let g = rgb[1] / 255;
    let b = rgb[2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const origL = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = origL > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    const needDarker = surfLum >= 0.45;
    const boostedS = s > 0.08 ? Math.min(0.92, Math.max(s, needDarker ? 0.46 : 0.42)) : s;
    const hslToRgbArr = (hh, ss, ll) => {
        if (ss === 0) {
            const v = Math.round(ll * 255);
            return [v, v, v];
        }
        const hue2rgb = (p, q, t) => {
            let tt = t;
            if (tt < 0) tt += 1;
            if (tt > 1) tt -= 1;
            if (tt < 1 / 6) return p + (q - p) * 6 * tt;
            if (tt < 1 / 2) return q;
            if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
            return p;
        };
        const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
        const p = 2 * ll - q;
        return [
            Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
            Math.round(hue2rgb(p, q, hh) * 255),
            Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
        ];
    };

    let lo = needDarker ? 0.04 : origL;
    let hi = needDarker ? origL : 0.96;
    let best = needDarker ? [15, 23, 42] : [248, 250, 252];
    for (let step = 0; step < 12; step++) {
        const mid = (lo + hi) * 0.5;
        const cand = hslToRgbArr(h, boostedS, mid);
        const effCand = hasAlpha ? blendRgbOver(cand, alphaVal, surf) : cand;
        const ok = contrastRatio(effCand, surfLum) >= minRatio;
        if (needDarker) {
            if (ok) { best = cand; lo = mid; }
            else { hi = mid; }
        } else {
            if (ok) { best = cand; hi = mid; }
            else { lo = mid; }
        }
    }
    if (alphaSuffix) {
        return storeCache(`rgba(${best[0]}, ${best[1]}, ${best[2]}, ${alphaSuffix})`);
    }
    return storeCache(rgbToHex(best));
}

function computeEffectiveScrimOpacity(baseDim = 0.36, lumaBoost = 0, highContrast = false) {
    const dimNum = Number(baseDim);
    const dim = Math.max(0, Math.min(0.92, Number.isFinite(dimNum) ? dimNum : 0.36));
    const boostNum = Number(lumaBoost);
    const boost = Math.max(0, Math.min(0.92, Number.isFinite(boostNum) ? boostNum : 0));
    if (!highContrast) {
        return Number(Math.min(0.92, dim + boost).toFixed(3));
    }
    const hcLift = 0.12 * Math.max(0.25, 1 - dim);
    const extra = boost > 0 ? Math.max(boost, hcLift) + hcLift * 0.25 : hcLift;
    return Number(Math.min(0.90, dim + extra).toFixed(3));
}

function buildUiDesignTokens(opts = {}) {
    const effectiveMode = opts.effectiveMode === "light" ? "light" : "dark";
    const highContrast = opts.uiContrast === "high";
    const noBlur = Boolean(opts.reduceBackdropBlur);
    const fallbackTint = effectiveMode === "light" ? [250, 251, 254] : [12, 14, 20];
    const tintArr = parseRgb(opts.tintRgb, fallbackTint);
    const tintRgb = tintArr.join(", ");
    const isLightSurface = relativeLuminance(tintArr) >= 0.45;
    const fallbackAccent = isLightSurface ? [37, 99, 235] : [96, 165, 250];
    const accentArr = parseRgb(opts.accentRgb, fallbackAccent);
    const accentRgb = accentArr.join(", ");

    const layers = computeSurfaceLayers(opts.panelAlpha, highContrast);
    const g = layers.panelAlpha;
    const effAlpha = Math.min(1, g + (highContrast ? 0.04 * (1 - g) : 0));
    const scrimOpacity = computeEffectiveScrimOpacity(opts.dim, opts.lumaBoost, highContrast);
    const glassRgba = (r, gr, b, aMin, aMax) => "rgba(" + r + ", " + gr + ", " + b + ", " + (aMin + (aMax - aMin) * g).toFixed(3) + ")";

    let fg, fgSecondary, fgMuted, fgSubtle;
    const rawCustomHex = typeof opts.customTextHex === "string" ? opts.customTextHex.trim() : "";
    if (opts.useCustomText && /^#[0-9a-fA-F]{6}$/.test(rawCustomHex)) {
        const customFgRgb = parseRgb(rawCustomHex, isLightSurface ? [17, 24, 39] : [248, 250, 252]);
        const minFgRatio = highContrast ? 7.0 : 4.5;
        const minSecRatio = highContrast ? 6.0 : 4.5;
        const minMutRatio = highContrast ? 5.0 : 4.5;
        const minSubRatio = highContrast ? 4.5 : 3.2;

        fg = contrastRatio(customFgRgb, tintArr) >= minFgRatio
            ? rgbToHex(customFgRgb)
            : ensureReadableAccentOnSurface(customFgRgb, tintArr, minFgRatio);
        const safeFgRgb = parseRgb(fg, customFgRgb);
        fgSecondary = ensureReadableAccentOnSurface(blendRgbOver(safeFgRgb, highContrast ? 0.94 : 0.88, tintArr), tintArr, minSecRatio);
        fgMuted = ensureReadableAccentOnSurface(blendRgbOver(safeFgRgb, highContrast ? 0.84 : 0.76, tintArr), tintArr, minMutRatio);
        fgSubtle = ensureReadableAccentOnSurface(blendRgbOver(safeFgRgb, highContrast ? 0.72 : 0.62, tintArr), tintArr, minSubRatio);
    } else if (isLightSurface) {
        fg = highContrast ? "#000000" : "#111827";
        fgSecondary = highContrast ? "#0f172a" : "#1f2937";
        fgMuted = highContrast ? "#1e293b" : "#475569";
        fgSubtle = highContrast ? "#334155" : "#64748b";
    } else {
        fg = highContrast ? "#ffffff" : "#f8fafc";
        fgSecondary = highContrast ? "#f8fafc" : "#e2e8f0";
        fgMuted = highContrast ? "#e2e8f0" : "#b8c4d4";
        fgSubtle = highContrast ? "#cbd5e1" : "#8b9bb0";
    }

    const border = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.46)" : "rgba(15, 23, 42, 0.16)")
        : (highContrast ? "rgba(255, 255, 255, 0.44)" : "rgba(255, 255, 255, 0.15)");
    const borderStrong = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.72)" : "rgba(15, 23, 42, 0.28)")
        : (highContrast ? "rgba(255, 255, 255, 0.68)" : "rgba(255, 255, 255, 0.26)");
    const divider = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.34)" : "rgba(15, 23, 42, 0.12)")
        : (highContrast ? "rgba(255, 255, 255, 0.32)" : "rgba(255, 255, 255, 0.11)");
    const hoverBg = isLightSurface
        ? (noBlur
            ? (highContrast ? "rgba(15, 23, 42, 0.10)" : "rgba(15, 23, 42, 0.055)")
            : (highContrast ? glassRgba(255, 255, 255, 0.14, 0.74) : glassRgba(255, 255, 255, 0.10, 0.54)))
        : (highContrast ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.08)");
    const subtleBg = isLightSurface
        ? (noBlur
            ? (highContrast ? "rgba(226, 232, 240, 0.90)" : "rgba(241, 245, 249, 0.88)")
            : (highContrast ? glassRgba(241, 245, 249, 0.06, 0.72) : glassRgba(248, 250, 252, 0.04, 0.56)))
        : (highContrast ? glassRgba(255, 255, 255, 0.03, 0.12) : glassRgba(255, 255, 255, 0.02, 0.07));
    const subtleBgStrong = isLightSurface
        ? (noBlur
            ? (highContrast ? "rgba(203, 213, 225, 0.94)" : "rgba(226, 232, 240, 0.90)")
            : (highContrast ? glassRgba(226, 232, 240, 0.10, 0.86) : glassRgba(241, 245, 249, 0.07, 0.74)))
        : (highContrast ? glassRgba(255, 255, 255, 0.06, 0.25) : glassRgba(255, 255, 255, 0.04, 0.15));
    const ringTrack = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.34)" : "rgba(17, 24, 39, 0.22)")
        : (highContrast ? "rgba(255, 255, 255, 0.36)" : "rgba(248, 250, 252, 0.24)");

    const scrimColor = isLightSurface
        ? ("rgba(" + tintRgb + ", 0.92)")
        : (opts.useCustomBg ? ("rgba(" + tintRgb + ", 0.88)") : "rgba(6, 8, 14, 0.88)");
    const scrollbarThumb = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.36)" : "rgba(15, 23, 42, 0.20)")
        : (highContrast ? "rgba(255, 255, 255, 0.34)" : "rgba(255, 255, 255, 0.16)");
    const scrollbarThumbHover = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.56)" : "rgba(15, 23, 42, 0.36)")
        : (highContrast ? "rgba(255, 255, 255, 0.52)" : "rgba(255, 255, 255, 0.30)");

    const shadowPanel = isLightSurface ? "0 16px 40px rgba(15, 23, 42, 0.14)" : "0 18px 46px rgba(0, 0, 0, 0.42)";
    const shadowCard = isLightSurface ? "0 8px 24px rgba(15, 23, 42, 0.09)" : "0 10px 30px rgba(0, 0, 0, 0.36)";
    const shadowCardFocus = isLightSurface ? "0 10px 28px rgba(15, 23, 42, 0.15)" : "0 12px 34px rgba(0, 0, 0, 0.44)";

    const backdropBg = isLightSurface
        ? (noBlur ? "rgba(241, 245, 249, 0.34)" : glassRgba(241, 245, 249, 0.02, 0.20))
        : (noBlur ? "rgba(4, 6, 10, 0.56)" : glassRgba(4, 6, 10, 0.05, 0.42));
    const backdropNoBlurBg = isLightSurface ? "rgba(241, 245, 249, 0.34)" : "rgba(4, 6, 10, 0.66)";
    const listBoxBg = isLightSurface
        ? (noBlur
            ? (highContrast ? "rgba(226, 232, 240, 0.88)" : "rgba(241, 245, 249, 0.86)")
            : (highContrast ? glassRgba(248, 250, 252, 0.04, 0.68) : glassRgba(255, 255, 255, 0.03, 0.50)))
        : (highContrast ? glassRgba(0, 0, 0, 0.05, 0.44) : glassRgba(0, 0, 0, 0.03, 0.32));
    const navBg = isLightSurface
        ? (noBlur
            ? (highContrast ? "rgba(241, 245, 249, 0.90)" : "rgba(248, 250, 252, 0.86)")
            : (highContrast ? glassRgba(248, 250, 252, 0.03, 0.56) : glassRgba(255, 255, 255, 0.02, 0.38)))
        : (highContrast ? glassRgba(255, 255, 255, 0.015, 0.05) : glassRgba(255, 255, 255, 0.01, 0.03));
    const cardBg = isLightSurface
        ? (noBlur
            ? (highContrast ? "rgba(241, 245, 249, 0.92)" : "rgba(248, 250, 252, 0.88)")
            : (highContrast ? glassRgba(255, 255, 255, 0.04, 0.66) : glassRgba(255, 255, 255, 0.025, 0.50)))
        : (highContrast ? glassRgba(255, 255, 255, 0.02, 0.075) : glassRgba(255, 255, 255, 0.015, 0.045));

    const tintedAlpha = highContrast ? 0.28 : 0.24;
    const baseAccentTokens = getAdaptiveThemeTokens(tintRgb, accentRgb, tintedAlpha);
    const onSolidAccent = baseAccentTokens.onSolidAccent;
    const onTintedAccent = baseAccentTokens.onTintedAccent;
    const accentText = ensureReadableAccentOnSurface(accentArr, tintArr, highContrast ? 7.0 : 4.8);
    const codeFg = ensureReadableAccentOnSurface(blendRgbOver(accentArr, 0.42, parseRgb(fg)), tintArr, highContrast ? 7.0 : 5.0);

    const panelBlurPx = noBlur
        ? 0
        : (Number.isFinite(Number(opts.panelBlurPx)) ? Math.max(0, Math.min(32, Math.round(Number(opts.panelBlurPx)))) : 20);
    const popoverAlpha = noBlur
        ? Number(Math.max(Math.min(1, layers.modalAlpha + 0.02), highContrast ? 0.97 : 0.94).toFixed(3))
        : Number(Math.min(1, layers.modalAlpha + 0.01 * (1 - layers.modalAlpha)).toFixed(3));
    const dialogAlpha = noBlur
        ? Number(Math.max(layers.modalAlpha, highContrast ? 0.96 : 0.92).toFixed(3))
        : layers.modalAlpha;
    const stickyAlpha = noBlur
        ? Number(Math.min(1, Math.max(popoverAlpha, dialogAlpha + 0.02)).toFixed(3))
        : Number(Math.min(1, dialogAlpha + 0.01 * (1 - dialogAlpha)).toFixed(3));
    const surfaceBase = "rgba(" + tintRgb + ", " + layers.baseAlpha.toFixed(3) + ")";
    const surfaceSidebar = "rgba(" + tintRgb + ", " + layers.sidebarAlpha.toFixed(3) + ")";
    const surfaceCard = "rgba(" + tintRgb + ", " + layers.cardAlpha.toFixed(3) + ")";
    const surfaceComposer = "rgba(" + tintRgb + ", " + layers.composerAlpha.toFixed(3) + ")";
    const surfaceEditor = "rgba(" + tintRgb + ", " + layers.editorAlpha.toFixed(3) + ")";
    const surfaceModal = "rgba(" + tintRgb + ", " + layers.modalAlpha.toFixed(3) + ")";
    const surfacePopover = "rgba(" + tintRgb + ", " + popoverAlpha.toFixed(3) + ")";
    const surfaceDialog = "rgba(" + tintRgb + ", " + dialogAlpha.toFixed(3) + ")";
    const surfaceSticky = "rgba(" + tintRgb + ", " + stickyAlpha.toFixed(3) + ")";

    const dangerFg = ensureReadableAccentOnSurface(isLightSurface ? [185, 28, 28] : [252, 165, 165], tintArr, highContrast ? 7.0 : 4.8);
    const warnFg = ensureReadableAccentOnSurface(isLightSurface ? [180, 83, 9] : [252, 211, 77], tintArr, highContrast ? 7.0 : 4.8);
    const okFg = ensureReadableAccentOnSurface(isLightSurface ? [21, 128, 61] : [134, 239, 172], tintArr, highContrast ? 7.0 : 4.8);

    const diffAddBg = isLightSurface ? (highContrast ? "rgba(22, 163, 74, 0.22)" : "rgba(22, 163, 74, 0.14)") : (highContrast ? "rgba(34, 197, 94, 0.24)" : "rgba(34, 197, 94, 0.16)");
    const diffAddWordBg = isLightSurface ? "rgba(22, 163, 74, 0.30)" : "rgba(34, 197, 94, 0.34)";
    const diffAddBorder = isLightSurface ? "#15803d" : (highContrast ? "#4ade80" : "rgba(74, 222, 128, 0.72)");
    const diffAddFg = okFg;
    const diffDelBg = isLightSurface ? (highContrast ? "rgba(220, 38, 38, 0.20)" : "rgba(220, 38, 38, 0.13)") : (highContrast ? "rgba(239, 68, 68, 0.24)" : "rgba(239, 68, 68, 0.16)");
    const diffDelWordBg = isLightSurface ? "rgba(220, 38, 38, 0.28)" : "rgba(239, 68, 68, 0.34)";
    const diffDelBorder = isLightSurface ? "#b91c1c" : (highContrast ? "#f87171" : "rgba(248, 113, 113, 0.72)");
    const diffDelFg = dangerFg;

    const sliderThumbBg = isLightSurface ? "#0f172a" : "#ffffff";
    const sliderThumbShadow = isLightSurface
        ? (highContrast ? "0 1px 4px rgba(15, 23, 42, 0.45)" : "0 1px 3px rgba(15, 23, 42, 0.30)")
        : "0 1px 4px rgba(0, 0, 0, 0.55)";

    const fsBg = rgbToHex(tintArr);
    const fsBgFilter = isLightSurface
        ? "blur(64px) brightness(1.06) saturate(1.15) opacity(0.30)"
        : "blur(64px) brightness(0.30) saturate(1.30)";
    const fsLyricsIdle = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.56)" : "rgba(15, 23, 42, 0.38)")
        : (highContrast ? "rgba(255, 255, 255, 0.50)" : "rgba(255, 255, 255, 0.28)");
    const fsLyricsPast = isLightSurface
        ? (highContrast ? "rgba(15, 23, 42, 0.72)" : "rgba(15, 23, 42, 0.56)")
        : (highContrast ? "rgba(255, 255, 255, 0.68)" : "rgba(255, 255, 255, 0.46)");
    const fsLyricsActive = fg;

    return {
        effectiveMode,
        highContrast,
        noBlur,
        panelBlurPx,
        tintRgb,
        accentRgb,
        isLightSurface,
        layers,
        effAlpha,
        scrimOpacity,
        fg,
        fgSecondary,
        fgMuted,
        fgSubtle,
        border,
        borderStrong,
        divider,
        hoverBg,
        subtleBg,
        subtleBgStrong,
        ringTrack,
        scrimColor,
        scrollbarThumb,
        scrollbarThumbHover,
        shadowPanel,
        shadowCard,
        shadowCardFocus,
        backdropBg,
        backdropNoBlurBg,
        listBoxBg,
        navBg,
        cardBg,
        surfaceBase,
        surfaceSidebar,
        surfaceCard,
        surfaceComposer,
        surfaceEditor,
        surfaceModal,
        surfacePopover,
        surfaceDialog,
        surfaceSticky,
        onSolidAccent,
        onTintedAccent,
        accentText,
        codeFg,
        dangerFg,
        warnFg,
        okFg,
        diffAddBg,
        diffAddWordBg,
        diffAddBorder,
        diffAddFg,
        diffDelBg,
        diffDelWordBg,
        diffDelBorder,
        diffDelFg,
        sliderThumbBg,
        sliderThumbShadow,
        fsBg,
        fsBgFilter,
        fsLyricsIdle,
        fsLyricsPast,
        fsLyricsActive,
    };
}

function serializeContrastHelpers() {
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
        getContrastBoost,
        computeSurfaceLayers,
        computeEffectiveScrimOpacity,
        ensureReadableSyntaxColor,
        buildUiDesignTokens,
    ].map((fn) => fn.toString()).join("\n");
}

module.exports = {
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
};
