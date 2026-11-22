//! Platform integration helpers for Windows installation discovery,
//! Steam Workshop path resolution, process termination, and theme hints.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;
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

pub fn find_antigravity_dir() -> String {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(&local_app_data);
        candidates.push(base.join("Programs").join("antigravity"));
        candidates.push(base.join("Programs").join("Antigravity"));
    }
    if let Ok(prog_files) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(prog_files).join("Antigravity"));
    }

    for dir in candidates {
        if dir.join("resources").join("app.asar").exists() || dir.join("Antigravity.exe").exists() {
            return dir.to_string_lossy().to_string();
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
    Some(inner.replace("\\\\", "\\"))
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

#[cfg(not(windows))]
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

#[cfg(not(windows))]
pub fn terminate_antigravity_processes() -> bool {
    true
}

pub fn wait_for_file_unlock(path: &Path, timeout_secs: u64) -> bool {
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

pub fn launch_antigravity(ag_dir: &str) -> Result<(), String> {
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

    if let Ok(appdata) = std::env::var("APPDATA") {
        let base = PathBuf::from(appdata);
        let candidates = [
            base.join("Antigravity").join("agy_appearance.json"),
            base.join("Antigravity").join("Shared").join("agy_appearance.json"),
            base.join("antigravity").join("agy_appearance.json"),
        ];
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
