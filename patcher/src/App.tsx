import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { STRINGS, type BackdropMode, type UiLang } from "./i18n";
import type {
  DiagnosticsResult,
  LogLine,
  ModuleOptions,
  PatcherStatus,
  ProgressEvent,
  ThemeHint,
} from "./types";

type ModuleKey = keyof Pick<
  ModuleOptions,
  "wallpaper" | "media" | "context" | "i18n" | "accounts"
>;

const MODULE_KEYS: ModuleKey[] = [
  "wallpaper",
  "media",
  "context",
  "i18n",
  "accounts",
];

function ModuleIcon({ id }: { id: ModuleKey }) {
  switch (id) {
    case "wallpaper":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.35" />
          <circle cx="5.7" cy="6" r="1.15" fill="currentColor" />
          <path d="M3.2 11.5L6.5 8.2L9.2 10.6L11 8.8L13.2 11.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "media":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6.5 11.5V4.2L13 3V10.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="4.8" cy="11.8" r="1.7" stroke="currentColor" strokeWidth="1.35" />
          <circle cx="11.3" cy="10.5" r="1.7" stroke="currentColor" strokeWidth="1.35" />
        </svg>
      );
    case "context":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.35" strokeOpacity="0.35" />
          <path d="M8 2.5A5.5 5.5 0 1 1 3.1 10.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
        </svg>
      );
    case "i18n":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.35" />
          <ellipse cx="8" cy="8" rx="2.5" ry="5.6" stroke="currentColor" strokeWidth="1.25" />
          <path d="M2.6 8H13.4" stroke="currentColor" strokeWidth="1.25" />
        </svg>
      );
    case "accounts":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="6.2" cy="5.5" r="2.2" stroke="currentColor" strokeWidth="1.35" />
          <path d="M2.5 12.8C2.8 10.6 4.3 9.5 6.2 9.5C8.1 9.5 9.6 10.6 9.9 12.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <circle cx="11.3" cy="6.2" r="1.6" stroke="currentColor" strokeWidth="1.25" />
          <path d="M10.4 9.7C11.9 9.8 13.1 10.8 13.5 12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      );
  }
}

function nowTime(): string {
  return new Date().toLocaleTimeString("ru-RU", { hour12: false });
}

export default function App() {
  const [lang, setLang] = useState<UiLang>(() => {
    const saved = localStorage.getItem("patcher_lang");
    return saved === "en" ? "en" : "ru";
  });
  const [scale, setScale] = useState<number>(() => {
    const saved = Number(localStorage.getItem("patcher_scale"));
    return saved === 90 || saved === 100 || saved === 110 ? saved : 100;
  });
  const [backdropMode, setBackdropMode] = useState<BackdropMode>(() => {
    const saved = localStorage.getItem("patcher_backdrop");
    return saved === "gradient" || saved === "solid" ? saved : "wallpaper";
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const t = STRINGS[lang];

  const [status, setStatus] = useState<PatcherStatus>({
    antigravityPath: "",
    customizationFound: true,
    version: "—",
    state: "not_found",
    hasBackup: false,
    asarSize: 0,
    wallpaperPath: "",
    wallpaperCount: 0,
    runningProcesses: [],
    installedAt: null,
  });

  const [options, setOptions] = useState<ModuleOptions>({
    antigravityPath: "",
    wallpaper: true,
    wallpaperDir: "",
    media: true,
    context: true,
    i18n: true,
    accounts: true,
  });

  const [theme, setTheme] = useState<ThemeHint>({
    backdropDataUrl: null,
    accentRgb: null,
  });

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [diag, setDiag] = useState<DiagnosticsResult | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [hasErrorLog, setHasErrorLog] = useState(false);
  const [copied, setCopied] = useState(false);

  const logIdRef = useRef(1);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem("patcher_lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("patcher_scale", String(scale));
    document.documentElement.style.zoom = `${scale}%`;
  }, [scale]);

  useEffect(() => {
    localStorage.setItem("patcher_backdrop", backdropMode);
  }, [backdropMode]);

  const pushLog = (text: string, level: LogLine["level"] = "info") => {
    if (level === "error") setHasErrorLog(true);
    setLogs((prev) => [
      ...prev,
      { id: logIdRef.current++, time: nowTime(), text, level },
    ]);
  };

  const refreshStatus = async (silent = false) => {
    try {
      const st = await invoke<PatcherStatus>("get_status");
      setStatus(st);
      setOptions((prev) => ({
        ...prev,
        antigravityPath: st.antigravityPath,
        wallpaperDir: prev.wallpaperDir || st.wallpaperPath,
      }));
      if (!silent) {
        if (st.state === "not_found") {
          pushLog(t.folderNotFound, "warn");
        } else {
          pushLog(
            `Antigravity ${st.version} (${st.state === "patched" ? t.patched : t.original})`,
            "info"
          );
        }
        if (!st.customizationFound) {
          pushLog("customization/ not found", "error");
        }
      }
      invoke<ThemeHint>("get_theme_hint", {
        workshopDir: st.wallpaperPath || null,
      })
        .then((hint) => {
          setTheme(hint);
          if (hint.accentRgb) {
            document.documentElement.style.setProperty("--accent-rgb", hint.accentRgb);
          }
        })
        .catch(() => {});
    } catch (err) {
      pushLog(String(err), "error");
    }
  };

  useEffect(() => {
    refreshStatus();

    const unlistenPromise = listen<ProgressEvent>("patch-progress", (event) => {
      const payload = event.payload;
      setProgress(payload);
      pushLog(payload.stage, payload.level);
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (drawerOpen) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, drawerOpen]);

  const handleBrowseAntigravity = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: status.antigravityPath || undefined,
      title: t.pickAntigravityTitle,
    });
    if (typeof selected === "string" && selected) {
      try {
        const st = await invoke<PatcherStatus>("set_antigravity_dir", { dir: selected });
        setStatus(st);
        setOptions((prev) => ({ ...prev, antigravityPath: st.antigravityPath }));
        pushLog(`Antigravity: ${selected}`);
      } catch (err) {
        pushLog(String(err), "error");
      }
    }
  };

  const handleBrowseWallpaper = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: options.wallpaperDir || undefined,
      title: t.pickWallpaperTitle,
    });
    if (typeof selected === "string" && selected) {
      const count = await invoke<number>("count_wallpapers", { dir: selected });
      setOptions((prev) => ({ ...prev, wallpaperDir: selected }));
      setStatus((prev) => ({ ...prev, wallpaperPath: selected, wallpaperCount: count }));
      pushLog(`${t.wallpaperFolder} ${selected} (${count})`);
    }
  };

  const handleApply = async () => {
    if (busy) return;
    setBusy(true);
    setProgress({ stage: t.preparing, percent: 5, level: "info" });
    try {
      await invoke("apply_patch", { options });
      await refreshStatus(true);
    } catch (err) {
      const msg = String(err);
      setProgress({ stage: msg, percent: 100, level: "error" });
      pushLog(msg, "error");
      setDrawerOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (busy || (!status.hasBackup && status.state !== "patched")) return;
    setBusy(true);
    setProgress({ stage: t.restoring, percent: 10, level: "info" });
    try {
      await invoke("restore_original");
      await refreshStatus(true);
    } catch (err) {
      const msg = String(err);
      setProgress({ stage: msg, percent: 100, level: "error" });
      pushLog(msg, "error");
      setDrawerOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const handleLaunch = async () => {
    try {
      await invoke("launch_antigravity");
      pushLog(t.launched, "success");
    } catch (err) {
      pushLog(String(err), "error");
      setDrawerOpen(true);
    }
  };

  const handleRunDiagnostics = async () => {
    pushLog(t.diagStart);
    try {
      const res = await invoke<DiagnosticsResult>("run_diagnostics");
      setDiag(res);
      if (res.dryRunPassed && (res.writePermission || res.canElevate)) {
        pushLog(t.diagOk, "success");
      } else {
        for (const e of res.errors) {
          pushLog(e, "error");
        }
      }
    } catch (err) {
      pushLog(String(err), "error");
    }
  };

  const handleCopyLogs = async () => {
    const text = logs
      .map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.text}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const enabledCount = MODULE_KEYS.filter((k) => options[k]).length;
  const appWindow = getCurrentWindow();

  const statusLabel =
    status.state === "patched"
      ? t.patched
      : status.state === "original"
      ? t.original
      : t.notFound;

  const sizeText = status.asarSize
    ? `${(status.asarSize / (1024 * 1024)).toFixed(1)} ${t.mb}`
    : "—";

  return (
    <div className="app" onClick={() => settingsOpen && setSettingsOpen(false)}>
      {/* Ambient Backdrop */}
      <div className={`backdrop-layer ${backdropMode}`} aria-hidden="true">
        {backdropMode === "wallpaper" && theme.backdropDataUrl && (
          <img className="backdrop-img" src={theme.backdropDataUrl} alt="" />
        )}
        {backdropMode !== "solid" && <div className="backdrop-scrim" />}
      </div>

      <div className="chrome">
        {/* Titlebar */}
        <header className="titlebar" data-tauri-drag-region>
          <div className="titlebar-brand">
            <svg className="brand-mark" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3" stroke="currentColor" strokeWidth="1.35" />
              <path d="M5.4 10.6L8 5.1L10.6 10.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6.4 8.9H9.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
            <span className="brand-name">Ave Maria Patcher</span>
            <span className="brand-ver">v2.34.0</span>
          </div>

          <div className="win-controls">
            <button
              type="button"
              className={`win-btn ${settingsOpen ? "active" : ""}`}
              aria-label={t.settingsTitle}
              title={t.settingsTitle}
              onClick={(e) => {
                e.stopPropagation();
                setSettingsOpen((v) => !v);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn"
              aria-label={t.minimize}
              onClick={() => appWindow.minimize()}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                <path d="M1.5 5H8.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn close"
              aria-label={t.close}
              onClick={() => appWindow.close()}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {/* Main */}
        <main className="content">
          {/* Target Card */}
          <section className="glass-card target-card">
            <div className="target-top">
              <div className="target-title-wrap">
                <span className="target-title">
                  Antigravity {status.version !== "—" ? status.version : ""}
                </span>
                <span className={`status-pill ${status.state}`}>
                  <span className="status-pill-dot" />
                  {statusLabel}
                </span>
              </div>

              <button
                type="button"
                className="btn btn-sm"
                onClick={handleBrowseAntigravity}
                disabled={busy}
              >
                {t.browse}
              </button>
            </div>

            <div className="path-bar" title={status.antigravityPath}>
              <span className="path-text">
                {status.antigravityPath || t.folderNotFound}
              </span>
            </div>

            <div className="metrics-row">
              <span className="metric-chip">
                {t.size} <strong>{sizeText}</strong>
              </span>
              <span className={`metric-chip ${status.hasBackup ? "ok" : ""}`}>
                {t.backup} <strong>{status.hasBackup ? t.yes : t.no}</strong>
              </span>
              {status.runningProcesses.length > 0 && (
                <span className="metric-chip warn">
                  {t.running} <strong>{status.runningProcesses.length}</strong>
                </span>
              )}
              {status.wallpaperCount > 0 && (
                <span className="metric-chip">
                  {t.wallpapersCount} <strong>{status.wallpaperCount}</strong>
                </span>
              )}
            </div>
          </section>

          {/* Components */}
          <div className="section-bar">
            <span className="section-label">{t.components}</span>
            <span className="section-label">
              {enabledCount} / {MODULE_KEYS.length}
            </span>
          </div>

          <section className="glass-card modules-card">
            {MODULE_KEYS.map((key) => {
              const checked = options[key];
              const meta = t.modules[key];
              return (
                <div key={key} className="module-item">
                  <label className={`module-row ${checked ? "active" : ""}`}>
                    <div className="module-left">
                      <span className="module-icon">
                        <ModuleIcon id={key} />
                      </span>
                      <div className="module-info">
                        <span className="module-title">{meta.title}</span>
                        <span className="module-desc">{meta.desc}</span>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-checked={checked}
                      className="switch"
                      checked={checked}
                      disabled={busy}
                      onChange={(e) =>
                        setOptions((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                  </label>

                  {key === "wallpaper" && checked && (
                    <div className="workshop-strip">
                      <span className="workshop-tag">{t.wallpaperFolder}</span>
                      <span className="workshop-path" title={options.wallpaperDir}>
                        {options.wallpaperDir || t.wallpaperNotFound}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => invoke("open_custom_wallpapers").catch((e) => pushLog(String(e), "error"))}
                        disabled={busy}
                      >
                        {t.customPhotos}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handleBrowseWallpaper}
                        disabled={busy}
                      >
                        {t.folder}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {/* Progress */}
          {progress && (
            <div className={`glass-card progress-card ${progress.level}`}>
              <div className="progress-head">
                <span className="progress-text">{progress.stage}</span>
                <span className="progress-pct">{progress.percent}%</span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                />
              </div>
            </div>
          )}
        </main>

        {/* Action Bar */}
        <footer className="footer">
          <div className="footer-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleApply}
              disabled={busy || status.state === "not_found" || !status.customizationFound}
            >
              {busy
                ? t.working
                : status.state === "patched"
                ? t.update
                : t.install}
            </button>

            <button
              type="button"
              className="btn"
              onClick={handleRestore}
              disabled={busy || (!status.hasBackup && status.state !== "patched")}
              title={t.restoreTitle}
            >
              {t.restore}
            </button>

            <button
              type="button"
              className="btn"
              onClick={handleLaunch}
              disabled={busy || status.state === "not_found"}
            >
              {t.launch}
            </button>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDrawerOpen((v) => !v);
              setHasErrorLog(false);
            }}
          >
            {hasErrorLog && <span className="log-dot" />}
            {t.log}
          </button>
        </footer>
      </div>

      {/* Patcher Settings Popover */}
      {settingsOpen && (
        <div className="settings-popover" onClick={(e) => e.stopPropagation()}>
          <div className="settings-head">
            <span>{t.settingsTitle}</span>
          </div>

          <div className="settings-group">
            <span className="settings-label">{t.language}</span>
            <div className="seg-row">
              <button
                type="button"
                className={`seg-btn ${lang === "ru" ? "active" : ""}`}
                onClick={() => setLang("ru")}
              >
                Русский
              </button>
              <button
                type="button"
                className={`seg-btn ${lang === "en" ? "active" : ""}`}
                onClick={() => setLang("en")}
              >
                English
              </button>
            </div>
          </div>

          <div className="settings-group">
            <span className="settings-label">{t.scale}</span>
            <div className="seg-row">
              {[90, 100, 110].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`seg-btn ${scale === v ? "active" : ""}`}
                  onClick={() => setScale(v)}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>

          <div className="settings-group">
            <span className="settings-label">{t.backdrop}</span>
            <div className="seg-row">
              <button
                type="button"
                className={`seg-btn ${backdropMode === "wallpaper" ? "active" : ""}`}
                onClick={() => setBackdropMode("wallpaper")}
              >
                {t.backdropWallpaper}
              </button>
              <button
                type="button"
                className={`seg-btn ${backdropMode === "gradient" ? "active" : ""}`}
                onClick={() => setBackdropMode("gradient")}
              >
                {t.backdropGradient}
              </button>
              <button
                type="button"
                className={`seg-btn ${backdropMode === "solid" ? "active" : ""}`}
                onClick={() => setBackdropMode("solid")}
              >
                {t.backdropSolid}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log & Verification Drawer */}
      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <div className="drawer">
            <div className="drawer-head">
              <span className="drawer-title">{t.logTitle}</span>
              <div className="drawer-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleRunDiagnostics}
                  disabled={busy}
                >
                  {t.checkFiles}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleCopyLogs}
                >
                  {copied ? t.copied : t.copy}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setDrawerOpen(false)}
                >
                  {t.close}
                </button>
              </div>
            </div>

            {diag && (
              <div className="diag-bar">
                <span className="diag-item">
                  {t.writeAccess}{" "}
                  <b className={diag.writePermission || diag.canElevate ? "ok" : "err"}>
                    {diag.writePermission ? t.ok : diag.canElevate ? "pkexec" : t.noAccess}
                  </b>
                </span>
                <span className="diag-item">
                  {t.filesCheck}{" "}
                  <b className={diag.dryRunPassed ? "ok" : "err"}>
                    {diag.dryRunPassed ? t.ok : `${t.errorsCount} ${diag.errors.length}`}
                  </b>
                </span>
                <span className="diag-item">
                  {t.backup}: <b>{diag.backupExists ? t.yes : t.no}</b>
                </span>
              </div>
            )}

            <div className="log-list">
              {logs.map((line) => (
                <div key={line.id} className={`log-line ${line.level}`}>
                  <span className="log-time">{line.time}</span>
                  <span>{line.text}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
