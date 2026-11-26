"""
Test Suite: Linux Support, Metadata-Preserving ASAR, and End-to-End Patch/Restore Flow
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from patcher_core.asar_engine import AsarArchive, pack_asar_from_entries
from patcher_core.detector import (
    _is_valid_antigravity_dir,
    _resolve_linux_dir_from_binary,
    find_antigravity_dir,
)
from patcher_core.engine import AUTONOMOUS_MODULES, PATCHED_SYSTEM_FILES, PATCHER_VERSION, PatchEngine
from patcher_core.process_guard import _extract_argv0, _is_patcher_text


class TestLinuxSupport(unittest.TestCase):
    def setUp(self):
        self.repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.cust_root = os.path.join(self.repo_root, "customization")
        self.tmp_dir = tempfile.mkdtemp(prefix="agy_linux_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_asar_preserves_unpacked_dirs_executables_and_symlinks(self):
        asar_path = os.path.join(self.tmp_dir, "meta.asar")
        entries = {
            "package.json": {"kind": "packed", "data": b'{"version":"2.34.0"}', "executable": False},
            "dist/main.js": {"kind": "packed", "data": b"console.log('hi');", "executable": True},
            "node_modules/native/addon.node": {
                "kind": "unpacked",
                "size": 2048,
                "executable": True,
                "integrity": None,
            },
            "bin/helper": {"kind": "symlink", "link": "../dist/main.js"},
        }
        pack_asar_from_entries(entries, asar_path, unpacked_dirs={"node_modules/native"})

        arc = AsarArchive(asar_path)
        read_entries, unpacked_dirs = arc.read_all_entries()
        self.assertIn("node_modules/native", unpacked_dirs)
        self.assertEqual(read_entries["dist/main.js"]["executable"], True)
        self.assertEqual(read_entries["node_modules/native/addon.node"]["kind"], "unpacked")
        self.assertEqual(read_entries["node_modules/native/addon.node"]["size"], 2048)
        self.assertEqual(read_entries["bin/helper"], {"kind": "symlink", "link": "../dist/main.js"})

    def test_end_to_end_patch_and_restore_preserves_linux_asar_metadata(self):
        ag_dir = os.path.join(self.tmp_dir, "opt_antigravity")
        res_dir = os.path.join(ag_dir, "resources")
        os.makedirs(res_dir, exist_ok=True)
        asar_path = os.path.join(res_dir, "app.asar")

        # Build mock stock app.asar with original_system files + Linux unpacked native module + symlink
        entries = {
            "package.json": {"kind": "packed", "data": b'{"name":"Antigravity","version":"2.34.0"}', "executable": False},
            "node_modules/chrome-devtools-mcp/bin/cli.js": {
                "kind": "unpacked",
                "size": 512,
                "executable": True,
                "integrity": None,
            },
            "bin/ls-link": {"kind": "symlink", "link": "../resources/bin/language_server"},
        }
        orig_sys_dir = os.path.join(self.cust_root, "original_system")
        for fname in PATCHED_SYSTEM_FILES:
            with open(os.path.join(orig_sys_dir, fname), "rb") as f:
                entries[f"dist/{fname}"] = {"kind": "packed", "data": f.read(), "executable": False}

        pack_asar_from_entries(entries, asar_path, unpacked_dirs={"node_modules/chrome-devtools-mcp"})

        engine = PatchEngine(ag_dir, self.cust_root)
        ok, errs = engine.dry_run_validate()
        self.assertTrue(ok, f"Dry-run failed: {errs}")

        st_before = engine.get_status()
        self.assertEqual(st_before["status"], "original")
        self.assertEqual(st_before["version"], "2.34.0")

        # Patch (mock process termination so unit tests never kill a running Antigravity instance!)
        engine.sync_user_configs = lambda **kwargs: None
        with mock.patch("patcher_core.engine.terminate_antigravity_processes", return_value=True), \
             mock.patch("patcher_core.engine.wait_for_file_unlock", return_value=True):
            engine.apply_patch(wallpaper_dir="/home/tester/.local/share/Steam/steamapps/workshop/content/431960")

            st_after = engine.get_status()
            self.assertEqual(st_after["status"], "patched")
            self.assertTrue(st_after["has_backup"])

            patched_arc = AsarArchive(asar_path)
            patched_entries, patched_unpacked = patched_arc.read_all_entries()
            self.assertIn("node_modules/chrome-devtools-mcp", patched_unpacked)
            self.assertEqual(patched_entries["bin/ls-link"], {"kind": "symlink", "link": "../resources/bin/language_server"})
            for m in AUTONOMOUS_MODULES:
                self.assertIn(f"dist/{m}", patched_entries)

            wp_js = patched_arc.extract_file("dist/wallpaperEngine.js").decode("utf-8")
            self.assertIn("/home/tester/.local/share/Steam/steamapps/workshop/content/431960", wp_js)

            # Restore original
            engine.restore_original()
            st_restored = engine.get_status()
            self.assertEqual(st_restored["status"], "original")
            restored_arc = AsarArchive(asar_path)
            self.assertIsNone(restored_arc.extract_file("dist/wallpaperEngine.js"))
            self.assertIn("node_modules/chrome-devtools-mcp", restored_arc.list_unpacked_dirs())

    def test_detector_env_override_and_wrapper_script(self):
        ag_dir = os.path.join(self.tmp_dir, "antigravity_install")
        os.makedirs(os.path.join(ag_dir, "resources"), exist_ok=True)
        with open(os.path.join(ag_dir, "resources", "app.asar"), "wb") as f:
            f.write(b"dummy")

        self.assertTrue(_is_valid_antigravity_dir(ag_dir))

        prev = os.environ.get("ANTIGRAVITY_DIR")
        os.environ["ANTIGRAVITY_DIR"] = ag_dir
        try:
            self.assertEqual(find_antigravity_dir(), ag_dir)
        finally:
            if prev is None:
                os.environ.pop("ANTIGRAVITY_DIR", None)
            else:
                os.environ["ANTIGRAVITY_DIR"] = prev

        # Test resolving a shell wrapper pointing to /.../antigravity
        wrapper = os.path.join(self.tmp_dir, "antigravity-wrapper")
        bin_target = os.path.join(ag_dir, "antigravity").replace("\\", "/")
        with open(wrapper, "w", encoding="utf-8", newline="\n") as f:
            f.write(f'#!/usr/bin/env bash\nexec "{bin_target}" "$@"\n')
        if os.name != "nt":
            self.assertEqual(_resolve_linux_dir_from_binary(wrapper), ag_dir)

    def test_process_guard_excludes_patcher_processes(self):
        self.assertTrue(_is_patcher_text("/home/user/AntigravityPatcher"))
        self.assertTrue(_is_patcher_text("/usr/bin/ave-maria-patcher"))
        self.assertTrue(_is_patcher_text("python3 -m patcher_core.cli install"))
        self.assertFalse(_is_patcher_text("/opt/Antigravity/antigravity"))
        self.assertFalse(_is_patcher_text("/opt/Antigravity/resources/bin/language_server"))

    def test_shell_scripts_use_lf_line_endings(self):
        for fname in ("build-linux.sh", "patch-linux.sh", "run-tests.sh"):
            fpath = os.path.join(self.repo_root, fname)
            self.assertTrue(os.path.isfile(fpath), f"Missing {fname}")
            with open(fpath, "rb") as f:
                raw = f.read()
            self.assertNotIn(b"\r\n", raw, f"{fname} must use LF line endings for Linux")

    def test_windows_scripts_use_crlf_line_endings(self):
        win_scripts = (
            "Build-Patcher.bat",
            "Run-Tests.bat",
            "Launch-Patcher-GUI.bat",
            os.path.join("customization", "scripts", "Apply-Antigravity-Theme.bat"),
            os.path.join("customization", "scripts", "Apply-Antigravity-Theme.ps1"),
            os.path.join("customization", "scripts", "Restore-Antigravity-Theme.ps1"),
        )
        for rel in win_scripts:
            fpath = os.path.join(self.repo_root, rel)
            self.assertTrue(os.path.isfile(fpath), f"Missing {rel}")
            with open(fpath, "rb") as f:
                raw = f.read()
            self.assertIn(b"\r\n", raw, f"{rel} must use CRLF line endings on Windows")
            self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), f"{rel} must not contain bare LF line endings")

    def test_process_guard_argv0_only_and_deleted_suffix(self):
        # Opening the patcher repo inside Antigravity puts the repo name into CLI args,
        # which must NOT trick process guard into treating IDE itself as the patcher.
        ide_cmdline = b"/opt/Antigravity/antigravity\x00--folder-uri\x00file:///tmp/Ave%20Maria%20Patcher%20AG/AntigravityPatcher"
        argv0 = _extract_argv0(ide_cmdline)
        self.assertEqual(argv0, "/opt/Antigravity/antigravity")
        self.assertFalse(_is_patcher_text(argv0))
        self.assertTrue(_is_patcher_text("/usr/local/bin/ave-maria-patcher (deleted)"))
        self.assertFalse(_is_patcher_text("/opt/Antigravity/antigravity (deleted)"))

    def test_version_and_gitignore_hygiene(self):
        import re

        pkg_json = json.loads(open(os.path.join(self.repo_root, "patcher", "package.json"), "r", encoding="utf-8").read())
        tauri_conf = json.loads(open(os.path.join(self.repo_root, "patcher", "src-tauri", "tauri.conf.json"), "r", encoding="utf-8").read())
        cargo_toml = open(os.path.join(self.repo_root, "patcher", "src-tauri", "Cargo.toml"), "r", encoding="utf-8").read()
        cargo_ver_m = re.search(r'^version\s*=\s*"([^"]+)"', cargo_toml, re.M)
        self.assertIsNotNone(cargo_ver_m)
        self.assertEqual(pkg_json["version"], PATCHER_VERSION)
        self.assertEqual(tauri_conf["version"], PATCHER_VERSION)
        self.assertEqual(cargo_ver_m.group(1), PATCHER_VERSION)

        readme = open(os.path.join(self.repo_root, "README.md"), "r", encoding="utf-8").read()
        self.assertIn(f"version-{PATCHER_VERSION}-blue", readme)
        self.assertIn("1.82+", readme)

        gitignore = open(os.path.join(self.repo_root, ".gitignore"), "r", encoding="utf-8").read()
        self.assertIn("custom_fonts/", gitignore)
        self.assertIn("docs/разработка/", gitignore)


if __name__ == "__main__":
    unittest.main()
