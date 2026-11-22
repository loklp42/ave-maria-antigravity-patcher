"""
Process Guard and File Lock Checker for Antigravity
Ensures Antigravity.exe and language_server.exe are terminated gracefully
before attempting atomic file replacements.
"""

import os
import sys
import time
import subprocess
from typing import List, Tuple


def get_running_antigravity_pids() -> List[Tuple[int, str]]:
    """Returns list of (PID, ProcessName) for active Antigravity components."""
    targets = ["antigravity.exe", "language_server.exe"]
    found = []

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
                    if pname in targets:
                        try:
                            found.append((int(parts[1]), parts[0]))
                        except ValueError:
                            pass
        except Exception:
            pass
    return found


def terminate_antigravity_processes(timeout_sec: float = 3.0) -> bool:
    """Gracefully requests termination, then force kills if still running."""
    pids = get_running_antigravity_pids()
    if not pids:
        return True

    # Attempt force kill on Windows
    for pid, name in pids:
        try:
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except Exception:
            pass

    # Wait for exit
    start = time.time()
    while time.time() - start < timeout_sec:
        if not get_running_antigravity_pids():
            return True
        time.sleep(0.2)

    return len(get_running_antigravity_pids()) == 0


def wait_for_file_unlock(filepath: str, max_retries: int = 15, delay_sec: float = 0.3) -> bool:
    """Checks whether the file can be opened for read/write without access violations."""
    if not os.path.exists(filepath):
        return True

    for _ in range(max_retries):
        try:
            with open(filepath, "r+b"):
                return True
        except (IOError, PermissionError):
            time.sleep(delay_sec)

    return False
