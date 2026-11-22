"""
Test Suite: Code Sanitization & Personal Data Leak Prevention.

Verifies that no hardcoded personal Windows user profile paths or private
local launcher directories exist anywhere in source modules, patcher code,
or tests.
"""

import os
import re
import unittest

# Matches hardcoded Windows user profile paths like C:\Users\<name>\ (excluding Public/Default).
USER_PROFILE_PATH_RE = re.compile(
    r"[a-zA-Z]:[/\\]users[/\\](?!public\b|default\b)[a-zA-Z0-9._ -]+[/\\]",
    re.IGNORECASE,
)

# Matches hardcoded non-standard local launcher paths.
PRIVATE_LAUNCHER_RE = re.compile(
    r"[a-zA-Z]:[/\\]games[/\\]launchers[/\\]steam",
    re.IGNORECASE,
)

SCAN_EXTENSIONS = (".js", ".ts", ".tsx", ".rs", ".py", ".bat", ".ps1", ".vbs")
SKIP_DIRS = {".git", "node_modules", "target", "__pycache__", "dist", "original_system"}


class TestSanitization(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def _iter_source_files(self):
        for root, dirs, files in os.walk(self.repo_root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fname in files:
                if fname.endswith(SCAN_EXTENSIONS):
                    yield os.path.join(root, fname)

    def test_no_hardcoded_user_profile_paths(self):
        for path in self._iter_source_files():
            rel = os.path.relpath(path, self.repo_root)
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            self.assertIsNone(
                USER_PROFILE_PATH_RE.search(content),
                f"Hardcoded Windows user profile path found in {rel}",
            )
            self.assertIsNone(
                PRIVATE_LAUNCHER_RE.search(content),
                f"Hardcoded private Steam launcher path found in {rel}",
            )


if __name__ == "__main__":
    unittest.main()
