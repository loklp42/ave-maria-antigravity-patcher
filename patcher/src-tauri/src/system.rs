//! Platform integration helpers for Windows and Linux installation discovery,
//! Steam Workshop path resolution, process termination, privilege escalation,
//! file manager launch, and theme hints.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "linux")]
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

#[derive(serde::Serialize, Clone)]
pub struct RunningProcess {
    pub pid: u32,
    pub name: String,
}

/// Resolves the active non-root user's home directory on Linux/Unix,
/// respecting `SUDO_USER` when launched via `sudo`.
#[cfg(unix)]
pub fn unix_user_home() -> Option<PathBuf> {
    if let Ok(sudo_user) = std::env::var("SUDO_USER") {
        let user = sudo_user.trim();
        if !user.is_empty() && user != "root" {
            if let Ok(passwd) = fs::read_to_string("/etc/passwd") {
                for line in passwd.lines() {
                    let mut parts = line.split(':');
                    if parts.next() == Some(user) {
                        // passwd fields: user:x:uid:gid:gecos:home:shell
                        if let Some(home) = parts.nth(4) {
                            let p = PathBuf::from(home);
                            if p.is_dir() {
                                return Some(p);
                            }
                        }
                    }
                }
            }
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .map(PathBuf::from)
}

/// Returns the shared Antigravity config directory (`%APPDATA%\Antigravity` on Windows,
/// `$XDG_CONFIG_HOME/Antigravity` or `~/.config/Antigravity` on Linux).
pub fn get_antigravity_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("APPDATA")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|p| PathBuf::from(p).join("Antigravity"))
    }

    #[cfg(target_os = "macos")]
    {
        unix_user_home().map(|h| {
            h.join("Library")
                .join("Application Support")
                .join("Antigravity")
        })
    }

    #[cfg(target_os = "linux")]
    {
        let running_under_sudo = std::env::var("SUDO_USER")
            .map(|u| !u.trim().is_empty() && u.trim() != "root")
            .unwrap_or(false);
        if !running_under_sudo {
            if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
                if !xdg.trim().is_empty() {
                    return Some(PathBuf::from(xdg).join("Antigravity"));
                }
            }
        }
        unix_user_home().map(|h| h.join(".config").join("Antigravity"))
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

fn is_valid_antigravity_dir(dir: &Path) -> bool {
    if dir.join("resources").join("app.asar").is_file() {
        return true;
    }
    #[cfg(windows)]
    {
        if dir.join("Antigravity.exe").is_file() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn find_in_path(bin_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn resolve_dir_from_binary_or_wrapper(bin_path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(bin_path).unwrap_or_else(|_| bin_path.to_path_buf());
    if let Some(parent) = canonical.parent() {
        if is_valid_antigravity_dir(parent) {
            return Some(parent.to_path_buf());
        }
        if let Some(grandparent) = parent.parent() {
            if is_valid_antigravity_dir(grandparent) {
                return Some(grandparent.to_path_buf());
            }
        }
    }

    // Community packages (e.g. Debian/Arch wrappers) sometimes install a tiny shell script
    // in /usr/bin/antigravity that execs /opt/Antigravity/antigravity or /usr/share/antigravity/...
    if let Ok(meta) = fs::metadata(&canonical) {
        if meta.len() < 16 * 1024 {
            if let Ok(text) = fs::read_to_string(&canonical) {
                if text.starts_with("#!") {
                    for token in text.split(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
                        if token.starts_with('/') && token.to_lowercase().contains("antigravity") {
                            let p = PathBuf::from(token);
                            if is_valid_antigravity_dir(&p) {
                                return Some(p);
                            }
                            if let Some(parent) = p.parent() {
                                if is_valid_antigravity_dir(parent) {
                                    return Some(parent.to_path_buf());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn resolve_dir_from_desktop_entries(home: Option<&Path>) -> Option<PathBuf> {
    let mut app_dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(h) = home {
        app_dirs.push(h.join(".local").join("share").join("applications"));
    }

    for dir in app_dirs {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.filter_map(|e| e.ok()) {
            let fname = entry.file_name().to_string_lossy().to_lowercase();
            if !fname.ends_with(".desktop") || !fname.contains("antigravity") {
                continue;
            }
            let Ok(content) = fs::read_to_string(entry.path()) else {
                continue;
            };
            for line in content.lines() {
                if let Some(exec_val) = line.strip_prefix("Exec=") {
                    let trimmed = exec_val.trim();
                    let first_tok = if let Some(rest) = trimmed.strip_prefix('"') {
                        rest.split('"').next().unwrap_or("")
                    } else {
                        trimmed.split_whitespace().next().unwrap_or("")
                    };
                    if !first_tok.is_empty() {
                        let p = PathBuf::from(first_tok);
                        if let Some(found) = resolve_dir_from_binary_or_wrapper(&p) {
                            return Some(found);
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn find_antigravity_dir() -> String {
    if let Ok(env_dir) = std::env::var("ANTIGRAVITY_DIR") {
        let p = PathBuf::from(env_dir.trim());
        if is_valid_antigravity_dir(&p) {
            return p.to_string_lossy().to_string();
        }
    }

    #[cfg(windows)]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Ok(key) = RegKey::predef(hive)
                .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\antigravity")
            {
                if let Ok(loc) = key.get_value::<String, _>("InstallLocation") {
                    candidates.push(PathBuf::from(loc));
                }
            }
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let base = PathBuf::from(&local_app_data);
            candidates.push(base.join("Programs").join("antigravity"));
            candidates.push(base.join("Programs").join("Antigravity"));
        }
        if let Ok(prog_files) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(prog_files).join("Antigravity"));
        }

        for dir in candidates {
            if is_valid_antigravity_dir(&dir) {
                return dir.to_string_lossy().to_string();
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // 1. Check binaries in PATH (handles /usr/bin/antigravity symlinks and wrapper scripts)
        for bin in ["antigravity", "Antigravity", "antigravity-bin"] {
            if let Some(bin_path) = find_in_path(bin) {
                if let Some(dir) = resolve_dir_from_binary_or_wrapper(&bin_path) {
                    return dir.to_string_lossy().to_string();
                }
            }
        }

        // 2. Check .desktop entries
        let home = unix_user_home();
        if let Some(dir) = resolve_dir_from_desktop_entries(home.as_deref()) {
            return dir.to_string_lossy().to_string();
        }

        // 3. Standard Linux FHS and user-local install directories
        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("/opt/Antigravity"),
            PathBuf::from("/opt/antigravity"),
            PathBuf::from("/opt/google/antigravity"),
            PathBuf::from("/usr/share/antigravity"),
            PathBuf::from("/usr/lib/antigravity"),
            PathBuf::from("/usr/local/share/antigravity"),
            PathBuf::from("/usr/local/lib/antigravity"),
        ];
        if let Some(ref h) = home {
            candidates.push(h.join(".local").join("share").join("antigravity"));
            candidates.push(h.join(".local").join("share").join("Antigravity"));
            candidates.push(h.join(".local").join("opt").join("antigravity"));
            candidates.push(h.join(".local").join("opt").join("Antigravity"));
            candidates.push(h.join("Applications").join("Antigravity"));
            candidates.push(h.join("Applications").join("antigravity"));
            candidates.push(h.join("Antigravity"));
            candidates.push(h.join("antigravity"));
        }

        for dir in candidates {
            if is_valid_antigravity_dir(&dir) {
                return dir.to_string_lossy().to_string();
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let candidates = [
            PathBuf::from("/Applications/Antigravity.app/Contents"),
            unix_user_home()
                .map(|h| h.join("Applications/Antigravity.app/Contents"))
                .unwrap_or_default(),
        ];
        for dir in candidates {
            if is_valid_antigravity_dir(&dir) {
                return dir.to_string_lossy().to_string();
            }
        }
    }

    String::new()
}

pub fn find_wallpaper_workshop() -> (String, usize) {
    let mut steam_roots: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        if let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
            if let Ok(path) = hkcu.get_value::<String, _>("SteamPath") {
                steam_roots.push(PathBuf::from(path.replace('/', "\\")));
            }
        }
        for fallback in [
            "C:\\Program Files (x86)\\Steam",
            "D:\\Steam",
            "C:\\Steam",
        ] {
            let p = PathBuf::from(fallback);
            if !steam_roots.contains(&p) {
                steam_roots.push(p);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = unix_user_home() {
            for rel in [
                ".local/share/Steam",
                ".steam/steam",
                ".steam/root",
                ".var/app/com.valvesoftware.Steam/.local/share/Steam",
                ".var/app/com.valvesoftware.Steam/.steam/steam",
                "snap/steam/common/.local/share/Steam",
            ] {
                let p = home.join(rel);
                if !steam_roots.contains(&p) {
                    steam_roots.push(p);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = unix_user_home() {
            steam_roots.push(home.join("Library/Application Support/Steam"));
        }
    }

    let mut libraries: Vec<PathBuf> = Vec::new();
    for root in steam_roots {
        if !root.exists() {
            continue;
        }
        if !libraries.contains(&root) {
            libraries.push(root.clone());
        }
        let vdf = root.join("steamapps").join("libraryfolders.vdf");
        if let Ok(content) = fs::read_to_string(&vdf) {
            for line in content.lines() {
                if let Some(path) = extract_vdf_path(line) {
                    let lib = PathBuf::from(path);
                    if lib.exists() && !libraries.contains(&lib) {
                        libraries.push(lib);
                    }
                }
            }
        }
    }

    for lib in libraries {
        let workshop = lib
            .join("steamapps")
            .join("workshop")
            .join("content")
            .join("431960");
        if workshop.is_dir() {
            let count = count_workshop_items(&workshop);
            return (workshop.to_string_lossy().to_string(), count);
        }
    }

    (String::new(), 0)
}

pub fn count_workshop_items(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .count()
        })
        .unwrap_or(0)
}

fn extract_vdf_path(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("\"path\"") {
        return None;
    }
    let rest = trimmed["\"path\"".len()..].trim();
    if !rest.starts_with('"') || !rest.ends_with('"') || rest.len() < 2 {
        return None;
    }
    let inner = &rest[1..rest.len() - 1];
    #[cfg(windows)]
    {
        Some(inner.replace("\\\\", "\\"))
    }
    #[cfg(not(windows))]
    {
        Some(inner.replace("\\\\", "/"))
    }
}

#[cfg(windows)]
pub fn get_running_processes() -> Vec<RunningProcess> {
    let mut result = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return result;
        }

        let mut pe: PROCESSENTRY32W = std::mem::zeroed();
        pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut pe) != 0 {
            loop {
                let len = pe
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(pe.szExeFile.len());
                let name = String::from_utf16_lossy(&pe.szExeFile[..len]);
                let low = name.to_lowercase();
                if low == "antigravity.exe"
                    || low == "language_server.exe"
                    || low == "language_server_windows_x64.exe"
                {
                    result.push(RunningProcess {
                        pid: pe.th32ProcessID,
                        name,
                    });
                }
                if Process32NextW(snapshot, &mut pe) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    result
}

#[cfg(target_os = "linux")]
fn is_patcher_process(text: &str) -> bool {
    let low = text.to_lowercase();
    low.contains("ave-maria-patcher")
        || low.contains("antigravitypatcher")
        || low.contains("antigravity-patcher")
        || low.contains("patcher_core")
        || low.contains("patch-linux")
}

#[cfg(target_os = "linux")]
fn is_target_linux_binary_name(name: &str) -> bool {
    let low = name.to_lowercase();
    matches!(
        low.as_str(),
        "antigravity"
            | "antigravity-bin"
            | "language_server"
            | "language_server_linux_x64"
            | "language_server_linux_arm64"
    )
}

#[cfg(target_os = "linux")]
pub fn get_running_processes() -> Vec<RunningProcess> {
    let mut result = Vec::new();
    let self_pid = std::process::id();
    let Ok(entries) = fs::read_dir("/proc") else {
        return result;
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let fname = entry.file_name();
        let Some(pid_str) = fname.to_str() else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }

        let proc_dir = entry.path();
        let cmdline_raw = fs::read(proc_dir.join("cmdline")).unwrap_or_default();
        let cmdline_str = String::from_utf8_lossy(&cmdline_raw).replace('\0', " ");
        if is_patcher_process(&cmdline_str) {
            continue;
        }

        let mut matched_name: Option<String> = None;

        if let Ok(exe_path) = fs::read_link(proc_dir.join("exe")) {
            let exe_lossy = exe_path.to_string_lossy();
            if is_patcher_process(&exe_lossy) {
                continue;
            }
            if let Some(base) = exe_path.file_name().and_then(|s| s.to_str()) {
                let clean = base.trim_end_matches(" (deleted)");
                if is_target_linux_binary_name(clean) {
                    matched_name = Some(clean.to_string());
                }
            }
        }

        if matched_name.is_none() {
            if let Ok(comm) = fs::read_to_string(proc_dir.join("comm")) {
                let c = comm.trim();
                if is_target_linux_binary_name(c) {
                    matched_name = Some(c.to_string());
                }
            }
        }

        if let Some(name) = matched_name {
            result.push(RunningProcess { pid, name });
        }
    }

    result
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn get_running_processes() -> Vec<RunningProcess> {
    Vec::new()
}

#[cfg(windows)]
pub fn terminate_antigravity_processes() -> bool {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let procs = get_running_processes();
        if procs.is_empty() {
            return true;
        }
        for p in &procs {
            unsafe {
                let handle = OpenProcess(PROCESS_TERMINATE, 0, p.pid);
                if !handle.is_null() {
                    TerminateProcess(handle, 0);
                    CloseHandle(handle);
                }
            }
        }
        if Instant::now() >= deadline {
            return get_running_processes().is_empty();
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(target_os = "linux")]
pub fn terminate_antigravity_processes() -> bool {
    let procs = get_running_processes();
    if procs.is_empty() {
        return true;
    }

    // 1. Send SIGTERM gracefully first
    for p in &procs {
        let _ = Command::new("kill")
            .args(["-TERM", &p.pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let soft_deadline = Instant::now() + Duration::from_millis(2500);
    while Instant::now() < soft_deadline {
        if get_running_processes().is_empty() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }

    // 2. Escalate to SIGKILL for any remaining processes
    let hard_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let remaining = get_running_processes();
        if remaining.is_empty() {
            return true;
        }
        for p in &remaining {
            let _ = Command::new("kill")
                .args(["-KILL", &p.pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if Instant::now() >= hard_deadline {
            return get_running_processes().is_empty();
        }
        thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn terminate_antigravity_processes() -> bool {
    true
}

pub fn wait_for_file_unlock(path: &Path, timeout_secs: u64) -> bool {
    #[cfg(unix)]
    {
        // On POSIX/Linux, files are not locked against atomic rename when processes are stopped,
        // and root-owned files in /opt or /usr cannot be opened read+write before pkexec elevation.
        if !path.exists() {
            return true;
        }
        if let Some(parent) = path.parent() {
            if !check_write_permission(parent) {
                return true;
            }
        }
    }

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if OpenOptions::new().read(true).write(true).open(path).is_ok() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

pub fn check_write_permission(dir: &Path) -> bool {
    let probe = dir.join(".agy_patcher_write_probe");
    match fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Returns true on Linux when `pkexec` (Polkit) is available to elevate
/// file operations in root-owned install directories (e.g. `/opt/Antigravity`).
pub fn can_elevate() -> bool {
    #[cfg(target_os = "linux")]
    {
        find_in_path("pkexec").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg(target_os = "linux")]
pub fn elevated_install_asar(
    res_dir: &Path,
    staged_asar: &Path,
    staged_manifest: &Path,
) -> Result<(), String> {
    let script = r#"
set -eu
res_dir="$1"
staged_asar="$2"
staged_manifest="$3"
asar="$res_dir/app.asar"
orig="$res_dir/app.asar.orig"
new_asar="$res_dir/app.asar.new"
swap_bak="$res_dir/app.asar.swap_bak"
manifest="$res_dir/agy_patch_manifest.json"
if [ ! -f "$orig" ]; then
  cp -p "$asar" "$orig"
  chmod 644 "$orig"
fi
cp "$staged_asar" "$new_asar"
chmod 644 "$new_asar"
rm -f "$swap_bak"
mv "$asar" "$swap_bak"
if ! mv "$new_asar" "$asar"; then
  mv "$swap_bak" "$asar" || true
  exit 1
fi
rm -f "$swap_bak"
if [ -n "$staged_manifest" ] && [ -f "$staged_manifest" ]; then
  cp "$staged_manifest" "$manifest"
  chmod 644 "$manifest"
fi
"#;

    let output = Command::new("pkexec")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("_")
        .arg(res_dir)
        .arg(staged_asar)
        .arg(staged_manifest)
        .output()
        .map_err(|e| format!("Не удалось запустить pkexec: {e}"))?;

    if output.status.success() {
        Ok(())
    } else if output.status.code() == Some(126) {
        Err("Запрос прав администратора (pkexec) отменён пользователем.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Ошибка привилегированной установки (код {:?}).", output.status.code())
        } else {
            format!("Ошибка привилегированной установки: {stderr}")
        })
    }
}

#[cfg(target_os = "linux")]
pub fn elevated_restore_asar(
    res_dir: &Path,
    staged_clean_asar: Option<&Path>,
) -> Result<(), String> {
    let script = r#"
set -eu
res_dir="$1"
staged="$2"
asar="$res_dir/app.asar"
orig="$res_dir/app.asar.orig"
manifest="$res_dir/agy_patch_manifest.json"
if [ -n "$staged" ] && [ -f "$staged" ]; then
  cp "$staged" "$res_dir/app.asar.new"
  chmod 644 "$res_dir/app.asar.new"
  mv "$res_dir/app.asar.new" "$asar"
  cp "$asar" "$orig"
  chmod 644 "$orig"
else
  cp "$orig" "$res_dir/app.asar.restore_tmp"
  chmod 644 "$res_dir/app.asar.restore_tmp"
  mv "$res_dir/app.asar.restore_tmp" "$asar"
fi
rm -f "$manifest"
"#;

    let staged_arg = staged_clean_asar
        .map(|p| p.as_os_str().to_os_string())
        .unwrap_or_default();

    let output = Command::new("pkexec")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("_")
        .arg(res_dir)
        .arg(staged_arg)
        .output()
        .map_err(|e| format!("Не удалось запустить pkexec: {e}"))?;

    if output.status.success() {
        Ok(())
    } else if output.status.code() == Some(126) {
        Err("Запрос прав администратора (pkexec) отменён пользователем.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Ошибка привилегированного отката (код {:?}).", output.status.code())
        } else {
            format!("Ошибка привилегированного отката: {stderr}")
        })
    }
}

#[cfg(target_os = "linux")]
fn linux_needs_no_sandbox(ag_dir: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let userns_restricted = fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .map(|s| s.trim() == "1")
        .unwrap_or(false);
    if !userns_restricted {
        return false;
    }
    let sandbox = ag_dir.join("chrome-sandbox");
    match fs::metadata(&sandbox) {
        Ok(meta) => !(meta.uid() == 0 && (meta.mode() & 0o4000) != 0),
        Err(_) => true,
    }
}

pub fn launch_antigravity(ag_dir: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = Path::new(ag_dir).join("Antigravity.exe");
        if !exe.exists() {
            return Err(format!("Antigravity.exe не найден: {}", exe.display()));
        }
        Command::new(&exe)
            .current_dir(ag_dir)
            .spawn()
            .map_err(|e| format!("Не удалось запустить Antigravity: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let base = Path::new(ag_dir);
        let candidates = [
            base.join("antigravity"),
            base.join("Antigravity"),
            base.join("bin").join("antigravity"),
            base.join("antigravity-bin"),
        ];
        let exe = candidates
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(|| {
                format!(
                    "Исполняемый файл antigravity не найден в {}",
                    base.display()
                )
            })?;

        let mut cmd = Command::new(&exe);
        if linux_needs_no_sandbox(base) {
            cmd.arg("--no-sandbox");
        }
        cmd.current_dir(base)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Не удалось запустить Antigravity: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let app_bundle = Path::new(ag_dir)
            .parent()
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("app"));
        if let Some(bundle) = app_bundle {
            Command::new("open")
                .arg(bundle)
                .spawn()
                .map_err(|e| format!("Не удалось запустить Antigravity: {e}"))?;
            Ok(())
        } else {
            Err(format!("Не удалось найти пакет Antigravity.app в {ag_dir}"))
        }
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = ag_dir;
        Err("Запуск Antigravity не поддерживается на этой платформе.".to_string())
    }
}

pub fn open_folder_in_file_manager(dir: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Не удалось открыть проводник: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Не удалось открыть файловый менеджер (xdg-open): {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Не удалось открыть Finder: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = dir;
        Ok(())
    }
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeHint {
    pub backdrop_data_url: Option<String>,
    pub accent_rgb: Option<String>,
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn image_to_data_url(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() == 0 || meta.len() > 2_500_000 {
        return None;
    }
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    let bytes = fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", encode_base64(&bytes)))
}

fn find_preview_in_dir(dir: &Path) -> Option<PathBuf> {
    for name in ["preview.jpg", "preview.png", "preview.webp", "preview.gif"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn read_theme_hint(workshop_dir: &str) -> ThemeHint {
    let mut hint = ThemeHint::default();
    let mut active_wp_id: Option<String> = None;

    if let Some(cfg_dir) = get_antigravity_config_dir() {
        let mut candidates = vec![
            cfg_dir.join("agy_appearance.json"),
            cfg_dir.join("Shared").join("agy_appearance.json"),
        ];
        if let Some(parent) = cfg_dir.parent() {
            candidates.push(parent.join("antigravity").join("agy_appearance.json"));
        }
        for cfg_path in candidates {
            if let Ok(raw) = fs::read_to_string(&cfg_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(rgb) = val
                        .get("accentRgb")
                        .or_else(|| val.get("accent_rgb"))
                        .and_then(|v| v.as_str())
                    {
                        if !rgb.trim().is_empty() {
                            hint.accent_rgb = Some(rgb.trim().to_string());
                        }
                    }
                    if let Some(id) = val
                        .get("wallpaperId")
                        .or_else(|| val.get("selectedId"))
                        .or_else(|| val.get("activeWallpaperId"))
                        .and_then(|v| v.as_str())
                    {
                        if !id.trim().is_empty() {
                            active_wp_id = Some(id.trim().to_string());
                        }
                    }
                    break;
                }
            }
        }
    }

    let ws_path = if !workshop_dir.trim().is_empty() {
        PathBuf::from(workshop_dir.trim())
    } else {
        let (found, _) = find_wallpaper_workshop();
        PathBuf::from(found)
    };

    if ws_path.is_dir() {
        if let Some(id) = active_wp_id {
            let folder = ws_path.join(id);
            if let Some(preview) = find_preview_in_dir(&folder) {
                hint.backdrop_data_url = image_to_data_url(&preview);
            }
        }
        if hint.backdrop_data_url.is_none() {
            if let Ok(rd) = fs::read_dir(&ws_path) {
                for entry in rd.filter_map(|e| e.ok()) {
                    if entry.path().is_dir() {
                        if let Some(preview) = find_preview_in_dir(&entry.path()) {
                            if let Some(url) = image_to_data_url(&preview) {
                                hint.backdrop_data_url = Some(url);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    hint
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_vdf_path_parses_steam_library_line() {
        let line = r#"		"path"		"/home/tester/.local/share/Steam""#;
        let parsed = extract_vdf_path(line).expect("should parse vdf path");
        assert!(parsed.contains("Steam"));
    }

    #[test]
    fn encode_base64_matches_rfc4648() {
        assert_eq!(encode_base64(b"hello"), "aGVsbG8=");
        assert_eq!(encode_base64(b"antigravity"), "YW50aWdyYXZpdHk=");
    }
}
