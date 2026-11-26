"""
Core Patching Engine (Cross-Platform: Windows & Linux).
Handles dry-run validation, module injection, metadata-preserving ASAR repacking,
atomic backup/swap (with Linux pkexec elevation when needed), config sync, and rollback.
"""

import os
import sys
import stat
import time
import json
import shutil
import hashlib
import tempfile
import subprocess
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable, Tuple

try:
    import pwd
except ImportError:
    pwd = None

PATCHER_VERSION = "2.35.0"

from .asar_engine import (
    AsarArchive,
    pack_asar_from_entries,
    atomic_copy_file,
    atomic_replace_with_retry,
    atomic_write_bytes,
)
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
    if not directory or not os.path.isdir(directory):
        return False
    probe = os.path.join(
        directory,
        f".agy_patcher_probe_{os.getpid()}_{time.time_ns()}",
    )
    try:
        fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, b"ok")
        finally:
            os.close(fd)
        os.remove(probe)
        return True
    except OSError:
        try:
            if os.path.exists(probe):
                os.remove(probe)
        except OSError:
            pass
        return False


def _get_sudo_user_ids() -> Optional[Tuple[int, int]]:
    if os.name == "nt":
        return None
    geteuid = getattr(os, "geteuid", None)
    if geteuid is None or geteuid() != 0:
        return None
    sudo_user = os.environ.get("SUDO_USER", "").strip()
    if not sudo_user or sudo_user == "root":
        return None
    if pwd is not None:
        try:
            entry = pwd.getpwnam(sudo_user)
            return (entry.pw_uid, entry.pw_gid)
        except KeyError:
            pass
    try:
        uid = int(os.environ.get("SUDO_UID", "").strip())
        gid = int(os.environ.get("SUDO_GID", "").strip())
        return (uid, gid)
    except ValueError:
        return None


def _chown_if_sudo(path: str):
    if os.name == "nt":
        return
    ids = _get_sudo_user_ids()
    if not ids:
        return
    chown_fn = getattr(os, "chown", None)
    if chown_fn is None:
        return
    try:
        st = os.lstat(path)
        if not stat.S_ISLNK(st.st_mode):
            chown_fn(path, ids[0], ids[1])
    except OSError:
        pass


def _makedirs_for_sudo(directory: str):
    if os.name == "nt":
        os.makedirs(directory, exist_ok=True)
        return
    missing: List[str] = []
    cur = os.path.abspath(directory)
    while cur and not os.path.exists(cur):
        missing.append(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    os.makedirs(directory, exist_ok=True)
    for d in reversed(missing):
        _chown_if_sudo(d)
    _chown_if_sudo(directory)


def _normalize_lock_dir(res_dir: str) -> str:
    resolved = os.path.realpath(res_dir)
    if os.name == "nt":
        if resolved.startswith("\\\\?\\UNC\\"):
            resolved = "\\\\" + resolved[8:]
        elif resolved.startswith("\\\\?\\"):
            resolved = resolved[4:]
        resolved = os.path.normcase(os.path.normpath(resolved))
        if len(resolved) > 3:
            resolved = resolved.rstrip("\\")
    else:
        resolved = os.path.normpath(resolved)
        if len(resolved) > 1:
            resolved = resolved.rstrip("/")
    return resolved


def _unified_lock_dir() -> str:
    if os.name != "nt" and os.path.isdir("/tmp"):
        return "/tmp"
    return tempfile.gettempdir()


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return kernel32.GetLastError() == 5  # ERROR_ACCESS_DENIED => process exists
            try:
                exit_code = ctypes.c_ulong(0)
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return exit_code.value == STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True


def _read_lock_pid(lock_path: str, expected_lstat: os.stat_result) -> Optional[int]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(lock_path, flags)
    except OSError:
        return None
    try:
        fd_st = os.fstat(fd)
        if not stat.S_ISREG(fd_st.st_mode):
            return None
        if os.name != "nt" and (fd_st.st_dev != expected_lstat.st_dev or fd_st.st_ino != expected_lstat.st_ino):
            return None
        raw = os.read(fd, 256).decode("utf-8", errors="replace")
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("pid="):
                try:
                    return int(line[4:].strip())
                except ValueError:
                    return None
        return None
    except OSError:
        return None
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


class _PatchLock:
    """Inter-process exclusive lockfile matching Rust PatchLockGuard."""

    _BUSY_MSG = (
        "Другой экземпляр патчера уже выполняет операцию с этим каталогом Antigravity. "
        "Дождитесь его завершения."
    )

    def __init__(self, res_dir: str, writable: bool = True):
        normalized = _normalize_lock_dir(res_dir)
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
        self.lock_path = os.path.join(_unified_lock_dir(), f"agy_patcher_{digest}.lock")
        self._acquired = False
        self._owner_pid = os.getpid()

    def _create_lock(self):
        fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, f"pid={self._owner_pid}\ncreated={int(time.time())}\n".encode("utf-8"))
        finally:
            os.close(fd)
        self._acquired = True

    def __enter__(self):
        try:
            self._create_lock()
            return self
        except FileExistsError:
            pass

        reap_path = f"{self.lock_path}.reap"
        reap_fd = None
        try:
            reap_fd = os.open(reap_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            time.sleep(0.06)
            try:
                self._create_lock()
                return self
            except FileExistsError:
                raise RuntimeError(self._BUSY_MSG)

        try:
            try:
                lstat_res = os.lstat(self.lock_path)
            except FileNotFoundError:
                lstat_res = None

            if lstat_res is not None:
                if stat.S_ISLNK(lstat_res.st_mode) or not stat.S_ISREG(lstat_res.st_mode):
                    raise RuntimeError("Обнаружен небезопасный symlink по пути lock-файла патчера.")
                is_old = (time.time() - lstat_res.st_mtime) > 15 * 60
                pid = _read_lock_pid(self.lock_path, lstat_res)
                pid_alive = _is_pid_alive(pid) if pid is not None else False
                if is_old and not pid_alive:
                    try:
                        os.remove(self.lock_path)
                    except OSError:
                        pass
                else:
                    raise RuntimeError(self._BUSY_MSG)
        finally:
            if reap_fd is not None:
                try:
                    os.close(reap_fd)
                except OSError:
                    pass
                try:
                    os.remove(reap_path)
                except OSError:
                    pass

        try:
            self._create_lock()
            return self
        except FileExistsError:
            raise RuntimeError(self._BUSY_MSG)

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._acquired:
            try:
                st = os.lstat(self.lock_path)
                if not stat.S_ISLNK(st.st_mode) and stat.S_ISREG(st.st_mode):
                    pid = _read_lock_pid(self.lock_path, st)
                    if pid is None or pid == self._owner_pid:
                        os.remove(self.lock_path)
            except OSError:
                pass
            self._acquired = False


def _canonicalize_linux_res_dir(res_dir: str) -> str:
    st = os.lstat(res_dir)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise RuntimeError(f"Небезопасный каталог resources: {res_dir}")
    canon = os.path.realpath(res_dir)
    if not os.path.isdir(canon):
        raise RuntimeError(f"Каталог resources не найден: {canon}")
    return canon


def _ensure_non_symlink_file(path: str, label: str):
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise RuntimeError(f"Небезопасный путь {label}: {path}")


def _raise_pkexec_error(action_label: str, proc: subprocess.CompletedProcess):
    if proc.returncode == 126:
        raise PermissionError("Запрос прав администратора (pkexec) отменён пользователем.")
    if proc.returncode == 127:
        raise PermissionError(
            "Не удалось запросить права администратора (pkexec): отсутствует или не запущен polkit-агент."
        )
    raise RuntimeError(f"{action_label}: {proc.stderr.strip() or proc.returncode}")


def _elevated_linux_install(
    res_dir: str,
    staged_asar: str,
    staged_manifest: str,
    expected_sha256: str = "",
    refresh_orig: bool = False,
):
    canonical_res_dir = _canonicalize_linux_res_dir(res_dir)
    _ensure_non_symlink_file(staged_asar, "staged_asar")
    if staged_manifest:
        _ensure_non_symlink_file(staged_manifest, "staged_manifest")

    script = r"""
set -eu
res_dir="$1"
staged_asar="$2"
staged_manifest="$3"
expected_sha="$4"
refresh_orig="$5"
[ -d "$res_dir" ] && [ ! -L "$res_dir" ] || { echo "Invalid or symlink res_dir rejected" >&2; exit 1; }
[ -f "$staged_asar" ] && [ ! -L "$staged_asar" ] || { echo "Invalid or symlink staged_asar rejected" >&2; exit 1; }
asar="$res_dir/app.asar"
orig="$res_dir/app.asar.orig"
manifest="$res_dir/agy_patch_manifest.json"
[ ! -L "$asar" ] && [ ! -d "$asar" ] || { echo "Unsafe target app.asar rejected" >&2; exit 1; }
[ ! -L "$orig" ] && [ ! -d "$orig" ] || { echo "Unsafe target app.asar.orig rejected" >&2; exit 1; }
[ ! -L "$manifest" ] && [ ! -d "$manifest" ] || { echo "Unsafe target manifest rejected" >&2; exit 1; }
orig_tmp=""
new_asar=""
manifest_tmp=""
cleanup() {
  rm -f -- "$orig_tmp" "$new_asar" "$manifest_tmp"
}
trap cleanup EXIT INT TERM
if [ ! -f "$orig" ] || [ "$refresh_orig" = "1" ]; then
  [ -f "$asar" ] && [ ! -L "$asar" ] || { echo "Invalid source app.asar for backup" >&2; exit 1; }
  orig_tmp="$(mktemp -- "$res_dir/.app.asar.orig.tmp.XXXXXX")"
  [ -f "$orig_tmp" ] && [ ! -L "$orig_tmp" ] || { echo "Unsafe orig_tmp rejected" >&2; exit 1; }
  install -m 0644 -- "$asar" "$orig_tmp"
  sync -- "$orig_tmp" 2>/dev/null || true
  mv -f -- "$orig_tmp" "$orig"
  orig_tmp=""
fi
new_asar="$(mktemp -- "$res_dir/.app.asar.new.XXXXXX")"
[ -f "$new_asar" ] && [ ! -L "$new_asar" ] || { echo "Unsafe new_asar rejected" >&2; exit 1; }
install -m 0644 -- "$staged_asar" "$new_asar"
actual_sha="$(sha256sum -- "$new_asar" | awk '{print $1}')"
if [ -n "$expected_sha" ] && [ "$actual_sha" != "$expected_sha" ]; then
  echo "Staged ASAR checksum mismatch!" >&2
  exit 1
fi
sync -- "$new_asar" 2>/dev/null || true
mv -f -- "$new_asar" "$asar"
new_asar=""
if [ -n "$staged_manifest" ]; then
  [ -f "$staged_manifest" ] && [ ! -L "$staged_manifest" ] || { echo "Unsafe staged_manifest rejected" >&2; exit 1; }
  manifest_tmp="$(mktemp -- "$res_dir/.agy_patch_manifest.json.tmp.XXXXXX")"
  [ -f "$manifest_tmp" ] && [ ! -L "$manifest_tmp" ] || { echo "Unsafe manifest_tmp rejected" >&2; exit 1; }
  install -m 0644 -- "$staged_manifest" "$manifest_tmp"
  sync -- "$manifest_tmp" 2>/dev/null || true
  mv -f -- "$manifest_tmp" "$manifest"
  manifest_tmp=""
fi
"""
    proc = subprocess.run(
        [
            "pkexec",
            "/bin/sh",
            "-c",
            script,
            "_",
            canonical_res_dir,
            staged_asar,
            staged_manifest,
            expected_sha256,
            "1" if refresh_orig else "0",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        _raise_pkexec_error("Ошибка привилегированной установки", proc)


def _elevated_linux_restore(
    res_dir: str,
    staged_clean_asar: str = "",
    expected_sha256: str = "",
    refresh_orig_from_live: bool = False,
):
    canonical_res_dir = _canonicalize_linux_res_dir(res_dir)
    if staged_clean_asar:
        _ensure_non_symlink_file(staged_clean_asar, "staged_clean_asar")

    script = r"""
set -eu
res_dir="$1"
staged="$2"
expected_sha="$3"
refresh_orig_only="$4"
[ -d "$res_dir" ] && [ ! -L "$res_dir" ] || { echo "Invalid or symlink res_dir rejected" >&2; exit 1; }
asar="$res_dir/app.asar"
orig="$res_dir/app.asar.orig"
manifest="$res_dir/agy_patch_manifest.json"
[ ! -L "$asar" ] && [ ! -d "$asar" ] || { echo "Unsafe target app.asar rejected" >&2; exit 1; }
[ ! -L "$orig" ] && [ ! -d "$orig" ] || { echo "Unsafe target app.asar.orig rejected" >&2; exit 1; }
[ ! -L "$manifest" ] && [ ! -d "$manifest" ] || { echo "Unsafe target manifest rejected" >&2; exit 1; }
new_asar=""
orig_tmp=""
restore_tmp=""
cleanup() {
  rm -f -- "$new_asar" "$orig_tmp" "$restore_tmp"
}
trap cleanup EXIT INT TERM
if [ "$refresh_orig_only" = "1" ]; then
  [ -f "$asar" ] && [ ! -L "$asar" ] || { echo "Invalid live app.asar rejected" >&2; exit 1; }
  orig_tmp="$(mktemp -- "$res_dir/.app.asar.orig.tmp.XXXXXX")"
  [ -f "$orig_tmp" ] && [ ! -L "$orig_tmp" ] || { echo "Unsafe orig_tmp rejected" >&2; exit 1; }
  install -m 0644 -- "$asar" "$orig_tmp"
  actual_sha="$(sha256sum -- "$orig_tmp" | awk '{print $1}')"
  if [ -n "$expected_sha" ] && [ "$actual_sha" != "$expected_sha" ]; then
    echo "Live stock ASAR checksum mismatch!" >&2
    exit 1
  fi
  sync -- "$orig_tmp" 2>/dev/null || true
  mv -f -- "$orig_tmp" "$orig"
  orig_tmp=""
elif [ -n "$staged" ]; then
  [ -f "$staged" ] && [ ! -L "$staged" ] || { echo "Invalid or symlink staged rejected" >&2; exit 1; }
  new_asar="$(mktemp -- "$res_dir/.app.asar.new.XXXXXX")"
  [ -f "$new_asar" ] && [ ! -L "$new_asar" ] || { echo "Unsafe new_asar rejected" >&2; exit 1; }
  install -m 0644 -- "$staged" "$new_asar"
  actual_sha="$(sha256sum -- "$new_asar" | awk '{print $1}')"
  if [ -n "$expected_sha" ] && [ "$actual_sha" != "$expected_sha" ]; then
    echo "Staged restore ASAR checksum mismatch!" >&2
    exit 1
  fi
  sync -- "$new_asar" 2>/dev/null || true
  mv -f -- "$new_asar" "$asar"
  new_asar=""
  orig_tmp="$(mktemp -- "$res_dir/.app.asar.orig.tmp.XXXXXX")"
  [ -f "$orig_tmp" ] && [ ! -L "$orig_tmp" ] || { echo "Unsafe orig_tmp rejected" >&2; exit 1; }
  install -m 0644 -- "$asar" "$orig_tmp"
  sync -- "$orig_tmp" 2>/dev/null || true
  mv -f -- "$orig_tmp" "$orig"
  orig_tmp=""
else
  [ -f "$orig" ] && [ ! -L "$orig" ] || { echo "Invalid or symlink backup app.asar.orig rejected" >&2; exit 1; }
  restore_tmp="$(mktemp -- "$res_dir/.app.asar.restore.XXXXXX")"
  [ -f "$restore_tmp" ] && [ ! -L "$restore_tmp" ] || { echo "Unsafe restore_tmp rejected" >&2; exit 1; }
  install -m 0644 -- "$orig" "$restore_tmp"
  actual_sha="$(sha256sum -- "$restore_tmp" | awk '{print $1}')"
  if [ -n "$expected_sha" ] && [ "$actual_sha" != "$expected_sha" ]; then
    echo "Backup ASAR checksum mismatch!" >&2
    exit 1
  fi
  sync -- "$restore_tmp" 2>/dev/null || true
  mv -f -- "$restore_tmp" "$asar"
  restore_tmp=""
fi
rm -f -- "$manifest"
"""
    proc = subprocess.run(
        [
            "pkexec",
            "/bin/sh",
            "-c",
            script,
            "_",
            canonical_res_dir,
            staged_clean_asar,
            expected_sha256,
            "1" if refresh_orig_from_live else "0",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        _raise_pkexec_error("Ошибка привилегированного отката", proc)


def _merge_json_file(
    path: str,
    updates: Dict[str, Any],
    defaults_if_missing: Optional[Dict[str, Any]] = None,
):
    data: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                raise ValueError("Top-level JSON is not an object")
            data = loaded
        except Exception:
            try:
                corrupt_path = path + ".corrupt"
                shutil.copy2(path, corrupt_path)
                _chown_if_sudo(corrupt_path)
            except OSError:
                pass
            return  # Never silently clobber unreadable user config
    if defaults_if_missing:
        for k, v in defaults_if_missing.items():
            if k not in data:
                data[k] = v
    data.update(updates)
    payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
    atomic_write_bytes(path, payload)
    _chown_if_sudo(path)


class PatchEngine:
    def __init__(self, antigravity_dir: str, customization_root: str):
        cleaned_dir = (antigravity_dir or "").strip()
        self.antigravity_dir = cleaned_dir
        self.resources_dir = os.path.join(cleaned_dir, "resources") if cleaned_dir else ""
        self.target_asar = os.path.join(self.resources_dir, "app.asar") if cleaned_dir else ""
        self.backup_asar = os.path.join(self.resources_dir, "app.asar.orig") if cleaned_dir else ""
        self.manifest_path = (
            os.path.join(self.resources_dir, "agy_patch_manifest.json") if cleaned_dir else ""
        )
        self.customization_root = customization_root

    def _has_any_autonomous_module(self, archive: AsarArchive) -> bool:
        return any(archive.has_file(f"dist/{m}") for m in AUTONOMOUS_MODULES)

    def get_status(self) -> Dict[str, Any]:
        """Returns the current patch status of the Antigravity installation."""
        can_elevate = sys.platform.startswith("linux") and shutil.which("pkexec") is not None
        if not self.antigravity_dir:
            return {
                "status": "not_found",
                "version": "unknown",
                "has_backup": False,
                "manifest": None,
                "asar_size": 0,
                "write_permission": False,
                "can_elevate": can_elevate,
            }

        has_backup = os.path.exists(self.backup_asar)
        manifest = None
        if os.path.exists(self.manifest_path):
            try:
                with open(self.manifest_path, "r", encoding="utf-8") as f:
                    manifest = json.load(f)
            except Exception:
                pass

        write_perm = _can_write_dir(self.resources_dir) if os.path.isdir(self.resources_dir) else False
        if not os.path.exists(self.target_asar):
            return {
                "status": "not_found",
                "version": "unknown",
                "has_backup": has_backup,
                "manifest": manifest,
                "asar_size": 0,
                "write_permission": write_perm,
                "can_elevate": can_elevate,
            }

        version = "unknown"
        is_corrupted = False
        is_patched = False
        try:
            archive = AsarArchive(self.target_asar)
            archive.verify_structural_bounds()
            pkg = archive.extract_file("package.json")
            if pkg:
                version = json.loads(pkg.decode("utf-8")).get("version", "unknown")
            is_patched = archive.has_file("dist/wallpaperEngine.js")
        except Exception:
            is_corrupted = True

        if is_corrupted:
            status_str = "corrupted"
        elif is_patched:
            status_str = "patched"
        else:
            status_str = "original"

        return {
            "status": status_str,
            "version": version,
            "has_backup": has_backup,
            "manifest": manifest,
            "asar_size": os.path.getsize(self.target_asar),
            "write_permission": write_perm,
            "can_elevate": can_elevate,
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

        if not self.antigravity_dir:
            errors.append("Antigravity directory is not specified.")
            return (False, errors)

        source_asar = self.backup_asar if os.path.exists(self.backup_asar) else self.target_asar
        if not os.path.exists(source_asar):
            errors.append(f"Target ASAR not found: {source_asar}")
        else:
            try:
                archive = AsarArchive(source_asar)
                archive.verify_structural_bounds()
                for s in PATCHED_SYSTEM_FILES:
                    if not archive.has_file(f"dist/{s}"):
                        errors.append(f"Target ASAR does not contain dist/{s}")
            except Exception as e:
                errors.append(f"Cannot parse target ASAR: {e}")

        return (len(errors) == 0, errors)

    def resolve_custom_wallpapers_dir(self, config_dir: Optional[str] = None) -> str:
        repo_root = os.path.dirname(os.path.abspath(self.customization_root))
        preferred = os.path.join(repo_root, "custom_wallpapers")
        try:
            _makedirs_for_sudo(preferred)
            if _can_write_dir(preferred):
                return preferred
        except OSError:
            pass
        cfg = config_dir or get_antigravity_config_dir()
        if cfg:
            fallback = os.path.join(cfg, "custom_wallpapers")
            try:
                _makedirs_for_sudo(fallback)
                return fallback
            except OSError:
                pass
        return preferred

    def sync_user_configs(
        self,
        wallpaper_dir: str = "",
        enabled_modules: Optional[Dict[str, bool]] = None,
    ):
        """Syncs custom_wallpapers/ folder and component settings into Antigravity's config dir."""
        mods = enabled_modules or {}
        config_dir = get_antigravity_config_dir()
        _makedirs_for_sudo(config_dir)
        custom_dir = self.resolve_custom_wallpapers_dir(config_dir=config_dir)

        wp_enabled = bool(mods.get("wallpaper", True))
        wp_updates: Dict[str, Any] = {
            "customWallpaperDir": custom_dir,
        }
        if wallpaper_dir.strip():
            wp_updates["wallpaperDir"] = wallpaper_dir.strip()
        _merge_json_file(os.path.join(config_dir, "wallpaper_config.json"), wp_updates)

        extras_updates: Dict[str, Any] = {}
        extras_defaults: Dict[str, Any] = {}
        if not bool(mods.get("media", True)):
            extras_updates["showPlayer"] = False
        else:
            extras_defaults["showPlayer"] = True
        if not bool(mods.get("context", True)):
            extras_updates["showContextRing"] = False
        else:
            extras_defaults["showContextRing"] = True
        if not bool(mods.get("i18n", True)):
            extras_updates["lang"] = "en"
        else:
            extras_defaults["lang"] = "ru"
        _merge_json_file(
            os.path.join(config_dir, "agy_extras_settings.json"),
            extras_updates,
            defaults_if_missing=extras_defaults,
        )

        appearance_updates: Dict[str, Any] = {}
        appearance_defaults: Dict[str, Any] = {}
        if not bool(mods.get("i18n", True)):
            appearance_updates["lang"] = "en"
        else:
            appearance_defaults["lang"] = "ru"
        if not bool(mods.get("accounts", True)):
            appearance_updates["showTopTabBar"] = False
        else:
            appearance_defaults["showTopTabBar"] = True
        if not wp_enabled:
            appearance_updates["paused"] = True
        else:
            appearance_defaults["paused"] = False
        _merge_json_file(
            os.path.join(config_dir, "agy_appearance.json"),
            appearance_updates,
            defaults_if_missing=appearance_defaults,
        )

    def _is_valid_stock_asar(self, path: str) -> bool:
        if not os.path.exists(path):
            return False
        try:
            arc = AsarArchive(path)
            arc.verify_structural_bounds()
            return not self._has_any_autonomous_module(arc)
        except Exception:
            return False

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

        with _PatchLock(self.resources_dir, writable=not needs_elevation):
            if progress_cb:
                progress_cb("Остановка процессов Antigravity...", 0.2)
            if not terminate_antigravity_processes():
                raise RuntimeError("Не удалось закрыть процессы Antigravity. Закройте их вручную.")

            if not wait_for_file_unlock(self.target_asar):
                raise RuntimeError("app.asar заблокирован другим процессом.")

            live_is_stock = self._is_valid_stock_asar(self.target_asar)
            orig_is_valid_stock = self._is_valid_stock_asar(self.backup_asar)
            refresh_orig_elevated = False

            if live_is_stock:
                needs_refresh = (
                    not orig_is_valid_stock
                    or _sha256_file(self.target_asar) != _sha256_file(self.backup_asar)
                )
                if needs_refresh:
                    if not needs_elevation:
                        if progress_cb:
                            progress_cb("Создание атомарной резервной копии оригинала...", 0.35)
                        atomic_copy_file(self.target_asar, self.backup_asar)
                        _set_readable_mode(self.backup_asar)
                        source_asar = self.backup_asar
                    else:
                        refresh_orig_elevated = True
                        source_asar = self.target_asar
                else:
                    source_asar = self.backup_asar
            elif orig_is_valid_stock:
                source_asar = self.backup_asar
            else:
                raise RuntimeError(
                    "Исходный app.asar уже пропатчен, а чистый бэкап app.asar.orig отсутствует или повреждён. "
                    "Выполните восстановление перед повторной установкой."
                )

            archive = AsarArchive(source_asar)
            archive.verify_structural_bounds()

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
                stage_dir = tempfile.mkdtemp(prefix="agy_patch_stage_")
                staged_asar = os.path.join(stage_dir, "app.asar")
                staged_manifest = os.path.join(stage_dir, "agy_patch_manifest.json")
                try:
                    if progress_cb:
                        progress_cb("Упаковка нового архива app.asar...", 0.75)
                    pack_asar_from_entries(entries, staged_asar, unpacked_dirs=unpacked_dirs)
                    target_sha = _sha256_file(staged_asar)
                    manifest = {
                        "patcher": "Ave Maria Antigravity Patcher",
                        "version": PATCHER_VERSION,
                        "installed_at": datetime.now(timezone.utc).isoformat(),
                        "antigravity_dir": self.antigravity_dir,
                        "wallpaper_dir": wallpaper_dir,
                        "modules": mods,
                        "orig_sha256": orig_sha,
                        "target_sha256": target_sha,
                    }
                    atomic_write_bytes(staged_manifest, json.dumps(manifest, indent=2).encode("utf-8"))
                    if progress_cb:
                        progress_cb("Запрос прав (pkexec) и атомарная замена app.asar...", 0.9)
                    _elevated_linux_install(
                        self.resources_dir,
                        staged_asar,
                        staged_manifest,
                        expected_sha256=target_sha,
                        refresh_orig=refresh_orig_elevated,
                    )
                finally:
                    shutil.rmtree(stage_dir, ignore_errors=True)
            else:
                if progress_cb:
                    progress_cb("Упаковка нового архива app.asar...", 0.75)
                new_asar_path = self.target_asar + ".new"
                pack_asar_from_entries(entries, new_asar_path, unpacked_dirs=unpacked_dirs)

                if progress_cb:
                    progress_cb("Атомарная замена и верификация...", 0.9)
                try:
                    atomic_replace_with_retry(new_asar_path, self.target_asar)
                except Exception:
                    try:
                        if os.path.exists(new_asar_path):
                            os.remove(new_asar_path)
                    except OSError:
                        pass
                    raise
                _set_readable_mode(self.target_asar)

                manifest = {
                    "patcher": "Ave Maria Antigravity Patcher",
                    "version": PATCHER_VERSION,
                    "installed_at": datetime.now(timezone.utc).isoformat(),
                    "antigravity_dir": self.antigravity_dir,
                    "wallpaper_dir": wallpaper_dir,
                    "modules": mods,
                    "orig_sha256": orig_sha,
                    "target_sha256": _sha256_file(self.target_asar),
                }
                atomic_write_bytes(self.manifest_path, json.dumps(manifest, indent=2).encode("utf-8"))
                _set_readable_mode(self.manifest_path)

        self.sync_user_configs(wallpaper_dir=wallpaper_dir, enabled_modules=mods)

        if progress_cb:
            progress_cb("Готово! Кастомизация успешно установлена.", 1.0)
        return True

    def restore_original(
        self,
        progress_cb: Optional[Callable[[str, float], None]] = None,
    ) -> bool:
        """Restores original unpatched app.asar from backup or reconstructs from original_system/."""
        if not self.antigravity_dir:
            raise ValueError("Не указан каталог Antigravity.")
        if not os.path.exists(self.target_asar) and not os.path.exists(self.backup_asar):
            raise FileNotFoundError("Файл app.asar не найден.")

        needs_elevation = not _can_write_dir(self.resources_dir)
        if needs_elevation:
            if not (sys.platform.startswith("linux") and shutil.which("pkexec")):
                raise PermissionError(
                    f"Нет прав на запись в {self.resources_dir}. Запустите с sudo / от администратора."
                )

        with _PatchLock(self.resources_dir, writable=not needs_elevation):
            if progress_cb:
                progress_cb("Остановка процессов Antigravity...", 0.2)
            if not terminate_antigravity_processes():
                raise RuntimeError("Не удалось закрыть процессы Antigravity. Закройте их вручную.")
            if os.path.exists(self.target_asar) and not wait_for_file_unlock(self.target_asar):
                raise RuntimeError("app.asar заблокирован другим процессом.")

            live_is_stock = self._is_valid_stock_asar(self.target_asar)
            orig_sha_actual = _sha256_file(self.backup_asar) if os.path.exists(self.backup_asar) else ""

            if live_is_stock:
                live_sha = _sha256_file(self.target_asar)
                orig_matches_live = orig_sha_actual == live_sha
                if not orig_matches_live or os.path.exists(self.manifest_path):
                    if needs_elevation:
                        if progress_cb:
                            progress_cb("Обновление актуального бэкапа app.asar.orig (pkexec)...", 0.75)
                        _elevated_linux_restore(
                            self.resources_dir,
                            expected_sha256=live_sha,
                            refresh_orig_from_live=True,
                        )
                    else:
                        if not orig_matches_live:
                            if progress_cb:
                                progress_cb(
                                    "Обнаружен актуальный оригинальный app.asar — обновление app.asar.orig...",
                                    0.75,
                                )
                            atomic_copy_file(self.target_asar, self.backup_asar)
                            _set_readable_mode(self.backup_asar)
                        if os.path.exists(self.manifest_path):
                            os.remove(self.manifest_path)
                if progress_cb:
                    progress_cb("Установлен актуальный оригинальный Antigravity.", 1.0)
                return True

            manifest_orig_sha = ""
            if os.path.exists(self.manifest_path):
                try:
                    with open(self.manifest_path, "r", encoding="utf-8") as mf:
                        manifest_orig_sha = str(json.load(mf).get("orig_sha256") or "")
                except Exception:
                    manifest_orig_sha = ""

            orig_is_clean = (
                self._is_valid_stock_asar(self.backup_asar)
                and (not manifest_orig_sha or orig_sha_actual == manifest_orig_sha)
            )

            if orig_is_clean:
                if progress_cb:
                    progress_cb("Атомарное восстановление оригинального app.asar из бэкапа...", 0.7)
                if needs_elevation:
                    _elevated_linux_restore(self.resources_dir, expected_sha256=orig_sha_actual)
                else:
                    atomic_copy_file(self.backup_asar, self.target_asar)
                    _set_readable_mode(self.target_asar)
                    if os.path.exists(self.manifest_path):
                        os.remove(self.manifest_path)
            else:
                orig_sys_dir = os.path.join(self.customization_root, "original_system")
                if not os.path.isdir(orig_sys_dir):
                    raise FileNotFoundError("Резервная копия app.asar.orig и каталог original_system/ не найдены.")

                if progress_cb:
                    progress_cb("Очистка патча и восстановление стандартных файлов...", 0.5)
                archive = None
                last_exc: Optional[Exception] = None
                for candidate in (self.target_asar, self.backup_asar):
                    if not os.path.exists(candidate):
                        continue
                    try:
                        arc = AsarArchive(candidate)
                        arc.verify_structural_bounds()
                        archive = arc
                        break
                    except Exception as exc:
                        last_exc = exc
                if archive is None:
                    raise last_exc or FileNotFoundError("Не найден читаемый ASAR для отката.")
                entries, unpacked_dirs = archive.read_all_entries()

                for m in AUTONOMOUS_MODULES:
                    entries.pop(f"dist/{m}", None)
                for s in PATCHED_SYSTEM_FILES:
                    with open(os.path.join(orig_sys_dir, s), "rb") as sf:
                        entries[f"dist/{s}"] = {"kind": "packed", "data": sf.read(), "executable": False}

                if needs_elevation:
                    stage_dir = tempfile.mkdtemp(prefix="agy_restore_stage_")
                    staged_clean = os.path.join(stage_dir, "app.asar")
                    try:
                        pack_asar_from_entries(entries, staged_clean, unpacked_dirs=unpacked_dirs)
                        clean_sha = _sha256_file(staged_clean)
                        _elevated_linux_restore(self.resources_dir, staged_clean, expected_sha256=clean_sha)
                    finally:
                        shutil.rmtree(stage_dir, ignore_errors=True)
                else:
                    new_asar = self.target_asar + ".new"
                    pack_asar_from_entries(entries, new_asar, unpacked_dirs=unpacked_dirs)
                    try:
                        atomic_replace_with_retry(new_asar, self.target_asar)
                    except Exception:
                        try:
                            if os.path.exists(new_asar):
                                os.remove(new_asar)
                        except OSError:
                            pass
                        raise
                    _set_readable_mode(self.target_asar)
                    atomic_copy_file(self.target_asar, self.backup_asar)
                    _set_readable_mode(self.backup_asar)
                    if os.path.exists(self.manifest_path):
                        os.remove(self.manifest_path)

        if progress_cb:
            progress_cb("Оригинальный Antigravity восстановлен.", 1.0)
        return True
