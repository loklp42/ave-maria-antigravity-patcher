"""
Process Guard and File Lock Checker for Antigravity.
Ensures Antigravity and language_server processes are terminated cleanly
on both Windows and Linux before attempting atomic file replacements.
"""

import os
import signal
import sys
import time
import subprocess
from typing import List, Tuple

WINDOWS_TARGETS = {"antigravity.exe", "language_server.exe", "language_server_windows_x64.exe"}
LINUX_TARGETS = {
    "antigravity",
    "antigravity-bin",
    "language_server",
    "language_server_linux_x64",
    "language_server_linux_arm64",
}
PATCHER_HINTS = (
    "ave-maria-patcher",
    "antigravitypatcher",
    "antigravity-patcher",
    "patcher_core",
    "patch-linux",
)


def _is_patcher_text(text: str) -> bool:
    low = (text or "").lower()
    return any(h in low for h in PATCHER_HINTS)


def get_running_antigravity_pids() -> List[Tuple[int, str]]:
    """Returns list of (PID, ProcessName) for active Antigravity components."""
    found: List[Tuple[int, str]] = []

    if sys.platform == "win32":
        try:
            output = subprocess.check_output(
                ["tasklist", "/FO", "CSV", "/NH"],
                encoding="utf-8",
                errors="replace",
            )
            for line in output.splitlines():
                parts = [p.strip(' "') for p in line.split('","')]
                if len(parts) >= 2:
                    pname = parts[0].lower()
                    if pname in WINDOWS_TARGETS:
                        try:
                            found.append((int(parts[1]), parts[0]))
                        except ValueError:
                            pass
        except Exception:
            pass
    elif sys.platform.startswith("linux"):
        self_pid = os.getpid()
        try:
            proc_entries = os.listdir("/proc")
        except OSError:
            return found

        for entry in proc_entries:
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == self_pid:
                continue
            proc_dir = os.path.join("/proc", entry)
            try:
                with open(os.path.join(proc_dir, "cmdline"), "rb") as f:
                    cmdline = f.read().replace(b"\x00", b" ").decode("utf-8", errors="replace")
            except OSError:
                cmdline = ""
            if _is_patcher_text(cmdline):
                continue

            matched = None
            try:
                exe_path = os.readlink(os.path.join(proc_dir, "exe"))
                if _is_patcher_text(exe_path):
                    continue
                base = os.path.basename(exe_path).replace(" (deleted)", "")
                if base.lower() in LINUX_TARGETS:
                    matched = base
            except OSError:
                pass

            if not matched:
                try:
                    with open(os.path.join(proc_dir, "comm"), "r", encoding="utf-8", errors="replace") as f:
                        comm = f.read().strip()
                    if comm.lower() in LINUX_TARGETS:
                        matched = comm
                except OSError:
                    pass

            if matched:
                found.append((pid, matched))

    return found


def terminate_antigravity_processes(timeout_sec: float = 4.0) -> bool:
    """Gracefully requests termination, then force kills if still running."""
    pids = get_running_antigravity_pids()
    if not pids:
        return True

    if sys.platform == "win32":
        for pid, _ in pids:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            except Exception:
                pass
        start = time.time()
        while time.time() - start < timeout_sec:
            if not get_running_antigravity_pids():
                return True
            time.sleep(0.2)
        return len(get_running_antigravity_pids()) == 0

    if sys.platform.startswith("linux"):
        for pid, _ in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

        soft_wait = min(2.5, timeout_sec * 0.6)
        start = time.time()
        while time.time() - start < soft_wait:
            if not get_running_antigravity_pids():
                return True
            time.sleep(0.2)

        remaining = get_running_antigravity_pids()
        if remaining:
            for pid, _ in remaining:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            while time.time() - start < timeout_sec:
                if not get_running_antigravity_pids():
                    return True
                time.sleep(0.2)
        return len(get_running_antigravity_pids()) == 0

    return True


def wait_for_file_unlock(filepath: str, max_retries: int = 15, delay_sec: float = 0.3) -> bool:
    """Checks whether the file can be opened for read/write without access violations."""
    if not os.path.exists(filepath):
        return True

    if sys.platform != "win32":
        # POSIX allows atomic rename over open files once processes are stopped;
        # avoid false negatives on root-owned files before elevation.
        parent = os.path.dirname(filepath) or "."
        if not os.access(parent, os.W_OK):
            return True

    for _ in range(max_retries):
        try:
            with open(filepath, "r+b"):
                return True
        except (IOError, PermissionError):
            time.sleep(delay_sec)

    return False
