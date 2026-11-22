"""
Cross-platform CLI for Ave Maria Antigravity Patcher (Linux / Windows / macOS).
Allows zero-build patching, status checks, dry-run validation, and rollback directly from terminal.
"""

import argparse
import os
import subprocess
import sys

from .detector import find_antigravity_dir, find_wallpaper_engine_workshop
from .engine import PatchEngine


def _locate_customization_root() -> str:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cand = os.path.join(here, "customization")
    if os.path.isdir(os.path.join(cand, "modules")) and os.path.isdir(os.path.join(cand, "patched_system")):
        return cand
    cwd_cand = os.path.join(os.getcwd(), "customization")
    if os.path.isdir(os.path.join(cwd_cand, "modules")):
        return cwd_cand
    raise FileNotFoundError("Каталог customization/ не найден рядом с патчером.")


def _linux_needs_no_sandbox(ag_dir: str) -> bool:
    try:
        with open("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "r", encoding="utf-8") as f:
            if f.read().strip() != "1":
                return False
    except OSError:
        return False
    sandbox = os.path.join(ag_dir, "chrome-sandbox")
    try:
        st = os.stat(sandbox)
        return not (st.st_uid == 0 and bool(st.st_mode & 0o4000))
    except OSError:
        return True


def _launch_antigravity(ag_dir: str):
    if sys.platform == "win32":
        exe = os.path.join(ag_dir, "Antigravity.exe")
        if os.path.isfile(exe):
            subprocess.Popen([exe], cwd=ag_dir)
            return
    elif sys.platform.startswith("linux"):
        for rel in ("antigravity", "Antigravity", os.path.join("bin", "antigravity"), "antigravity-bin"):
            exe = os.path.join(ag_dir, rel)
            if os.path.isfile(exe):
                cmd = [exe]
                if _linux_needs_no_sandbox(ag_dir):
                    cmd.append("--no-sandbox")
                subprocess.Popen(
                    cmd,
                    cwd=ag_dir,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                return
    raise FileNotFoundError(f"Исполняемый файл Antigravity не найден в {ag_dir}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="patch-linux",
        description="Ave Maria Antigravity Patcher CLI (Linux & Cross-Platform)",
    )
    parser.add_argument(
        "action",
        nargs="?",
        default="install",
        choices=["install", "restore", "status", "dry-run"],
        help="Действие: install (по умолчанию), restore, status, dry-run",
    )
    parser.add_argument("--dir", dest="ag_dir", default="", help="Путь к папке установки Antigravity")
    parser.add_argument("--wallpaper-dir", dest="wallpaper_dir", default="", help="Путь к папке обоев Steam Workshop (431960)")
    parser.add_argument("--no-wallpaper", action="store_true", help="Отключить живые обои по умолчанию")
    parser.add_argument("--no-media", action="store_true", help="Отключить медиаплеер по умолчанию")
    parser.add_argument("--no-context", action="store_true", help="Отключить индикатор памяти чата")
    parser.add_argument("--no-i18n", action="store_true", help="Оставить английский язык интерфейса")
    parser.add_argument("--no-accounts", action="store_true", help="Скрыть верхнюю панель вкладок аккаунтов")
    parser.add_argument("--launch", action="store_true", help="Запустить Antigravity после установки/отката")
    args = parser.parse_args(argv)

    ag_dir = args.ag_dir.strip() or (find_antigravity_dir() or "")
    if not ag_dir:
        print("[ERROR] Папка установки Antigravity не найдена.", file=sys.stderr)
        print("Укажите путь вручную: ./patch-linux.sh install --dir /opt/Antigravity", file=sys.stderr)
        return 1

    cust_root = _locate_customization_root()
    engine = PatchEngine(ag_dir, cust_root)

    if args.action == "status":
        st = engine.get_status()
        ws = find_wallpaper_engine_workshop()
        print(f"Antigravity:   {ag_dir}")
        print(f"Version:       {st.get('version', 'unknown')}")
        print(f"Status:        {st.get('status', 'unknown')}")
        print(f"Backup:        {'yes' if st.get('has_backup') else 'no'}")
        print(f"Write access:  {'direct' if st.get('write_permission') else ('pkexec' if st.get('can_elevate') else 'denied')}")
        print(f"Workshop dir:  {ws['path'] if ws else 'not found'}")
        return 0

    if args.action == "dry-run":
        ok, errors = engine.dry_run_validate()
        if ok:
            print(f"[OK] Dry-run пройден для {ag_dir}")
            return 0
        print("[ERROR] Dry-run выявил проблемы:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    def on_progress(stage: str, pct: float):
        print(f"[{int(pct * 100):3d}%] {stage}")

    if args.action == "restore":
        try:
            engine.restore_original(progress_cb=on_progress)
            if args.launch:
                _launch_antigravity(ag_dir)
            return 0
        except Exception as exc:
            print(f"[ERROR] {exc}", file=sys.stderr)
            return 1

    # install
    ws_dir = args.wallpaper_dir.strip()
    if not ws_dir:
        ws = find_wallpaper_engine_workshop()
        if ws:
            ws_dir = ws["path"]

    mods = {
        "wallpaper": not args.no_wallpaper,
        "media": not args.no_media,
        "context": not args.no_context,
        "i18n": not args.no_i18n,
        "accounts": not args.no_accounts,
    }

    try:
        engine.apply_patch(enabled_modules=mods, progress_cb=on_progress, wallpaper_dir=ws_dir)
        if args.launch:
            _launch_antigravity(ag_dir)
        return 0
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
