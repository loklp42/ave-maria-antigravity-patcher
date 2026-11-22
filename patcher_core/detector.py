"""
System Detector for Antigravity Installation and Steam Wallpaper Engine
Uses Windows Registry and local app paths without hardcoded usernames.
"""

import os
import re
import sys
from typing import Optional, List, Dict, Any

try:
    import winreg
except ImportError:
    winreg = None


def find_antigravity_dir() -> Optional[str]:
    """
    Locates the Antigravity installation directory.
    Checks Windows registry first, then standard LocalAppData.
    """
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
                        if loc and os.path.exists(os.path.join(loc, "resources", "app.asar")):
                            return loc
                except OSError:
                    pass

    # 2. LocalAppData check
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        candidate = os.path.join(local_app_data, "Programs", "antigravity")
        if os.path.exists(os.path.join(candidate, "resources", "app.asar")):
            return candidate

    return None


def find_steam_path() -> Optional[str]:
    """Finds Steam installation root from registry."""
    if not winreg:
        return None

    # Check HKCU then HKLM
    for root in [winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE]:
        for subkey, val_name in [
            (r"Software\Valve\Steam", "SteamPath"),
            (r"Software\Valve\Steam", "InstallPath"),
            (r"Software\WOW6432Node\Valve\Steam", "InstallPath"),
        ]:
            try:
                with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ) as key:
                    val, _ = winreg.QueryValueEx(key, val_name)
                    if val and os.path.exists(val):
                        return val
            except OSError:
                pass
    return None


def parse_vdf_libraries(steam_path: str) -> List[str]:
    """Parses steamapps/libraryfolders.vdf to find all Steam library folder paths."""
    vdf_file = os.path.join(steam_path, "steamapps", "libraryfolders.vdf")
    if not os.path.exists(vdf_file):
        return [steam_path]

    libraries = [steam_path]
    try:
        with open(vdf_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        # Match "path" "\s*"([^"]+)"
        matches = re.findall(r'"path"\s*"([^"]+)"', content, re.IGNORECASE)
        for m in matches:
            cleaned = m.replace("\\\\", "\\")
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
    steam_dir = find_steam_path()
    if not steam_dir:
        return None

    libraries = parse_vdf_libraries(steam_dir)
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
