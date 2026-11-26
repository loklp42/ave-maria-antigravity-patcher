"""
Test Suite: Code Sanitization & Personal Data Leak Prevention.

Verifies that no hardcoded personal Windows/Unix user profile paths, private
local launcher directories, or accidental API tokens/private keys exist
anywhere in source modules, patcher code, configs, patches, or tests.
"""

import os
import re
import unittest

# Generic synthetic placeholder usernames allowed in unit tests / examples.
_SAFE_USERNAMES = r"(?:public|default|all users|default user|tester|user|username|primaryuser|alice|bob|example)"

# Matches hardcoded Windows user profile paths like C:\Users\<name> or C:\\Users\\<name> (escaped or raw).
USER_PROFILE_PATH_RE = re.compile(
    rf"[a-zA-Z]:[/\\]+users[/\\]+(?!{_SAFE_USERNAMES}\b)[a-zA-Z0-9._-]+",
    re.IGNORECASE,
)

# Matches hardcoded POSIX/macOS home paths like /home/<name>/ or /Users/<name>/.
UNIX_HOME_PATH_RE = re.compile(
    rf"(?<![a-zA-Z0-9_-])/(?:home|Users)/(?!{_SAFE_USERNAMES}\b)[a-zA-Z0-9._-]+/",
)

# Matches hardcoded non-standard local launcher paths (escaped or raw).
PRIVATE_LAUNCHER_RE = re.compile(
    r"[a-zA-Z]:[/\\]+games[/\\]+launchers[/\\]+steam",
    re.IGNORECASE,
)

# Matches common leaked credentials/secrets (GitHub PAT, Google API key, PEM/OpenSSH private keys).
SECRET_PATTERNS_RE = re.compile(
    r"(ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)

SCAN_EXTENSIONS = (
    ".js", ".ts", ".tsx", ".rs", ".py", ".bat", ".ps1", ".vbs",
    ".sh", ".patch", ".json", ".toml", ".yml", ".yaml", ".html", ".css",
)
SKIP_DIRS = {
    ".git", "node_modules", "target", "__pycache__", "dist",
    "original_system", "release_pkg", "разработка",
}


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

    def test_sanitization_regexes_catch_escaped_and_secret_leaks(self):
        """Self-test: regexes must catch escaped backslashes, POSIX homes, and secrets."""
        win_esc = '"C:\\\\' + 'Users\\\\johndoe\\\\Desktop"'
        win_raw = "C:\\" + "Users\\johndoe"
        unix_home = "/ho" + "me/johndoe/.config"
        mac_home = "/Us" + "ers/johndoe/Library/"
        priv_launcher = "D:\\\\" + "Games\\\\Launchers\\\\Steam"
        self.assertIsNotNone(USER_PROFILE_PATH_RE.search(win_esc))
        self.assertIsNotNone(USER_PROFILE_PATH_RE.search(win_raw))
        self.assertIsNone(USER_PROFILE_PATH_RE.search("C:\\" + "Users\\Public\\Documents"))
        self.assertIsNotNone(UNIX_HOME_PATH_RE.search(unix_home))
        self.assertIsNotNone(UNIX_HOME_PATH_RE.search(mac_home))
        self.assertIsNone(UNIX_HOME_PATH_RE.search("/ho" + "me/tester/.config"))
        self.assertIsNotNone(PRIVATE_LAUNCHER_RE.search(priv_launcher))
        self.assertIsNotNone(SECRET_PATTERNS_RE.search("ghp_" + "A" * 36))
        self.assertIsNotNone(SECRET_PATTERNS_RE.search("AIza" + "B" * 35))
        self.assertIsNotNone(SECRET_PATTERNS_RE.search("-----BEGIN RSA " + "PRIVATE KEY-----"))

    def test_no_hardcoded_user_profile_paths_or_secrets(self):
        violations = []
        checks = [
            ("Windows user path", USER_PROFILE_PATH_RE),
            ("Unix/macOS home path", UNIX_HOME_PATH_RE),
            ("Private launcher path", PRIVATE_LAUNCHER_RE),
            ("Potential secret/key", SECRET_PATTERNS_RE),
        ]
        for path in self._iter_source_files():
            rel = os.path.relpath(path, self.repo_root)
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            for label, rx in checks:
                for m in rx.finditer(content):
                    violations.append(f"[{label}] {rel}: {m.group(0)!r}")
        if violations:
            self.fail(
                f"Found {len(violations)} sanitization violation(s):\n  "
                + "\n  ".join(violations)
            )


if __name__ == "__main__":
    unittest.main()
