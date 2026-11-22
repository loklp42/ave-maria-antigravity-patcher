//! Core patching workflow: dry-run verification, atomic backup/swap,
//! module injection, rollback, and shared Antigravity config synchronization.

use crate::asar::{self, AsarArchive, AsarEntry};
use crate::system::{self, RunningProcess};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

pub const AUTONOMOUS_MODULES: &[&str] = &[
    "wallpaperEngine.js",
    "agyExtras.js",
    "agyMediaDaemon.js",
    "agyI18n.js",
    "agyUiContrast.js",
    "agyTabManager.js",
    "agyShellViews.js",
    "agyAccounts.js",
    "agyWinUserIsolation.js",
];

pub const PATCHED_SYSTEM_FILES: &[&str] = &[
    "main.js",
    "languageServer.js",
    "paths.js",
    "utils.js",
    "customScheme.js",
    "authBootstrap.js",
    "ipcHandlers.js",
    "wcvBrowserRegistry.js",
    "wcvIpcHandlers.js",
    "storage.js",
    "lsDefaults.js",
    "windowState.js",
    "keybindings.js",
];

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModuleOptions {
    pub antigravity_path: String,
    pub wallpaper: bool,
    pub wallpaper_dir: String,
    pub media: bool,
    pub context: bool,
    pub i18n: bool,
    pub accounts: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PatcherStatus {
    pub antigravity_path: String,
    pub customization_found: bool,
    pub version: String,
    pub state: String, // "patched" | "original" | "not_found"
    pub has_backup: bool,
    pub asar_size: u64,
    pub wallpaper_path: String,
    pub wallpaper_count: usize,
    pub running_processes: Vec<RunningProcess>,
    pub installed_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsResult {
    pub write_permission: bool,
    pub dry_run_passed: bool,
    pub errors: Vec<String>,
    pub backup_exists: bool,
    pub running_processes: Vec<RunningProcess>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub stage: String,
    pub percent: u8,
    pub level: String, // "info" | "success" | "warn" | "error"
}

pub fn locate_customization_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            if let Some(ref d) = dir {
                let candidate = d.join("customization");
                if candidate.join("modules").is_dir() && candidate.join("patched_system").is_dir() {
                    return Some(candidate);
                }
                dir = d.parent().map(Path::to_path_buf);
            } else {
                break;
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd);
        for _ in 0..3 {
            if let Some(ref d) = dir {
                let candidate = d.join("customization");
                if candidate.join("modules").is_dir() && candidate.join("patched_system").is_dir() {
                    return Some(candidate);
                }
                dir = d.parent().map(Path::to_path_buf);
            }
        }
    }

    None
}

pub fn get_status(ag_dir: &str) -> PatcherStatus {
    let customization_found = locate_customization_dir().is_some();
    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");
    let manifest_path = res_dir.join("agy_patch_manifest.json");

    let has_backup = orig_path.exists();
    let asar_size = fs::metadata(&asar_path).map(|m| m.len()).unwrap_or(0);
    let running_processes = system::get_running_processes();
    let (wallpaper_path, wallpaper_count) = system::find_wallpaper_workshop();

    let installed_at = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("installed_at")
                .or_else(|| v.get("date"))
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
        });

    if ag_dir.is_empty() || !asar_path.exists() {
        return PatcherStatus {
            antigravity_path: ag_dir.to_string(),
            customization_found,
            version: "—".to_string(),
            state: "not_found".to_string(),
            has_backup,
            asar_size,
            wallpaper_path,
            wallpaper_count,
            running_processes,
            installed_at,
        };
    }

    let mut version = "—".to_string();
    let mut is_patched = false;

    if let Ok(archive) = AsarArchive::open(&asar_path) {
        if let Ok(Some(pkg_bytes)) = archive.read_file("package.json") {
            if let Ok(pkg) = serde_json::from_slice::<serde_json::Value>(&pkg_bytes) {
                if let Some(v) = pkg.get("version").and_then(|v| v.as_str()) {
                    version = v.to_string();
                }
            }
        }
        is_patched = archive.has_file("dist/wallpaperEngine.js");
    }

    let state = if is_patched {
        "patched".to_string()
    } else {
        "original".to_string()
    };

    PatcherStatus {
        antigravity_path: ag_dir.to_string(),
        customization_found,
        version,
        state,
        has_backup,
        asar_size,
        wallpaper_path,
        wallpaper_count,
        running_processes,
        installed_at,
    }
}

pub fn dry_run(ag_dir: &str) -> DiagnosticsResult {
    let mut errors = Vec::new();
    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");

    let write_permission = if res_dir.is_dir() {
        system::check_write_permission(&res_dir)
    } else {
        errors.push(format!("Каталог resources не найден: {}", res_dir.display()));
        false
    };

    if let Some(cust_dir) = locate_customization_dir() {
        let mod_dir = cust_dir.join("modules");
        for m in AUTONOMOUS_MODULES {
            if !mod_dir.join(m).exists() {
                errors.push(format!("Отсутствует модуль: customization/modules/{m}"));
            }
        }
        let sys_dir = cust_dir.join("patched_system");
        for s in PATCHED_SYSTEM_FILES {
            if !sys_dir.join(s).exists() {
                errors.push(format!(
                    "Отсутствует системный файл: customization/patched_system/{s}"
                ));
            }
        }
    } else {
        errors.push("Каталог customization/ не найден рядом с патчером.".to_string());
    }

    let source_asar = if orig_path.exists() {
        &orig_path
    } else {
        &asar_path
    };

    if !source_asar.exists() {
        errors.push(format!("Файл ASAR не найден: {}", source_asar.display()));
    } else {
        match AsarArchive::open(source_asar) {
            Ok(archive) => {
                for s in PATCHED_SYSTEM_FILES {
                    let key = format!("dist/{s}");
                    if !archive.has_file(&key) {
                        errors.push(format!("В целевом ASAR отсутствует {key}"));
                    }
                }
            }
            Err(e) => errors.push(format!("Не удалось прочитать ASAR: {e}")),
        }
    }

    DiagnosticsResult {
        write_permission,
        dry_run_passed: errors.is_empty(),
        errors,
        backup_exists: orig_path.exists(),
        running_processes: system::get_running_processes(),
    }
}

pub fn apply_patch<F>(opts: &ModuleOptions, emit: F) -> Result<(), String>
where
    F: Fn(&str, u8, &str),
{
    let ag_dir = opts.antigravity_path.trim();
    if ag_dir.is_empty() {
        return Err("Не указан каталог Antigravity.".to_string());
    }

    emit("Проверка совместимости (Dry-Run)...", 10, "info");
    let diag = dry_run(ag_dir);
    if !diag.dry_run_passed {
        return Err(diag.errors.join("\n"));
    }
    if !diag.write_permission {
        return Err("Нет прав на запись в каталог resources/. Запустите от имени администратора.".to_string());
    }

    let cust_dir = locate_customization_dir()
        .ok_or_else(|| "Каталог customization/ не найден.".to_string())?;
    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");
    let new_path = res_dir.join("app.asar.new");
    let swap_bak = res_dir.join("app.asar.swap_bak");
    let manifest_path = res_dir.join("agy_patch_manifest.json");

    emit("Остановка процессов Antigravity...", 20, "info");
    if !system::terminate_antigravity_processes() {
        return Err("Не удалось завершить процессы Antigravity. Закройте их вручную.".to_string());
    }
    if !system::wait_for_file_unlock(&asar_path, 5) {
        return Err("Файл app.asar заблокирован другим процессом.".to_string());
    }

    if !orig_path.exists() {
        emit("Создание резервной копии app.asar.orig...", 32, "info");
        fs::copy(&asar_path, &orig_path)
            .map_err(|e| format!("Ошибка создания резервной копии: {e}"))?;
    }

    emit("Чтение оригинального архива app.asar.orig...", 48, "info");
    let archive = AsarArchive::open(&orig_path)?;
    let mut entries = archive.read_all_entries()?;

    emit("Инъекция модулей и патчей...", 64, "info");
    let mod_dir = cust_dir.join("modules");
    for m in AUTONOMOUS_MODULES {
        let mut data = fs::read(mod_dir.join(m))
            .map_err(|e| format!("Ошибка чтения модуля {m}: {e}"))?;

        if *m == "wallpaperEngine.js" && !opts.wallpaper_dir.trim().is_empty() {
            if let Ok(text) = String::from_utf8(data.clone()) {
                let escaped = serde_json::to_string(opts.wallpaper_dir.trim())
                    .unwrap_or_else(|_| "\"\"".to_string());
                if let Some(updated) = replace_default_wallpaper_dir(&text, &escaped) {
                    data = updated.into_bytes();
                }
            }
        }

        entries.insert(
            format!("dist/{m}"),
            AsarEntry::Packed {
                data,
                executable: false,
            },
        );
    }

    let sys_dir = cust_dir.join("patched_system");
    for s in PATCHED_SYSTEM_FILES {
        let data = fs::read(sys_dir.join(s))
            .map_err(|e| format!("Ошибка чтения системного файла {s}: {e}"))?;
        entries.insert(
            format!("dist/{s}"),
            AsarEntry::Packed {
                data,
                executable: false,
            },
        );
    }

    emit("Упаковка нового архива app.asar (SHA-256)...", 82, "info");
    asar::write_asar(&new_path, &entries)?;

    emit("Атомарная замена app.asar...", 93, "info");
    if swap_bak.exists() {
        let _ = fs::remove_file(&swap_bak);
    }
    fs::rename(&asar_path, &swap_bak)
        .map_err(|e| format!("Ошибка подготовки замены app.asar: {e}"))?;

    if let Err(e) = fs::rename(&new_path, &asar_path) {
        let _ = fs::rename(&swap_bak, &asar_path);
        return Err(format!("Ошибка замены app.asar (выполнен откат): {e}"));
    }
    let _ = fs::remove_file(&swap_bak);

    let orig_sha = asar::sha256_file(&orig_path).unwrap_or_default();
    let target_sha = asar::sha256_file(&asar_path).unwrap_or_default();
    let manifest = json!({
        "patcher": "Ave Maria Antigravity Patcher",
        "version": "2.34.0",
        "installed_at": Utc::now().to_rfc3339(),
        "antigravity_dir": ag_dir,
        "wallpaper_dir": opts.wallpaper_dir,
        "modules": {
            "wallpaper": opts.wallpaper,
            "media": opts.media,
            "context": opts.context,
            "i18n": opts.i18n,
            "accounts": opts.accounts
        },
        "orig_sha256": orig_sha,
        "target_sha256": target_sha
    });
    let _ = fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    );

    // Sync custom_wallpapers/ folder and user component toggles directly into Antigravity's shared configs
    sync_user_configs(&cust_dir, opts);

    emit("Патч успешно установлен.", 100, "success");
    Ok(())
}

fn merge_json_file(path: &Path, updates: &[(&str, serde_json::Value)]) {
    let mut obj = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok())
        .unwrap_or_default();
    for (k, v) in updates {
        obj.insert((*k).to_string(), v.clone());
    }
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&serde_json::Value::Object(obj)).unwrap_or_default(),
    );
}

fn sync_user_configs(cust_dir: &Path, opts: &ModuleOptions) {
    let custom_dir = cust_dir
        .parent()
        .unwrap_or(cust_dir)
        .join("custom_wallpapers");
    let _ = fs::create_dir_all(&custom_dir);

    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let shared_dir = PathBuf::from(appdata).join("Antigravity").join("Shared");
    let _ = fs::create_dir_all(&shared_dir);

    // 1. wallpaper_config.json (custom photos/videos + Steam Workshop dir)
    let mut wp_updates = vec![(
        "customWallpaperDir",
        serde_json::Value::String(custom_dir.to_string_lossy().to_string()),
    )];
    if !opts.wallpaper_dir.trim().is_empty() {
        wp_updates.push((
            "wallpaperDir",
            serde_json::Value::String(opts.wallpaper_dir.trim().to_string()),
        ));
    }
    merge_json_file(&shared_dir.join("wallpaper_config.json"), &wp_updates);

    // 2. agy_extras_settings.json (player, context indicator, language)
    let lang_val = serde_json::Value::String(if opts.i18n { "ru" } else { "en" }.to_string());
    merge_json_file(
        &shared_dir.join("agy_extras_settings.json"),
        &[
            ("showPlayer", serde_json::Value::Bool(opts.media)),
            ("showContextRing", serde_json::Value::Bool(opts.context)),
            ("lang", lang_val.clone()),
        ],
    );

    // 3. agy_appearance.json (language + multi-account top tab bar)
    merge_json_file(
        &shared_dir.join("agy_appearance.json"),
        &[
            ("lang", lang_val),
            ("showTopTabBar", serde_json::Value::Bool(opts.accounts)),
        ],
    );
}

fn replace_default_wallpaper_dir(src: &str, json_quoted_path: &str) -> Option<String> {
    let needle = "const DEFAULT_WALLPAPER_DIR = ";
    let start = src.find(needle)?;
    let after = &src[start + needle.len()..];
    let semi = after.find(';')?;
    let mut out = String::with_capacity(src.len() + json_quoted_path.len());
    out.push_str(&src[..start + needle.len()]);
    out.push_str(json_quoted_path);
    out.push_str(&after[semi..]);
    Some(out)
}

pub fn restore_original<F>(ag_dir: &str, emit: F) -> Result<(), String>
where
    F: Fn(&str, u8, &str),
{
    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");
    let new_path = res_dir.join("app.asar.new");
    let swap_bak = res_dir.join("app.asar.swap_bak");
    let manifest_path = res_dir.join("agy_patch_manifest.json");

    if !asar_path.exists() && !orig_path.exists() {
        return Err("Файл app.asar не найден.".to_string());
    }

    emit("Остановка процессов Antigravity...", 20, "info");
    if !system::terminate_antigravity_processes() {
        return Err("Не удалось завершить процессы Antigravity.".to_string());
    }
    if asar_path.exists() && !system::wait_for_file_unlock(&asar_path, 5) {
        return Err("Файл app.asar заблокирован другим процессом.".to_string());
    }

    // Verify whether app.asar.orig is genuinely unpatched (stock).
    let orig_is_clean = orig_path.exists()
        && AsarArchive::open(&orig_path)
            .map(|a| !a.has_file("dist/wallpaperEngine.js"))
            .unwrap_or(false);

    if orig_is_clean {
        emit("Восстановление оригинального app.asar из бэкапа...", 70, "info");
        fs::copy(&orig_path, &asar_path)
            .map_err(|e| format!("Ошибка восстановления оригинала: {e}"))?;
    } else {
        // Backup is missing or was captured from an already-patched app.asar:
        // strip all autonomous modules and restore all 13 stock system files from customization/original_system/.
        let cust_dir = locate_customization_dir()
            .ok_or_else(|| "Каталог customization/ не найден для полного отката.".to_string())?;
        let orig_sys_dir = cust_dir.join("original_system");
        if !orig_sys_dir.is_dir() {
            return Err("Каталог customization/original_system/ не найден.".to_string());
        }

        emit("Очистка патча и восстановление стандартных файлов...", 45, "info");
        let source = if asar_path.exists() { &asar_path } else { &orig_path };
        let archive = AsarArchive::open(source)?;
        let mut entries = archive.read_all_entries()?;

        for m in AUTONOMOUS_MODULES {
            entries.remove(&format!("dist/{m}"));
        }
        for s in PATCHED_SYSTEM_FILES {
            let src_file = orig_sys_dir.join(s);
            if !src_file.exists() {
                return Err(format!("Отсутствует оригинальный файл: original_system/{s}"));
            }
            let data = fs::read(&src_file)
                .map_err(|e| format!("Ошибка чтения original_system/{s}: {e}"))?;
            entries.insert(
                format!("dist/{s}"),
                AsarEntry::Packed {
                    data,
                    executable: false,
                },
            );
        }

        emit("Сборка чистого оригинального app.asar...", 75, "info");
        asar::write_asar(&new_path, &entries)?;

        emit("Замена app.asar...", 90, "info");
        if swap_bak.exists() {
            let _ = fs::remove_file(&swap_bak);
        }
        if asar_path.exists() {
            fs::rename(&asar_path, &swap_bak)
                .map_err(|e| format!("Ошибка подготовки замены app.asar: {e}"))?;
        }
        if let Err(e) = fs::rename(&new_path, &asar_path) {
            if swap_bak.exists() {
                let _ = fs::rename(&swap_bak, &asar_path);
            }
            return Err(format!("Ошибка замены app.asar: {e}"));
        }
        let _ = fs::remove_file(&swap_bak);
        // Save the freshly reconstructed clean stock archive as app.asar.orig for future use.
        let _ = fs::copy(&asar_path, &orig_path);
    }

    if manifest_path.exists() {
        let _ = fs::remove_file(&manifest_path);
    }

    emit("Оригинальный Antigravity полностью восстановлен.", 100, "success");
    Ok(())
}
