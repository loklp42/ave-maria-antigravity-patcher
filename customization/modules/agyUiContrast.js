"use strict";

function parseRgb(input, fallback = [18, 20, 25]) {
    let channels = [];
    if (Array.isArray(input)) {
        channels = input.slice(0, 3).map(Number);
    } else {
        const source = String(input || "");
        const hex = source.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
        if (hex) {
            const value = hex[1].length === 3
                ? hex[1].split("").map((part) => part + part).join("")
                : hex[1];
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

    return {
        primary,
        secondary: grayForRatio(secondaryTarget),
        subtle: grayForRatio(subtleTarget),
        border: useLightInk ? "rgba(248,250,252,0.14)" : "rgba(17,24,39,0.16)",
        ringTrack: useLightInk ? "rgba(248,250,252,0.24)" : "rgba(17,24,39,0.22)",
    };
}

function ensureReadableAccentOnSurface(accentInput, surfaceInput, minRatio = 4.5) {
    const acc = parseRgb(accentInput, [96, 165, 250]);
    const surf = parseRgb(surfaceInput, [14, 17, 24]);
    const surfLum = relativeLuminance(surf);
    if (contrastRatio(acc, surfLum) >= minRatio) return rgbToHex(acc);
    const target = surfLum < 0.5 ? [255, 255, 255] : [15, 23, 42];
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
    return rgbToHex(finalRgb);
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
    const targetLuma = 112;
    const scrimLuma = 6;
    const scrimOpacity = 0.88;
    if (luma <= targetLuma) return 0;

    const requiredCoverage = (luma - targetLuma) / (luma - scrimLuma);
    const requiredOpacity = Math.min(0.92, requiredCoverage / scrimOpacity);
    return Math.max(0, Math.min(0.92 - dim, requiredOpacity - dim));
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
};
