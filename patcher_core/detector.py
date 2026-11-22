"""
System Detector for Antigravity Installation and Steam Wallpaper Engine.
Supports Windows (Registry + LocalAppData) and Linux (PATH, .desktop, FHS, XDG, Flatpak/Snap Steam).
"""

import os
import re
import shutil
import sys
from typing import Optional, List, Dict, Any

try:
    import winreg
except ImportError:
    winreg = None

try:
    import pwd
except ImportError:
    pwd = None


def get_real_user_home() -> str:
    """Returns the invoking user's home directory (respecting SUDO_USER on Linux/Unix)."""
    if sys.platform != "win32":
        sudo_user = os.environ.get("SUDO_USER", "").strip()
        if sudo_user and sudo_user != "root" and pwd is not None:
            try:
                return pwd.getpwnam(sudo_user).pw_dir
            except KeyError:
                pass
    return os.path.expanduser("~")


def get_antigravity_config_dir() -> str:
    """Returns the shared Antigravity config directory across Windows, Linux, and macOS."""
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
        return os.path.join(appdata, "Antigravity")
    if sys.platform == "darwin":
        return os.path.join(get_real_user_home(), "Library", "Application Support", "Antigravity")
    sudo_user = os.environ.get("SUDO_USER", "").strip()
    if not sudo_user or sudo_user == "root":
        xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
        if xdg:
            return os.path.join(xdg, "Antigravity")
    return os.path.join(get_real_user_home(), ".config", "Antigravity")


def _is_valid_antigravity_dir(directory: str) -> bool:
    if not directory:
        return False
    return os.path.isfile(os.path.join(directory, "resources", "app.asar"))


def _resolve_linux_dir_from_binary(bin_path: str) -> Optional[str]:
    if not bin_path or not os.path.exists(bin_path):
        return None
    canonical = os.path.realpath(bin_path)
    parent = os.path.dirname(canonical)
    if _is_valid_antigravity_dir(parent):
        return parent
    grandparent = os.path.dirname(parent)
    if _is_valid_antigravity_dir(grandparent):
        return grandparent

    # Check if it's a tiny shell wrapper script referencing the real install directory
    try:
        if os.path.isfile(canonical) and os.path.getsize(canonical) < 16 * 1024:
            with open(canonical, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            if text.startswith("#!"):
                for token in re.split(r"[\s\"']+", text):
                    if token.startswith("/") and "antigravity" in token.lower():
                        if _is_valid_antigravity_dir(token):
                            return token
                        p = os.path.dirname(token)
                        if _is_valid_antigravity_dir(p):
                            return p
    except OSError:
        pass
    return None


def _find_linux_dir_from_desktop_entries(home: str) -> Optional[str]:
    app_dirs = [
        "/usr/share/applications",
        "/usr/local/share/applications",
        os.path.join(home, ".local", "share", "applications"),
    ]
    for app_dir in app_dirs:
        if not os.path.isdir(app_dir):
            continue
        try:
            for fname in os.listdir(app_dir):
                if not fname.lower().endswith(".desktop") or "antigravity" not in fname.lower():
                    continue
                fpath = os.path.join(app_dir, fname)
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        if line.startswith("Exec="):
                            raw = line[5:].strip()
                            if raw.startswith('"'):
                                tok = raw[1:].split('"', 1)[0]
                            else:
                                tok = raw.split()[0] if raw.split() else ""
                            resolved = _resolve_linux_dir_from_binary(tok)
                            if resolved:
                                return resolved
        except OSError:
            continue
    return None


def find_antigravity_dir() -> Optional[str]:
    """
    Locates the Antigravity installation directory.
    Checks ANTIGRAVITY_DIR env override first, then platform-specific paths.
    """
    env_dir = os.environ.get("ANTIGRAVITY_DIR", "").strip()
    if env_dir and _is_valid_antigravity_dir(env_dir):
        return env_dir

    if sys.platform == "win32":
        # 1. Registry check
        if winreg:
            for root in [winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE]:
                for view in [0, winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY]:
                    try:
                        with winreg.OpenKey(
                            root,
                            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\antigravity",
                            0,
                            winreg.KEY_READ | view,
                        ) as key:
                            loc, _ = winreg.QueryValueEx(key, "InstallLocation")
                            if loc and _is_valid_antigravity_dir(loc):
                                return loc
                    except OSError:
                        pass

        # 2. LocalAppData & ProgramFiles check
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if local_app_data:
            for sub in ("antigravity", "Antigravity"):
                candidate = os.path.join(local_app_data, "Programs", sub)
                if _is_valid_antigravity_dir(candidate):
                    return candidate
        prog_files = os.environ.get("ProgramFiles", "")
        if prog_files:
            candidate = os.path.join(prog_files, "Antigravity")
            if _is_valid_antigravity_dir(candidate):
                return candidate
        return None

    if sys.platform.startswith("linux"):
        # 1. Resolve from PATH binaries / symlinks / wrapper scripts
        for bin_name in ("antigravity", "Antigravity", "antigravity-bin"):
            which_path = shutil.which(bin_name)
            if which_path:
                resolved = _resolve_linux_dir_from_binary(which_path)
                if resolved:
                    return resolved

        # 2. Check .desktop entries
        home = get_real_user_home()
        desktop_found = _find_linux_dir_from_desktop_entries(home)
        if desktop_found:
            return desktop_found

        # 3. Standard Linux install paths
        candidates = [
            "/opt/Antigravity",
            "/opt/antigravity",
            "/opt/google/antigravity",
            "/usr/share/antigravity",
            "/usr/lib/antigravity",
            "/usr/local/share/antigravity",
            "/usr/local/lib/antigravity",
            os.path.join(home, ".local", "share", "antigravity"),
            os.path.join(home, ".local", "share", "Antigravity"),
            os.path.join(home, ".local", "opt", "antigravity"),
            os.path.join(home, ".local", "opt", "Antigravity"),
            os.path.join(home, "Applications", "Antigravity"),
            os.path.join(home, "Applications", "antigravity"),
            os.path.join(home, "Antigravity"),
            os.path.join(home, "antigravity"),
        ]
        for candidate in candidates:
            if _is_valid_antigravity_dir(candidate):
                return candidate
        return None

    if sys.platform == "darwin":
        home = get_real_user_home()
        for candidate in (
            "/Applications/Antigravity.app/Contents",
            os.path.join(home, "Applications", "Antigravity.app", "Contents"),
        ):
            if _is_valid_antigravity_dir(candidate):
                return candidate

    return None


def find_steam_roots() -> List[str]:
    """Finds all candidate Steam installation roots for the current platform."""
    roots: List[str] = []
    if sys.platform == "win32":
        if winreg:
            for root in [winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE]:
                for subkey, val_name in [
                    (r"Software\Valve\Steam", "SteamPath"),
                    (r"Software\Valve\Steam", "InstallPath"),
                    (r"Software\WOW6432Node\Valve\Steam", "InstallPath"),
                ]:
                    try:
                        with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as key:
                            val, _ = winreg.QueryValueEx(key, val_name)
                            if val and os.path.exists(val) and val not in roots:
                                roots.append(val)
                    except OSError:
                        pass
        for fallback in (r"C:\Program Files (x86)\Steam", r"D:\Steam", r"C:\Steam"):
            if os.path.exists(fallback) and fallback not in roots:
                roots.append(fallback)
    elif sys.platform.startswith("linux"):
        home = get_real_user_home()
        for rel in (
            os.path.join(".local", "share", "Steam"),
            os.path.join(".steam", "steam"),
            os.path.join(".steam", "root"),
            os.path.join(".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
            os.path.join(".var", "app", "com.valvesoftware.Steam", ".steam", "steam"),
            os.path.join("snap", "steam", "common", ".local", "share", "Steam"),
        ):
            cand = os.path.join(home, rel)
            if os.path.exists(cand) and cand not in roots:
                roots.append(cand)
    elif sys.platform == "darwin":
        cand = os.path.join(get_real_user_home(), "Library", "Application Support", "Steam")
        if os.path.exists(cand):
            roots.append(cand)
    return roots


def find_steam_path() -> Optional[str]:
    """Finds primary Steam installation root."""
    roots = find_steam_roots()
    return roots[0] if roots else None


def parse_vdf_libraries(steam_path: str) -> List[str]:
    """Parses steamapps/libraryfolders.vdf to find all Steam library folder paths."""
    vdf_file = os.path.join(steam_path, "steamapps", "libraryfolders.vdf")
    if not os.path.exists(vdf_file):
        return [steam_path]

    libraries = [steam_path]
    try:
        with open(vdf_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        matches = re.findall(r'"path"\s*"([^"]+)"', content, re.IGNORECASE)
        for m in matches:
            cleaned = m.replace("\\\\", "\\" if sys.platform == "win32" else "/")
            if os.path.exists(cleaned) and cleaned not in libraries:
                libraries.append(cleaned)
    except Exception:
        pass

    return libraries


def find_wallpaper_engine_workshop() -> Optional[Dict[str, Any]]:
    """
    Finds the Wallpaper Engine Steam Workshop directory (App ID 431960).
    Returns path and count of available wallpapers.
    """
    roots = find_steam_roots()
    if not roots:
        return None

    libraries: List[str] = []
    for root in roots:
        for lib in parse_vdf_libraries(root):
            if lib not in libraries:
                libraries.append(lib)

    for lib in libraries:
        workshop_dir = os.path.join(lib, "steamapps", "workshop", "content", "431960")
        if os.path.exists(workshop_dir) and os.path.isdir(workshop_dir):
            try:
                items = [
                    d
                    for d in os.listdir(workshop_dir)
                    if os.path.isdir(os.path.join(workshop_dir, d))
                ]
                return {
                    "path": workshop_dir,
                    "count": len(items),
                    "library": lib,
                }
            except OSError:
                continue

    return None
