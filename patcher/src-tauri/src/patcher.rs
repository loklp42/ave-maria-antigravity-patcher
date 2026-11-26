//! Core patching workflow: dry-run verification, atomic backup/swap,
//! module injection, rollback, and shared Antigravity config synchronization.

use crate::asar::{self, AsarArchive, AsarEntry};
use crate::system::{self, RunningProcess};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    pub can_elevate: bool,
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

    #[cfg(target_os = "linux")]
    {
        let mut linux_fallbacks = vec![
            PathBuf::from("/usr/share/ave-maria-patcher/customization"),
            PathBuf::from("/usr/local/share/ave-maria-patcher/customization"),
        ];
        if let Ok(xdg_data) = std::env::var("XDG_DATA_HOME") {
            if !xdg_data.trim().is_empty() {
                linux_fallbacks.push(PathBuf::from(xdg_data).join("ave-maria-patcher/customization"));
            }
        } else if let Some(home) = system::unix_user_home() {
            linux_fallbacks.push(home.join(".local/share/ave-maria-patcher/customization"));
        }
        for candidate in linux_fallbacks {
            if candidate.join("modules").is_dir() && candidate.join("patched_system").is_dir() {
                return Some(candidate);
            }
        }
    }

    None
}

pub fn get_status(ag_dir: &str) -> PatcherStatus {
    let ag_dir = ag_dir.trim();
    let customization_found = locate_customization_dir().is_some();
    let running_processes = system::get_running_processes();
    let (wallpaper_path, wallpaper_count) = system::find_wallpaper_workshop();

    if ag_dir.is_empty() {
        return PatcherStatus {
            antigravity_path: String::new(),
            customization_found,
            version: "—".to_string(),
            state: "not_found".to_string(),
            has_backup: false,
            asar_size: 0,
            wallpaper_path,
            wallpaper_count,
            running_processes,
            installed_at: None,
        };
    }

    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");
    let manifest_path = res_dir.join("agy_patch_manifest.json");

    let has_backup = orig_path.exists();
    let asar_size = fs::metadata(&asar_path).map(|m| m.len()).unwrap_or(0);

    let installed_at = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("installed_at")
                .or_else(|| v.get("date"))
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
        });

    if !asar_path.exists() {
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
    let mut is_corrupted = false;

    match AsarArchive::open(&asar_path) {
        Ok(archive) => {
            if archive.verify_structural_bounds().is_err() {
                is_corrupted = true;
            } else {
                if let Ok(Some(pkg_bytes)) = archive.read_file("package.json") {
                    if let Ok(pkg) = serde_json::from_slice::<serde_json::Value>(&pkg_bytes) {
                        if let Some(v) = pkg.get("version").and_then(|v| v.as_str()) {
                            version = v.to_string();
                        }
                    }
                }
                is_patched = archive.has_file("dist/wallpaperEngine.js");
            }
        }
        Err(_) => {
            is_corrupted = true;
        }
    }

    let state = if is_corrupted {
        "corrupted".to_string()
    } else if is_patched {
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
    let ag_dir = ag_dir.trim();
    let mut errors = Vec::new();

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

    if ag_dir.is_empty() {
        errors.push("Не указан каталог Antigravity.".to_string());
        return DiagnosticsResult {
            write_permission: false,
            can_elevate: false,
            dry_run_passed: false,
            errors,
            backup_exists: false,
            running_processes: system::get_running_processes(),
        };
    }

    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");

    let write_permission = if res_dir.is_dir() {
        system::check_write_permission(&res_dir)
    } else {
        errors.push(format!("Каталог resources не найден: {}", res_dir.display()));
        false
    };

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
                if let Err(e) = archive.verify_structural_bounds() {
                    errors.push(format!("Повреждена структура ASAR: {e}"));
                } else {
                    for s in PATCHED_SYSTEM_FILES {
                        let key = format!("dist/{s}");
                        if !archive.has_file(&key) {
                            errors.push(format!("В целевом ASAR отсутствует {key}"));
                        }
                    }
                }
            }
            Err(e) => errors.push(format!("Не удалось прочитать ASAR: {e}")),
        }
    }

    DiagnosticsResult {
        write_permission,
        can_elevate: !write_permission && system::can_elevate(),
        dry_run_passed: errors.is_empty(),
        errors,
        backup_exists: orig_path.exists(),
        running_processes: system::get_running_processes(),
    }
}

#[cfg(unix)]
fn set_readable_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));
}

struct PatchLockGuard {
    path: PathBuf,
    owner_pid: u32,
}

impl Drop for PatchLockGuard {
    fn drop(&mut self) {
        if let Ok(meta) = fs::symlink_metadata(&self.path) {
            if !meta.file_type().is_symlink() && meta.file_type().is_file() {
                if let Some(file_pid) = read_lock_pid(&self.path, &meta) {
                    if file_pid != self.owner_pid {
                        return;
                    }
                }
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

struct ReapLockGuard(PathBuf);

impl Drop for ReapLockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn normalize_lock_dir(res_dir: &Path) -> String {
    let resolved = fs::canonicalize(res_dir).unwrap_or_else(|_| {
        if res_dir.is_absolute() {
            res_dir.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(res_dir))
                .unwrap_or_else(|_| res_dir.to_path_buf())
        }
    });
    let mut s = resolved.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            s = format!(r"\\{rest}");
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            s = rest.to_string();
        }
        s = s.replace('/', "\\");
        while s.len() > 3 && s.ends_with('\\') {
            s.pop();
        }
        s = s.to_lowercase();
    }
    #[cfg(not(windows))]
    {
        while s.len() > 1 && s.ends_with('/') {
            s.pop();
        }
    }
    s
}

fn unified_lock_dir() -> PathBuf {
    #[cfg(unix)]
    {
        let tmp = Path::new("/tmp");
        if tmp.is_dir() {
            return tmp.to_path_buf();
        }
    }
    std::env::temp_dir()
}

fn open_lock_readonly_nofollow(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "x86")))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0o400000); // O_NOFOLLOW
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0o100000); // O_NOFOLLOW
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(0x0100); // O_NOFOLLOW
    }
    opts.open(path)
}

fn read_lock_pid(path: &Path, expected_lstat: &fs::Metadata) -> Option<u32> {
    let mut file = open_lock_readonly_nofollow(path).ok()?;
    let fd_meta = file.metadata().ok()?;
    if !fd_meta.file_type().is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if fd_meta.dev() != expected_lstat.dev() || fd_meta.ino() != expected_lstat.ino() {
            return None;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = expected_lstat;
    }
    let mut buf = [0u8; 256];
    let n = file.read(&mut buf).ok()?;
    let text = std::str::from_utf8(&buf[..n]).ok()?;
    for line in text.lines() {
        if let Some(pid_str) = line.trim().strip_prefix("pid=") {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

fn create_exclusive_lock_file(lock_path: &Path) -> Result<PatchLockGuard, std::io::Error> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(lock_path)?;
    let pid = std::process::id();
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "pid={pid}\ncreated={now_secs}");
    Ok(PatchLockGuard {
        path: lock_path.to_path_buf(),
        owner_pid: pid,
    })
}

fn lock_busy_error() -> String {
    "Другой экземпляр патчера уже выполняет операцию с этим каталогом Antigravity. Дождитесь его завершения."
        .to_string()
}

fn acquire_patch_lock(res_dir: &Path, _writable_res_dir: bool) -> Result<PatchLockGuard, String> {
    let normalized = normalize_lock_dir(res_dir);
    let digest = hex::encode(Sha256::digest(normalized.as_bytes()));
    let lock_path = unified_lock_dir().join(format!("agy_patcher_{}.lock", &digest[..12]));

    match create_exclusive_lock_file(&lock_path) {
        Ok(guard) => return Ok(guard),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("Не удалось создать lockfile патчера: {e}")),
    }

    let reap_path = PathBuf::from(format!("{}.reap", lock_path.display()));
    let mut reap_opts = OpenOptions::new();
    reap_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        reap_opts.mode(0o600);
    }
    let _reap_guard = match reap_opts.open(&reap_path) {
        Ok(f) => {
            drop(f);
            ReapLockGuard(reap_path)
        }
        Err(_) => {
            // Another reaper is active right now; wait briefly and try fast-path once.
            std::thread::sleep(Duration::from_millis(60));
            return create_exclusive_lock_file(&lock_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    lock_busy_error()
                } else {
                    format!("Не удалось создать lockfile патчера: {e}")
                }
            });
        }
    };

    match fs::symlink_metadata(&lock_path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                return Err("Обнаружен небезопасный symlink по пути lock-файла патчера.".to_string());
            }
            let is_old = meta
                .modified()
                .ok()
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .map(|age| age > Duration::from_secs(15 * 60))
                .unwrap_or(false);
            let pid_alive = read_lock_pid(&lock_path, &meta)
                .map(system::is_pid_alive)
                .unwrap_or(false);

            if is_old && !pid_alive {
                let _ = fs::remove_file(&lock_path);
            } else {
                return Err(lock_busy_error());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Ошибка проверки lockfile патчера: {e}")),
    }

    drop(_reap_guard);
    create_exclusive_lock_file(&lock_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            lock_busy_error()
        } else {
            format!("Не удалось создать lockfile патчера: {e}")
        }
    })
}

#[cfg(target_os = "linux")]
struct StagingDirGuard(PathBuf);

#[cfg(target_os = "linux")]
impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(target_os = "linux")]
fn create_private_staging_dir(prefix: &str) -> Result<StagingDirGuard, String> {
    use std::os::unix::fs::DirBuilderExt;
    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("{prefix}_{}_{nanos}", std::process::id()));
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder
        .create(&dir)
        .map_err(|e| format!("Не удалось создать защищённый staging-каталог: {e}"))?;
    Ok(StagingDirGuard(dir))
}

#[derive(Debug, PartialEq, Eq)]
enum BackupAction {
    /// Live app.asar is stock and differs from (or lacks) app.asar.orig -> refresh backup from live app.asar
    RefreshOrigFromLive,
    /// Existing app.asar.orig is valid stock and matches current stock (or live is already patched) -> use orig
    UseExistingOrig,
    /// Live app.asar is already patched and app.asar.orig is missing or corrupt -> abort to prevent poisoning
    RefusePoisoned,
}

fn has_any_autonomous_module(archive: &AsarArchive) -> bool {
    AUTONOMOUS_MODULES
        .iter()
        .any(|m| archive.has_file(&format!("dist/{m}")))
}

fn evaluate_backup_state(asar_path: &Path, orig_path: &Path) -> BackupAction {
    let live_is_stock = AsarArchive::open(asar_path)
        .and_then(|a| {
            a.verify_structural_bounds()
                .map(|_| !has_any_autonomous_module(&a))
        })
        .unwrap_or(false);
    let orig_is_valid_stock = orig_path.exists()
        && AsarArchive::open(orig_path)
            .and_then(|a| {
                a.verify_structural_bounds()
                    .map(|_| !has_any_autonomous_module(&a))
            })
            .unwrap_or(false);

    if live_is_stock {
        let differs = !orig_is_valid_stock
            || asar::sha256_file(asar_path).ok() != asar::sha256_file(orig_path).ok();
        if differs {
            BackupAction::RefreshOrigFromLive
        } else {
            BackupAction::UseExistingOrig
        }
    } else if orig_is_valid_stock {
        BackupAction::UseExistingOrig
    } else {
        BackupAction::RefusePoisoned
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
    let needs_elevation = !diag.write_permission;
    if needs_elevation && !diag.can_elevate {
        #[cfg(target_os = "linux")]
        return Err("Нет прав на запись в каталог resources/. Установите polkit (pkexec) или запустите патчер с правами суперпользователя.".to_string());
        #[cfg(not(target_os = "linux"))]
        return Err("Нет прав на запись в каталог resources/. Запустите от имени администратора.".to_string());
    }

    let cust_dir = locate_customization_dir()
        .ok_or_else(|| "Каталог customization/ не найден.".to_string())?;
    let res_dir = Path::new(ag_dir).join("resources");
    let _lock_guard = acquire_patch_lock(&res_dir, !needs_elevation)?;

    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");
    let new_path = res_dir.join("app.asar.new");
    let manifest_path = res_dir.join("agy_patch_manifest.json");

    emit("Остановка процессов Antigravity...", 20, "info");
    if !system::terminate_antigravity_processes() {
        return Err("Не удалось завершить процессы Antigravity. Закройте их вручную.".to_string());
    }
    if !system::wait_for_file_unlock(&asar_path, 5) {
        return Err("Файл app.asar заблокирован другим процессом.".to_string());
    }

    let backup_action = evaluate_backup_state(&asar_path, &orig_path);
    let mut refresh_orig_elevated = false;
    let source_asar: &Path = match backup_action {
        BackupAction::RefreshOrigFromLive => {
            if !needs_elevation {
                emit(
                    if orig_path.exists() {
                        "Обнаружено обновление Antigravity — обновление резервной копии app.asar.orig..."
                    } else {
                        "Создание атомарной резервной копии app.asar.orig..."
                    },
                    32,
                    "info",
                );
                asar::atomic_copy_file(&asar_path, &orig_path)?;
                #[cfg(unix)]
                set_readable_mode(&orig_path);
                &orig_path
            } else {
                refresh_orig_elevated = true;
                &asar_path
            }
        }
        BackupAction::UseExistingOrig => &orig_path,
        BackupAction::RefusePoisoned => {
            return Err(
                "Исходный app.asar уже пропатчен, а чистый бэкап app.asar.orig отсутствует или повреждён. Выполните «Восстановить» перед повторной установкой."
                    .to_string(),
            );
        }
    };

    emit("Чтение оригинального архива...", 48, "info");
    let archive = AsarArchive::open(source_asar)?;
    archive.verify_structural_bounds()?;
    let unpacked_dirs = archive.read_unpacked_dirs();
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

    let orig_sha = asar::sha256_file(source_asar)?;

    if needs_elevation {
        #[cfg(target_os = "linux")]
        {
            let stage_dir = create_private_staging_dir("agy_patch_stage")?;
            let staged_asar = stage_dir.0.join("app.asar");
            let staged_manifest = stage_dir.0.join("agy_patch_manifest.json");

            emit("Упаковка нового архива app.asar (SHA-256)...", 80, "info");
            asar::write_asar_with_unpacked_dirs(&staged_asar, &entries, &unpacked_dirs)?;

            let target_sha = asar::sha256_file(&staged_asar)?;
            let manifest = build_manifest_json(ag_dir, opts, &orig_sha, &target_sha);
            let manifest_bytes = serde_json::to_vec_pretty(&manifest)
                .map_err(|e| format!("Ошибка сериализации манифеста: {e}"))?;
            asar::atomic_write_bytes(&staged_manifest, &manifest_bytes)?;

            emit("Запрос прав администратора (pkexec) для замены app.asar...", 92, "info");
            system::elevated_install_asar(
                &res_dir,
                &staged_asar,
                &staged_manifest,
                &target_sha,
                refresh_orig_elevated,
            )?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = refresh_orig_elevated;
            return Err("Нет прав на запись в каталог resources/.".to_string());
        }
    } else {
        emit("Упаковка нового архива app.asar (SHA-256)...", 82, "info");
        asar::write_asar_with_unpacked_dirs(&new_path, &entries, &unpacked_dirs)?;

        emit("Атомарная замена app.asar...", 93, "info");
        if let Err(e) = asar::atomic_replace_with_retry(&new_path, &asar_path) {
            let _ = fs::remove_file(&new_path);
            return Err(e);
        }
        #[cfg(unix)]
        set_readable_mode(&asar_path);

        let target_sha = asar::sha256_file(&asar_path)?;
        let manifest = build_manifest_json(ag_dir, opts, &orig_sha, &target_sha);
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("Ошибка сериализации манифеста: {e}"))?;
        asar::atomic_write_bytes(&manifest_path, &manifest_bytes)?;
        #[cfg(unix)]
        set_readable_mode(&manifest_path);
    }

    // Sync custom_wallpapers/ folder and user component toggles directly into Antigravity's shared configs
    sync_user_configs(&cust_dir, opts)?;

    emit("Патч успешно установлен.", 100, "success");
    Ok(())
}

fn build_manifest_json(
    ag_dir: &str,
    opts: &ModuleOptions,
    orig_sha: &str,
    target_sha: &str,
) -> serde_json::Value {
    json!({
        "patcher": "Ave Maria Antigravity Patcher",
        "version": env!("CARGO_PKG_VERSION"),
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
    })
}

fn merge_json_file_with_defaults(
    path: &Path,
    updates: &[(&str, serde_json::Value)],
    defaults_if_missing: &[(&str, serde_json::Value)],
) -> Result<(), String> {
    let mut obj = if path.exists() {
        match fs::read_to_string(path).ok().and_then(|s| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok()
        }) {
            Some(map) => map,
            None => {
                let corrupt_path = path.with_extension("json.corrupt");
                if fs::copy(path, &corrupt_path).is_ok() {
                    system::chown_if_sudo(&corrupt_path);
                }
                return Ok(()); // Never silently clobber unreadable user config
            }
        }
    } else {
        serde_json::Map::new()
    };
    for (k, v) in defaults_if_missing {
        if !obj.contains_key(*k) {
            obj.insert((*k).to_string(), v.clone());
        }
    }
    for (k, v) in updates {
        obj.insert((*k).to_string(), v.clone());
    }
    let bytes = serde_json::to_vec_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| format!("Ошибка сериализации {}: {e}", path.display()))?;
    asar::atomic_write_bytes(path, &bytes)?;
    system::chown_if_sudo(path);
    Ok(())
}

#[allow(dead_code)]
fn merge_json_file(path: &Path, updates: &[(&str, serde_json::Value)]) {
    let _ = merge_json_file_with_defaults(path, updates, &[]);
}

pub fn resolve_custom_wallpapers_dir(cust_dir: &Path) -> PathBuf {
    let preferred = cust_dir
        .parent()
        .unwrap_or(cust_dir)
        .join("custom_wallpapers");
    if system::create_dir_all_for_sudo(&preferred).is_ok()
        && system::check_write_permission(&preferred)
    {
        return preferred;
    }
    if let Some(cfg_dir) = system::get_antigravity_config_dir() {
        let fallback = cfg_dir.join("custom_wallpapers");
        if system::create_dir_all_for_sudo(&fallback).is_ok() {
            return fallback;
        }
    }
    preferred
}

fn sync_user_configs_to_dir(config_dir: &Path, custom_dir: &Path, opts: &ModuleOptions) -> Result<(), String> {
    system::create_dir_all_for_sudo(config_dir)
        .map_err(|e| format!("Не удалось создать каталог настроек {}: {e}", config_dir.display()))?;

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
    merge_json_file_with_defaults(&config_dir.join("wallpaper_config.json"), &wp_updates, &[])?;

    // 2. agy_extras_settings.json (player, context indicator, language — preserve user overrides when feature is enabled)
    let mut extras_updates = Vec::new();
    let mut extras_defaults = Vec::new();
    if !opts.media {
        extras_updates.push(("showPlayer", serde_json::Value::Bool(false)));
    } else {
        extras_defaults.push(("showPlayer", serde_json::Value::Bool(true)));
    }
    if !opts.context {
        extras_updates.push(("showContextRing", serde_json::Value::Bool(false)));
    } else {
        extras_defaults.push(("showContextRing", serde_json::Value::Bool(true)));
    }
    if !opts.i18n {
        extras_updates.push(("lang", serde_json::Value::String("en".to_string())));
    } else {
        extras_defaults.push(("lang", serde_json::Value::String("ru".to_string())));
    }
    merge_json_file_with_defaults(
        &config_dir.join("agy_extras_settings.json"),
        &extras_updates,
        &extras_defaults,
    )?;

    // 3. agy_appearance.json (language + top tab bar + paused — preserve existing user toggles when enabled)
    let mut appearance_updates = Vec::new();
    let mut appearance_defaults = Vec::new();
    if !opts.i18n {
        appearance_updates.push(("lang", serde_json::Value::String("en".to_string())));
    } else {
        appearance_defaults.push(("lang", serde_json::Value::String("ru".to_string())));
    }
    if !opts.accounts {
        appearance_updates.push(("showTopTabBar", serde_json::Value::Bool(false)));
    } else {
        appearance_defaults.push(("showTopTabBar", serde_json::Value::Bool(true)));
    }
    if !opts.wallpaper {
        appearance_updates.push(("paused", serde_json::Value::Bool(true)));
    } else {
        appearance_defaults.push(("paused", serde_json::Value::Bool(false)));
    }
    merge_json_file_with_defaults(
        &config_dir.join("agy_appearance.json"),
        &appearance_updates,
        &appearance_defaults,
    )?;

    Ok(())
}

fn sync_user_configs(cust_dir: &Path, opts: &ModuleOptions) -> Result<(), String> {
    let custom_dir = resolve_custom_wallpapers_dir(cust_dir);

    let Some(config_dir) = system::get_antigravity_config_dir() else {
        return Ok(());
    };
    sync_user_configs_to_dir(&config_dir, &custom_dir, opts)
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
    let ag_dir = ag_dir.trim();
    if ag_dir.is_empty() {
        return Err("Не указан каталог Antigravity.".to_string());
    }
    let res_dir = Path::new(ag_dir).join("resources");
    let asar_path = res_dir.join("app.asar");
    let orig_path = res_dir.join("app.asar.orig");
    let new_path = res_dir.join("app.asar.new");
    let manifest_path = res_dir.join("agy_patch_manifest.json");

    if !asar_path.exists() && !orig_path.exists() {
        return Err("Файл app.asar не найден.".to_string());
    }

    let needs_elevation = !system::check_write_permission(&res_dir);
    if needs_elevation && !system::can_elevate() {
        #[cfg(target_os = "linux")]
        return Err("Нет прав на запись в каталог resources/. Установите polkit (pkexec) или запустите патчер с правами суперпользователя.".to_string());
        #[cfg(not(target_os = "linux"))]
        return Err("Нет прав на запись в каталог resources/. Запустите от имени администратора.".to_string());
    }

    let _lock_guard = acquire_patch_lock(&res_dir, !needs_elevation)?;

    emit("Остановка процессов Antigravity...", 20, "info");
    if !system::terminate_antigravity_processes() {
        return Err("Не удалось завершить процессы Antigravity.".to_string());
    }
    if asar_path.exists() && !system::wait_for_file_unlock(&asar_path, 5) {
        return Err("Файл app.asar заблокирован другим процессом.".to_string());
    }

    let live_is_stock = asar_path.exists()
        && AsarArchive::open(&asar_path)
            .and_then(|a| {
                a.verify_structural_bounds()
                    .map(|_| !has_any_autonomous_module(&a))
            })
            .unwrap_or(false);

    let orig_sha_actual = if orig_path.exists() {
        asar::sha256_file(&orig_path).ok()
    } else {
        None
    };

    if live_is_stock {
        let live_sha = asar::sha256_file(&asar_path)?;
        let orig_matches_live = orig_sha_actual.as_deref() == Some(live_sha.as_str());
        if !orig_matches_live || manifest_path.exists() {
            if needs_elevation {
                #[cfg(target_os = "linux")]
                {
                    emit("Обновление актуального бэкапа app.asar.orig (pkexec)...", 75, "info");
                    system::elevated_restore_asar(&res_dir, None, Some(&live_sha), true)?;
                }
                #[cfg(not(target_os = "linux"))]
                {
                    return Err("Нет прав на запись в каталог resources/.".to_string());
                }
            } else {
                if !orig_matches_live {
                    emit("Обнаружен актуальный оригинальный app.asar — обновление app.asar.orig...", 75, "info");
                    asar::atomic_copy_file(&asar_path, &orig_path)?;
                    #[cfg(unix)]
                    set_readable_mode(&orig_path);
                }
                if manifest_path.exists() {
                    let _ = fs::remove_file(&manifest_path);
                }
            }
        }
        emit("Установлен актуальный оригинальный Antigravity.", 100, "success");
        return Ok(());
    }

    let manifest_orig_sha = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("orig_sha256")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });

    // Verify whether app.asar.orig is genuinely unpatched, structurally intact, and matches manifest SHA-256.
    let orig_is_clean = orig_path.exists()
        && AsarArchive::open(&orig_path)
            .and_then(|a| {
                a.verify_structural_bounds()
                    .map(|_| !has_any_autonomous_module(&a))
            })
            .unwrap_or(false)
        && manifest_orig_sha
            .as_deref()
            .map(|expected| expected.is_empty() || orig_sha_actual.as_deref() == Some(expected))
            .unwrap_or(true);

    if orig_is_clean {
        if needs_elevation {
            #[cfg(target_os = "linux")]
            {
                emit("Запрос прав администратора (pkexec) для восстановления app.asar...", 75, "info");
                system::elevated_restore_asar(&res_dir, None, orig_sha_actual.as_deref(), false)?;
            }
            #[cfg(not(target_os = "linux"))]
            {
                return Err("Нет прав на запись в каталог resources/.".to_string());
            }
        } else {
            emit("Атомарное восстановление оригинального app.asar из бэкапа...", 70, "info");
            asar::atomic_copy_file(&orig_path, &asar_path)?;
            #[cfg(unix)]
            set_readable_mode(&asar_path);
        }
    } else {
        // Backup is missing, truncated, SHA-mismatched, or captured from an already-patched app.asar:
        // strip all autonomous modules and restore all 13 stock system files from customization/original_system/.
        let cust_dir = locate_customization_dir()
            .ok_or_else(|| "Каталог customization/ не найден для полного отката.".to_string())?;
        let orig_sys_dir = cust_dir.join("original_system");
        if !orig_sys_dir.is_dir() {
            return Err("Каталог customization/original_system/ не найден.".to_string());
        }

        emit("Очистка патча и восстановление стандартных файлов...", 45, "info");
        let open_valid = |p: &Path| -> Result<AsarArchive, String> {
            let a = AsarArchive::open(p)?;
            a.verify_structural_bounds()?;
            Ok(a)
        };
        let archive = if asar_path.exists() {
            match open_valid(&asar_path) {
                Ok(a) => a,
                Err(live_err) => {
                    if orig_path.exists() {
                        open_valid(&orig_path).map_err(|orig_err| {
                            format!("Повреждены и app.asar ({live_err}), и app.asar.orig ({orig_err})")
                        })?
                    } else {
                        return Err(live_err);
                    }
                }
            }
        } else {
            open_valid(&orig_path)?
        };
        let unpacked_dirs = archive.read_unpacked_dirs();
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

        if needs_elevation {
            #[cfg(target_os = "linux")]
            {
                let stage_dir = create_private_staging_dir("agy_restore_stage")?;
                let staged_clean = stage_dir.0.join("app.asar");
                emit("Сборка чистого оригинального app.asar...", 75, "info");
                asar::write_asar_with_unpacked_dirs(&staged_clean, &entries, &unpacked_dirs)?;
                let clean_sha = asar::sha256_file(&staged_clean)?;

                emit("Запрос прав администратора (pkexec) для восстановления app.asar...", 90, "info");
                system::elevated_restore_asar(&res_dir, Some(&staged_clean), Some(&clean_sha), false)?;
            }
            #[cfg(not(target_os = "linux"))]
            {
                return Err("Нет прав на запись в каталог resources/.".to_string());
            }
        } else {
            emit("Сборка чистого оригинального app.asar...", 75, "info");
            asar::write_asar_with_unpacked_dirs(&new_path, &entries, &unpacked_dirs)?;

            emit("Атомарная замена app.asar...", 90, "info");
            if let Err(e) = asar::atomic_replace_with_retry(&new_path, &asar_path) {
                let _ = fs::remove_file(&new_path);
                return Err(e);
            }
            #[cfg(unix)]
            set_readable_mode(&asar_path);
            // Save the freshly reconstructed clean stock archive atomically as app.asar.orig for future use.
            asar::atomic_copy_file(&asar_path, &orig_path)?;
            #[cfg(unix)]
            set_readable_mode(&orig_path);
        }
    }

    if !needs_elevation && manifest_path.exists() {
        let _ = fs::remove_file(&manifest_path);
    }

    emit("Оригинальный Antigravity полностью восстановлен.", 100, "success");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn make_test_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("agy_patcher_test_{tag}_{}_{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_sample_asar(path: &Path, main_body: &[u8], patched: bool) {
        let mut entries = BTreeMap::new();
        entries.insert(
            "dist/main.js".to_string(),
            AsarEntry::Packed {
                data: main_body.to_vec(),
                executable: false,
            },
        );
        if patched {
            entries.insert(
                "dist/wallpaperEngine.js".to_string(),
                AsarEntry::Packed {
                    data: b"module.exports={};".to_vec(),
                    executable: false,
                },
            );
        }
        asar::write_asar(path, &entries).unwrap();
    }

    #[test]
    fn evaluate_backup_state_handles_auto_update_and_poisoning() {
        let dir = make_test_dir("backup_state");
        let asar_path = dir.join("app.asar");
        let orig_path = dir.join("app.asar.orig");

        // 1. Fresh stock install -> must create .orig
        write_sample_asar(&asar_path, b"stock v1", false);
        assert_eq!(evaluate_backup_state(&asar_path, &orig_path), BackupAction::RefreshOrigFromLive);

        // 2. Identical stock + orig -> use existing orig
        asar::atomic_copy_file(&asar_path, &orig_path).unwrap();
        assert_eq!(evaluate_backup_state(&asar_path, &orig_path), BackupAction::UseExistingOrig);

        // 3. Antigravity auto-updated live app.asar to stock v2 while .orig is still v1 -> refresh .orig!
        write_sample_asar(&asar_path, b"stock v2 updated", false);
        assert_eq!(evaluate_backup_state(&asar_path, &orig_path), BackupAction::RefreshOrigFromLive);

        // 4. Live app.asar is patched while valid stock .orig exists -> use existing orig
        write_sample_asar(&asar_path, b"patched v1", true);
        assert_eq!(evaluate_backup_state(&asar_path, &orig_path), BackupAction::UseExistingOrig);

        // 5. Live app.asar is patched and .orig is missing -> refuse to avoid poisoning backup
        fs::remove_file(&orig_path).unwrap();
        assert_eq!(evaluate_backup_state(&asar_path, &orig_path), BackupAction::RefusePoisoned);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_json_file_preserves_corrupt_user_config() {
        let dir = make_test_dir("merge_json");
        let cfg = dir.join("agy_appearance.json");

        // 1. Corrupt JSON must be backed up to .json.corrupt and NOT overwritten
        fs::write(&cfg, "{invalid json!!!").unwrap();
        merge_json_file(&cfg, &[("lang", serde_json::Value::String("ru".into()))]);
        assert_eq!(fs::read_to_string(&cfg).unwrap(), "{invalid json!!!");
        assert!(dir.join("agy_appearance.json.corrupt").exists());

        // 2. Valid JSON merges atomically while preserving unrelated keys
        fs::write(&cfg, r#"{"customKey":42}"#).unwrap();
        merge_json_file(&cfg, &[("showTopTabBar", serde_json::Value::Bool(false))]);
        let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(parsed["customKey"], 42);
        assert_eq!(parsed["showTopTabBar"], false);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn patch_lock_blocks_concurrent_acquisition_and_releases_on_drop() {
        let dir = make_test_dir("lock");
        {
            let _guard = acquire_patch_lock(&dir, true).expect("first lock should succeed");
            assert!(
                acquire_patch_lock(&dir, true).is_err(),
                "concurrent lock must be rejected"
            );
            assert!(
                acquire_patch_lock(&dir, false).is_err(),
                "lock namespace must be shared across writable/elevated modes"
            );
        }
        // Released after drop
        let _guard2 = acquire_patch_lock(&dir, true).expect("lock after drop should succeed");
        drop(_guard2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_ag_dir_is_rejected_safely() {
        let st = get_status("   ");
        assert_eq!(st.state, "not_found");
        assert_eq!(st.antigravity_path, "");
        assert!(!st.has_backup);

        let diag = dry_run("   ");
        assert!(!diag.dry_run_passed);
        assert!(!diag.write_permission);

        assert!(restore_original("   ", |_, _, _| {}).is_err());
    }

    #[test]
    fn get_status_reports_corrupted_for_broken_asar() {
        let dir = make_test_dir("corrupt_status");
        let res_dir = dir.join("resources");
        fs::create_dir_all(&res_dir).unwrap();
        fs::write(res_dir.join("app.asar"), b"not a valid asar archive").unwrap();
        let st = get_status(&dir.to_string_lossy());
        assert_eq!(st.state, "corrupted", "Corrupt app.asar must report state='corrupted'");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_json_file_with_defaults_preserves_user_paused_on_update() {
        let dir = make_test_dir("merge_defaults");
        let cfg = dir.join("agy_appearance.json");
        fs::write(&cfg, r#"{"paused":true,"dim":0.35}"#).unwrap();

        merge_json_file_with_defaults(
            &cfg,
            &[("lang", serde_json::Value::String("ru".into()))],
            &[("paused", serde_json::Value::Bool(false))],
        )
        .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(parsed["paused"], true, "Existing user paused=true must not be overwritten");
        assert_eq!(parsed["dim"], 0.35);
        assert_eq!(parsed["lang"], "ru");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_user_configs_to_dir_preserves_user_lang_and_widget_toggles() {
        let dir = make_test_dir("sync_configs_preserve");
        let wp_dir = dir.join("custom_wallpapers");
        fs::create_dir_all(&wp_dir).unwrap();

        fs::write(
            dir.join("agy_extras_settings.json"),
            r#"{"lang":"en","showPlayer":false,"showContextRing":false}"#,
        )
        .unwrap();
        fs::write(
            dir.join("agy_appearance.json"),
            r#"{"lang":"en","showTopTabBar":false,"paused":true}"#,
        )
        .unwrap();

        let opts = ModuleOptions {
            antigravity_path: String::new(),
            wallpaper: true,
            media: true,
            i18n: true,
            accounts: true,
            context: true,
            wallpaper_dir: String::new(),
        };
        sync_user_configs_to_dir(&dir, &wp_dir, &opts).unwrap();

        let extras: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("agy_extras_settings.json")).unwrap()).unwrap();
        let app: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("agy_appearance.json")).unwrap()).unwrap();

        assert_eq!(extras["lang"], "en", "User EN lang must survive re-patch when i18n is enabled");
        assert_eq!(extras["showPlayer"], false, "User showPlayer=false must survive re-patch");
        assert_eq!(extras["showContextRing"], false, "User showContextRing=false must survive re-patch");
        assert_eq!(app["lang"], "en", "User EN lang in appearance must survive re-patch");
        assert_eq!(app["showTopTabBar"], false, "User showTopTabBar=false must survive re-patch");
        assert_eq!(app["paused"], true, "User paused=true must survive re-patch");

        let _ = fs::remove_dir_all(&dir);
    }
}
