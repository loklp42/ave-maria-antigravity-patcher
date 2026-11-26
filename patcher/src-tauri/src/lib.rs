mod asar;
mod patcher;
mod system;

use patcher::{DiagnosticsResult, ModuleOptions, PatcherStatus, ProgressEvent};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State, Window};

struct AppState {
    antigravity_dir: Mutex<String>,
    op_in_progress: Arc<AtomicBool>,
}

struct OpGuard(Arc<AtomicBool>);

impl OpGuard {
    fn try_acquire(flag: &Arc<AtomicBool>) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self(Arc::clone(flag)))
            .map_err(|_| "Операция патчинга/отката уже выполняется.".to_string())
    }
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
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
async fn set_antigravity_dir(
    dir: String,
    state: State<'_, AppState>,
) -> Result<PatcherStatus, String> {
    if state.op_in_progress.load(Ordering::SeqCst) {
        return Err("Нельзя менять каталог Antigravity во время выполнения операции.".to_string());
    }
    let trimmed = dir.trim().to_string();
    if trimmed.is_empty() {
        return Err("Не указан каталог Antigravity.".to_string());
    }
    {
        let mut guard = state
            .antigravity_dir
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        if state.op_in_progress.load(Ordering::SeqCst) {
            return Err("Нельзя менять каталог Antigravity во время выполнения операции.".to_string());
        }
        *guard = trimmed.clone();
    }
    tauri::async_runtime::spawn_blocking(move || patcher::get_status(&trimmed))
        .await
        .map_err(|e| format!("Task error: {e}"))
}

#[tauri::command]
async fn count_wallpapers(dir: String) -> usize {
    let trimmed = dir.trim().to_string();
    if trimmed.is_empty() {
        return 0;
    }
    tauri::async_runtime::spawn_blocking(move || system::count_workshop_items(Path::new(&trimmed)))
        .await
        .unwrap_or(0)
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
    let op_guard = OpGuard::try_acquire(&state.op_in_progress)?;
    let trimmed_path = options.antigravity_path.trim().to_string();
    if trimmed_path.is_empty() {
        return Err("Не указан каталог Antigravity.".to_string());
    }
    if let Ok(mut guard) = state.antigravity_dir.lock() {
        *guard = trimmed_path;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = op_guard;
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
    let op_guard = OpGuard::try_acquire(&state.op_in_progress)?;
    let dir = state
        .antigravity_dir
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = op_guard;
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
async fn launch_antigravity(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state
        .antigravity_dir
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || system::launch_antigravity(&dir))
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn open_custom_wallpapers() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cust = patcher::locate_customization_dir()
            .ok_or_else(|| "Каталог customization/ не найден.".to_string())?;
        let custom_dir = patcher::resolve_custom_wallpapers_dir(&cust);
        system::create_dir_all_for_sudo(&custom_dir)
            .map_err(|e| format!("Не удалось создать папку custom_wallpapers: {e}"))?;
        system::open_folder_in_file_manager(&custom_dir)?;
        Ok(custom_dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
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
            op_in_progress: Arc::new(AtomicBool::new(false)),
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.op_in_progress.load(Ordering::SeqCst) {
                    api.prevent_close();
                }
            }
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
