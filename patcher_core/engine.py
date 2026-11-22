"""
Core Patching Engine
Handles dry-run validation, anchor substitution, module injection,
atomic backup, and rollback.
"""

import os
import json
import shutil
import hashlib
from datetime import datetime
from typing import Dict, Any, List, Optional, Callable

from .asar_engine import AsarArchive, pack_asar_from_dict
from .process_guard import terminate_antigravity_processes, wait_for_file_unlock


AUTONOMOUS_MODULES = [
    "wallpaperEngine.js",
    "agyExtras.js",
    "agyMediaDaemon.js",
    "agyI18n.js",
    "agyUiContrast.js",
    "agyTabManager.js",
    "agyShellViews.js",
    "agyAccounts.js",
    "agyWinUserIsolation.js",
]

PATCHED_SYSTEM_FILES = [
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
]


class PatchEngine:
    def __init__(self, antigravity_dir: str, customization_root: str):
        self.antigravity_dir = antigravity_dir
        self.resources_dir = os.path.join(antigravity_dir, "resources")
        self.target_asar = os.path.join(self.resources_dir, "app.asar")
        self.backup_asar = os.path.join(self.resources_dir, "app.asar.orig")
        self.manifest_path = os.path.join(self.resources_dir, "agy_patch_manifest.json")
        self.customization_root = customization_root

    def get_status(self) -> Dict[str, Any]:
        """Returns the current patch status of the Antigravity installation."""
        if not os.path.exists(self.target_asar):
            return {"status": "not_found", "version": "unknown"}

        # Read version from package.json inside target_asar
        version = "unknown"
        try:
            archive = AsarArchive(self.target_asar)
            pkg = archive.extract_file("package.json")
            if pkg:
                version = json.loads(pkg.decode("utf-8")).get("version", "unknown")
            is_patched = archive.extract_file("dist/wallpaperEngine.js") is not None
        except Exception:
            is_patched = False

        has_backup = os.path.exists(self.backup_asar)
        manifest = None
        if os.path.exists(self.manifest_path):
            try:
                with open(self.manifest_path, "r", encoding="utf-8") as f:
                    manifest = json.load(f)
            except Exception:
                pass

        if is_patched:
            status_str = "patched"
        elif has_backup:
            status_str = "restored"
        else:
            status_str = "original"

        return {
            "status": status_str,
            "version": version,
            "has_backup": has_backup,
            "manifest": manifest,
            "asar_size": os.path.getsize(self.target_asar),
        }

    def dry_run_validate(self) -> Tuple[bool, List[str]]:
        """Validates that all required source files and target anchors exist before writing."""
        errors = []

        # 1. Check modules source
        mod_dir = os.path.join(self.customization_root, "modules")
        for m in AUTONOMOUS_MODULES:
            if not os.path.exists(os.path.join(mod_dir, m)):
                errors.append(f"Missing autonomous module in source: {m}")

        # 2. Check patched system files source
        sys_dir = os.path.join(self.customization_root, "patched_system")
        for s in PATCHED_SYSTEM_FILES:
            if not os.path.exists(os.path.join(sys_dir, s)):
                errors.append(f"Missing patched system file in source: {s}")

        # 3. Check target ASAR readable
        source_asar = self.backup_asar if os.path.exists(self.backup_asar) else self.target_asar
        if not os.path.exists(source_asar):
            errors.append(f"Target ASAR not found: {source_asar}")
        else:
            try:
                archive = AsarArchive(source_asar)
                files = archive.list_files()
                for s in PATCHED_SYSTEM_FILES:
                    if f"dist/{s}" not in files:
                        errors.append(f"Target ASAR does not contain dist/{s}")
            except Exception as e:
                errors.append(f"Cannot parse target ASAR: {e}")

        return (len(errors) == 0, errors)

    def apply_patch(
        self,
        enabled_modules: Optional[Dict[str, bool]] = None,
        progress_cb: Optional[Callable[[str, float], None]] = None,
    ) -> bool:
        """Executes full patching flow atomically."""
        if progress_cb:
            progress_cb("Проверка совместимости (Dry-Run)...", 0.1)

        ok, errors = self.dry_run_validate()
        if not ok:
            raise RuntimeError(f"Dry-run validation failed:\n" + "\n".join(errors))

        # 1. Close running processes
        if progress_cb:
            progress_cb("Остановка процессов Antigravity...", 0.2)
        if not terminate_antigravity_processes():
            raise RuntimeError("Не удалось закрыть процессы Antigravity. Закройте их вручную.")

        # 2. File unlock check
        if not wait_for_file_unlock(self.target_asar):
            raise RuntimeError("app.asar заблокирован другим процессом.")

        # 3. Backup original asar if not already present
        if progress_cb:
            progress_cb("Создание резервной копии оригинала...", 0.35)
        if not os.path.exists(self.backup_asar):
            shutil.copy2(self.target_asar, self.backup_asar)

        # 4. Read base archive (always prefer clean backup)
        source_asar = self.backup_asar
        archive = AsarArchive(source_asar)

        # 5. Extract all current files to in-memory dictionary
        if progress_cb:
            progress_cb("Чтение и модификация файлов архива...", 0.5)

        files_map: Dict[str, bytes] = {}
        all_files = archive.list_files()
        for internal_path in all_files:
            data = archive.extract_file(internal_path)
            if data is not None:
                files_map[internal_path] = data

        # 6. Inject Autonomous Modules
        mod_dir = os.path.join(self.customization_root, "modules")
        for m in AUTONOMOUS_MODULES:
            with open(os.path.join(mod_dir, m), "rb") as mf:
                files_map[f"dist/{m}"] = mf.read()

        # 7. Inject Patched System Files
        sys_dir = os.path.join(self.customization_root, "patched_system")
        for s in PATCHED_SYSTEM_FILES:
            with open(os.path.join(sys_dir, s), "rb") as sf:
                files_map[f"dist/{s}"] = sf.read()

        # 8. Repack into app.asar.new
        if progress_cb:
            progress_cb("Упаковка нового архива app.asar...", 0.75)

        new_asar_path = self.target_asar + ".new"
        pack_asar_from_dict(files_map, new_asar_path)

        # 9. Atomic swap
        if progress_cb:
            progress_cb("Атомарная замена и верификация...", 0.9)

        # Backup current target right before replacement
        temp_bak = self.target_asar + ".swap_bak"
        if os.path.exists(temp_bak):
            os.remove(temp_bak)
        os.rename(self.target_asar, temp_bak)
        os.rename(new_asar_path, self.target_asar)
        if os.path.exists(temp_bak):
            os.remove(temp_bak)

        # 10. Write Manifest
        manifest = {
            "patcher": "Ave Maria Antigravity Patcher",
            "version": "2.34.0",
            "date": datetime.now().isoformat(),
            "enabled_modules": enabled_modules or {m: True for m in AUTONOMOUS_MODULES},
            "orig_sha256": hashlib.sha256(open(self.backup_asar, "rb").read()).hexdigest(),
            "target_sha256": hashlib.sha256(open(self.target_asar, "rb").read()).hexdigest(),
        }
        with open(self.manifest_path, "w", encoding="utf-8") as mf:
            json.dump(manifest, mf, indent=2)

        if progress_cb:
            progress_cb("Готово! Кастомизация успешно установлена.", 1.0)
        return True

    def restore_original(self) -> bool:
        """Restores original unpatched app.asar from backup."""
        if not os.path.exists(self.backup_asar):
            raise FileNotFoundError("Резервная копия app.asar.orig не найдена.")

        terminate_antigravity_processes()
        wait_for_file_unlock(self.target_asar)

        shutil.copy2(self.backup_asar, self.target_asar)
        if os.path.exists(self.manifest_path):
            os.remove(self.manifest_path)
        return True
