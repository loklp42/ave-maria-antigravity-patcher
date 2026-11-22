"""
Core Patching Engine (Cross-Platform: Windows & Linux).
Handles dry-run validation, module injection, metadata-preserving ASAR repacking,
atomic backup/swap (with Linux pkexec elevation when needed), config sync, and rollback.
"""

import os
import sys
import json
import shutil
import hashlib
import tempfile
import subprocess
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable, Tuple

from .asar_engine import AsarArchive, pack_asar_from_entries
from .detector import get_antigravity_config_dir
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


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(256 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _replace_default_wallpaper_dir(src: str, wallpaper_dir: str) -> str:
    needle = "const DEFAULT_WALLPAPER_DIR = "
    start = src.find(needle)
    if start < 0:
        return src
    after = src[start + len(needle) :]
    semi = after.find(";")
    if semi < 0:
        return src
    return src[: start + len(needle)] + json.dumps(wallpaper_dir) + after[semi:]


def _set_readable_mode(path: str):
    if os.name != "nt":
        try:
            os.chmod(path, 0o644)
        except OSError:
            pass


def _can_write_dir(directory: str) -> bool:
    probe = os.path.join(directory, ".agy_patcher_write_probe")
    try:
        with open(probe, "wb") as f:
            f.write(b"ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def _elevated_linux_install(res_dir: str, staged_asar: str, staged_manifest: str):
    script = r"""
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
"""
    proc = subprocess.run(
        ["pkexec", "/bin/sh", "-c", script, "_", res_dir, staged_asar, staged_manifest],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 126:
        raise PermissionError("Запрос прав администратора (pkexec) отменён пользователем.")
    if proc.returncode != 0:
        raise RuntimeError(f"Ошибка привилегированной установки: {proc.stderr.strip() or proc.returncode}")


def _elevated_linux_restore(res_dir: str, staged_clean_asar: str = ""):
    script = r"""
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
"""
    proc = subprocess.run(
        ["pkexec", "/bin/sh", "-c", script, "_", res_dir, staged_clean_asar],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 126:
        raise PermissionError("Запрос прав администратора (pkexec) отменён пользователем.")
    if proc.returncode != 0:
        raise RuntimeError(f"Ошибка привилегированного отката: {proc.stderr.strip() or proc.returncode}")


def _merge_json_file(path: str, updates: Dict[str, Any]):
    data: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            pass
    data.update(updates)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


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
            "write_permission": _can_write_dir(self.resources_dir),
            "can_elevate": sys.platform.startswith("linux") and shutil.which("pkexec") is not None,
        }

    def dry_run_validate(self) -> Tuple[bool, List[str]]:
        """Validates that all required source files and target anchors exist before writing."""
        errors: List[str] = []

        mod_dir = os.path.join(self.customization_root, "modules")
        for m in AUTONOMOUS_MODULES:
            if not os.path.exists(os.path.join(mod_dir, m)):
                errors.append(f"Missing autonomous module in source: {m}")

        sys_dir = os.path.join(self.customization_root, "patched_system")
        for s in PATCHED_SYSTEM_FILES:
            if not os.path.exists(os.path.join(sys_dir, s)):
                errors.append(f"Missing patched system file in source: {s}")

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

    def sync_user_configs(
        self,
        wallpaper_dir: str = "",
        enabled_modules: Optional[Dict[str, bool]] = None,
    ):
        """Syncs custom_wallpapers/ folder and component settings into Antigravity's config dir."""
        mods = enabled_modules or {}
        repo_root = os.path.dirname(os.path.abspath(self.customization_root))
        custom_dir = os.path.join(repo_root, "custom_wallpapers")
        os.makedirs(custom_dir, exist_ok=True)

        config_dir = get_antigravity_config_dir()
        os.makedirs(config_dir, exist_ok=True)

        wp_updates: Dict[str, Any] = {"customWallpaperDir": custom_dir}
        if wallpaper_dir.strip():
            wp_updates["wallpaperDir"] = wallpaper_dir.strip()
        _merge_json_file(os.path.join(config_dir, "wallpaper_config.json"), wp_updates)

        lang = "ru" if mods.get("i18n", True) else "en"
        _merge_json_file(
            os.path.join(config_dir, "agy_extras_settings.json"),
            {
                "showPlayer": bool(mods.get("media", True)),
                "showContextRing": bool(mods.get("context", True)),
                "lang": lang,
            },
        )
        _merge_json_file(
            os.path.join(config_dir, "agy_appearance.json"),
            {
                "lang": lang,
                "showTopTabBar": bool(mods.get("accounts", True)),
            },
        )

    def apply_patch(
        self,
        enabled_modules: Optional[Dict[str, bool]] = None,
        progress_cb: Optional[Callable[[str, float], None]] = None,
        wallpaper_dir: str = "",
    ) -> bool:
        """Executes full patching flow atomically."""
        if progress_cb:
            progress_cb("Проверка совместимости (Dry-Run)...", 0.1)

        ok, errors = self.dry_run_validate()
        if not ok:
            raise RuntimeError("Dry-run validation failed:\n" + "\n".join(errors))

        needs_elevation = not _can_write_dir(self.resources_dir)
        if needs_elevation:
            if not (sys.platform.startswith("linux") and shutil.which("pkexec")):
                raise PermissionError(
                    f"Нет прав на запись в {self.resources_dir}. Запустите с sudo / от администратора."
                )

        if progress_cb:
            progress_cb("Остановка процессов Antigravity...", 0.2)
        if not terminate_antigravity_processes():
            raise RuntimeError("Не удалось закрыть процессы Antigravity. Закройте их вручную.")

        if not wait_for_file_unlock(self.target_asar):
            raise RuntimeError("app.asar заблокирован другим процессом.")

        if not needs_elevation and not os.path.exists(self.backup_asar):
            if progress_cb:
                progress_cb("Создание резервной копии оригинала...", 0.35)
            shutil.copy2(self.target_asar, self.backup_asar)
            _set_readable_mode(self.backup_asar)

        source_asar = self.backup_asar if os.path.exists(self.backup_asar) else self.target_asar
        archive = AsarArchive(source_asar)

        if progress_cb:
            progress_cb("Чтение и модификация файлов архива...", 0.5)

        entries, unpacked_dirs = archive.read_all_entries()

        mod_dir = os.path.join(self.customization_root, "modules")
        for m in AUTONOMOUS_MODULES:
            with open(os.path.join(mod_dir, m), "rb") as mf:
                data = mf.read()
            if m == "wallpaperEngine.js" and wallpaper_dir.strip():
                text = data.decode("utf-8")
                data = _replace_default_wallpaper_dir(text, wallpaper_dir.strip()).encode("utf-8")
            entries[f"dist/{m}"] = {"kind": "packed", "data": data, "executable": False}

        sys_dir = os.path.join(self.customization_root, "patched_system")
        for s in PATCHED_SYSTEM_FILES:
            with open(os.path.join(sys_dir, s), "rb") as sf:
                data = sf.read()
            entries[f"dist/{s}"] = {"kind": "packed", "data": data, "executable": False}

        orig_sha = _sha256_file(source_asar)
        mods = enabled_modules or {
            "wallpaper": True,
            "media": True,
            "context": True,
            "i18n": True,
            "accounts": True,
        }

        if needs_elevation:
            fd_asar, staged_asar = tempfile.mkstemp(prefix="agy_patch_", suffix=".asar")
            os.close(fd_asar)
            fd_man, staged_manifest = tempfile.mkstemp(prefix="agy_manifest_", suffix=".json")
            os.close(fd_man)
            try:
                if progress_cb:
                    progress_cb("Упаковка нового архива app.asar...", 0.75)
                pack_asar_from_entries(entries, staged_asar, unpacked_dirs=unpacked_dirs)
                manifest = {
                    "patcher": "Ave Maria Antigravity Patcher",
                    "version": "2.34.0",
                    "installed_at": datetime.now(timezone.utc).isoformat(),
                    "antigravity_dir": self.antigravity_dir,
                    "wallpaper_dir": wallpaper_dir,
                    "modules": mods,
                    "orig_sha256": orig_sha,
                    "target_sha256": _sha256_file(staged_asar),
                }
                with open(staged_manifest, "w", encoding="utf-8") as mf:
                    json.dump(manifest, mf, indent=2)
                if progress_cb:
                    progress_cb("Запрос прав (pkexec) и атомарная замена app.asar...", 0.9)
                _elevated_linux_install(self.resources_dir, staged_asar, staged_manifest)
            finally:
                for p in (staged_asar, staged_manifest):
                    try:
                        if os.path.exists(p):
                            os.remove(p)
                    except OSError:
                        pass
        else:
            if progress_cb:
                progress_cb("Упаковка нового архива app.asar...", 0.75)
            new_asar_path = self.target_asar + ".new"
            pack_asar_from_entries(entries, new_asar_path, unpacked_dirs=unpacked_dirs)

            if progress_cb:
                progress_cb("Атомарная замена и верификация...", 0.9)
            temp_bak = self.target_asar + ".swap_bak"
            if os.path.exists(temp_bak):
                os.remove(temp_bak)
            os.rename(self.target_asar, temp_bak)
            try:
                os.rename(new_asar_path, self.target_asar)
            except Exception:
                os.rename(temp_bak, self.target_asar)
                raise
            if os.path.exists(temp_bak):
                os.remove(temp_bak)
            _set_readable_mode(self.target_asar)

            manifest = {
                "patcher": "Ave Maria Antigravity Patcher",
                "version": "2.34.0",
                "installed_at": datetime.now(timezone.utc).isoformat(),
                "antigravity_dir": self.antigravity_dir,
                "wallpaper_dir": wallpaper_dir,
                "modules": mods,
                "orig_sha256": orig_sha,
                "target_sha256": _sha256_file(self.target_asar),
            }
            with open(self.manifest_path, "w", encoding="utf-8") as mf:
                json.dump(manifest, mf, indent=2)
            _set_readable_mode(self.manifest_path)

        try:
            self.sync_user_configs(wallpaper_dir=wallpaper_dir, enabled_modules=mods)
        except Exception:
            pass

        if progress_cb:
            progress_cb("Готово! Кастомизация успешно установлена.", 1.0)
        return True

    def restore_original(
        self,
        progress_cb: Optional[Callable[[str, float], None]] = None,
    ) -> bool:
        """Restores original unpatched app.asar from backup or reconstructs from original_system/."""
        if not os.path.exists(self.target_asar) and not os.path.exists(self.backup_asar):
            raise FileNotFoundError("Файл app.asar не найден.")

        needs_elevation = not _can_write_dir(self.resources_dir)
        if needs_elevation:
            if not (sys.platform.startswith("linux") and shutil.which("pkexec")):
                raise PermissionError(
                    f"Нет прав на запись в {self.resources_dir}. Запустите с sudo / от администратора."
                )

        if progress_cb:
            progress_cb("Остановка процессов Antigravity...", 0.2)
        terminate_antigravity_processes()
        wait_for_file_unlock(self.target_asar)

        orig_is_clean = False
        if os.path.exists(self.backup_asar):
            try:
                orig_is_clean = AsarArchive(self.backup_asar).extract_file("dist/wallpaperEngine.js") is None
            except Exception:
                orig_is_clean = False

        if orig_is_clean:
            if progress_cb:
                progress_cb("Восстановление оригинального app.asar из бэкапа...", 0.7)
            if needs_elevation:
                _elevated_linux_restore(self.resources_dir)
            else:
                shutil.copy2(self.backup_asar, self.target_asar)
                _set_readable_mode(self.target_asar)
                if os.path.exists(self.manifest_path):
                    os.remove(self.manifest_path)
        else:
            orig_sys_dir = os.path.join(self.customization_root, "original_system")
            if not os.path.isdir(orig_sys_dir):
                raise FileNotFoundError("Резервная копия app.asar.orig и каталог original_system/ не найдены.")

            if progress_cb:
                progress_cb("Очистка патча и восстановление стандартных файлов...", 0.5)
            source = self.target_asar if os.path.exists(self.target_asar) else self.backup_asar
            archive = AsarArchive(source)
            entries, unpacked_dirs = archive.read_all_entries()

            for m in AUTONOMOUS_MODULES:
                entries.pop(f"dist/{m}", None)
            for s in PATCHED_SYSTEM_FILES:
                with open(os.path.join(orig_sys_dir, s), "rb") as sf:
                    entries[f"dist/{s}"] = {"kind": "packed", "data": sf.read(), "executable": False}

            if needs_elevation:
                fd, staged_clean = tempfile.mkstemp(prefix="agy_restore_", suffix=".asar")
                os.close(fd)
                try:
                    pack_asar_from_entries(entries, staged_clean, unpacked_dirs=unpacked_dirs)
                    _elevated_linux_restore(self.resources_dir, staged_clean)
                finally:
                    try:
                        if os.path.exists(staged_clean):
                            os.remove(staged_clean)
                    except OSError:
                        pass
            else:
                new_asar = self.target_asar + ".new"
                pack_asar_from_entries(entries, new_asar, unpacked_dirs=unpacked_dirs)
                temp_bak = self.target_asar + ".swap_bak"
                if os.path.exists(temp_bak):
                    os.remove(temp_bak)
                if os.path.exists(self.target_asar):
                    os.rename(self.target_asar, temp_bak)
                try:
                    os.rename(new_asar, self.target_asar)
                except Exception:
                    if os.path.exists(temp_bak):
                        os.rename(temp_bak, self.target_asar)
                    raise
                if os.path.exists(temp_bak):
                    os.remove(temp_bak)
                _set_readable_mode(self.target_asar)
                shutil.copy2(self.target_asar, self.backup_asar)
                _set_readable_mode(self.backup_asar)
                if os.path.exists(self.manifest_path):
                    os.remove(self.manifest_path)

        if progress_cb:
            progress_cb("Оригинальный Antigravity восстановлен.", 1.0)
        return True
