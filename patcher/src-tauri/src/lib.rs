mod asar;
mod patcher;
mod system;

use patcher::{DiagnosticsResult, ModuleOptions, PatcherStatus, ProgressEvent};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, State, Window};

struct AppState {
    antigravity_dir: Mutex<String>,
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<PatcherStatus, String> {
    let dir = state
        .antigravity_dir
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || patcher::get_status(&dir))
        .await
        .map_err(|e| format!("Task error: {e}"))
}

#[tauri::command]
fn set_antigravity_dir(dir: String, state: State<'_, AppState>) -> Result<PatcherStatus, String> {
    {
        let mut guard = state
            .antigravity_dir
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        *guard = dir.clone();
    }
    Ok(patcher::get_status(&dir))
}

#[tauri::command]
fn count_wallpapers(dir: String) -> usize {
    if dir.trim().is_empty() {
        return 0;
    }
    system::count_workshop_items(Path::new(dir.trim()))
}

#[tauri::command]
async fn run_diagnostics(state: State<'_, AppState>) -> Result<DiagnosticsResult, String> {
    let dir = state
        .antigravity_dir
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || patcher::dry_run(&dir))
        .await
        .map_err(|e| format!("Task error: {e}"))
}

#[tauri::command]
async fn apply_patch(
    options: ModuleOptions,
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !options.antigravity_path.trim().is_empty() {
        if let Ok(mut guard) = state.antigravity_dir.lock() {
            *guard = options.antigravity_path.clone();
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        patcher::apply_patch(&options, |stage, percent, level| {
            let _ = window.emit(
                "patch-progress",
                ProgressEvent {
                    stage: stage.to_string(),
                    percent,
                    level: level.to_string(),
                },
            );
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn restore_original(window: Window, state: State<'_, AppState>) -> Result<(), String> {
    let dir = state
        .antigravity_dir
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone();

    tauri::async_runtime::spawn_blocking(move || {
        patcher::restore_original(&dir, |stage, percent, level| {
            let _ = window.emit(
                "patch-progress",
                ProgressEvent {
                    stage: stage.to_string(),
                    percent,
                    level: level.to_string(),
                },
            );
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
fn launch_antigravity(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state
        .antigravity_dir
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone();
    system::launch_antigravity(&dir)
}

#[tauri::command]
fn open_custom_wallpapers() -> Result<String, String> {
    let cust = patcher::locate_customization_dir()
        .ok_or_else(|| "Каталог customization/ не найден.".to_string())?;
    let custom_dir = cust.parent().unwrap_or(&cust).join("custom_wallpapers");
    std::fs::create_dir_all(&custom_dir)
        .map_err(|e| format!("Не удалось создать папку custom_wallpapers: {e}"))?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&custom_dir)
            .spawn()
            .map_err(|e| format!("Не удалось открыть проводник: {e}"))?;
    }
    Ok(custom_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_theme_hint(workshop_dir: Option<String>) -> system::ThemeHint {
    let ws = workshop_dir.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || system::read_theme_hint(&ws))
        .await
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let detected = system::find_antigravity_dir();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            antigravity_dir: Mutex::new(detected),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_antigravity_dir,
            count_wallpapers,
            run_diagnostics,
            apply_patch,
            restore_original,
            launch_antigravity,
            open_custom_wallpapers,
            get_theme_hint,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ave Maria Patcher");
}
