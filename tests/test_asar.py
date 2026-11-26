"""
Test Suite: ASAR Reader and Packer Integrity
"""

import os
import json
import struct
import unittest
import tempfile
import hashlib

from patcher_core.asar_engine import AsarArchive, pack_asar_from_dict, pack_asar_from_entries, compute_file_integrity
from patcher_core.engine import _merge_json_file, _PatchLock, PatchEngine, _normalize_lock_dir


class TestAsarEngine(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.sample_files = {
            "dist/main.js": b"console.log('main');\n" * 50,
            "dist/utils.js": b"exports.add = (a, b) => a + b;\n",
            "package.json": b'{"name": "test-app", "version": "1.0.0"}',
            "nested/deep/file.txt": b"deep nested content" * 1000,
        }
        self.asar_path = os.path.join(self.test_dir, "test.asar")
        pack_asar_from_dict(self.sample_files, self.asar_path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_asar_creation_and_listing(self):
        archive = AsarArchive(self.asar_path)
        files = archive.list_files()
        self.assertEqual(len(files), 4)
        for expected in self.sample_files:
            self.assertIn(expected, files)

    def test_file_extraction_fidelity(self):
        archive = AsarArchive(self.asar_path)
        for path, original_data in self.sample_files.items():
            extracted = archive.extract_file(path)
            self.assertEqual(extracted, original_data, f"Data mismatch in {path}")

    def test_integrity_blocks(self):
        large_data = b"A" * (5 * 1024 * 1024)  # 5 MB > 4 MB block size
        integrity = compute_file_integrity(large_data)
        self.assertEqual(integrity["algorithm"], "SHA256")
        self.assertEqual(len(integrity["blocks"]), 2)
        self.assertEqual(integrity["hash"], hashlib.sha256(large_data).hexdigest())

    def test_rejects_truncated_asar_payload(self):
        raw = open(self.asar_path, "rb").read()
        trunc_path = os.path.join(self.test_dir, "truncated.asar")
        with open(trunc_path, "wb") as f:
            f.write(raw[:-500])
        arc = AsarArchive(trunc_path)
        with self.assertRaises(EOFError):
            arc.verify_structural_bounds()
        with self.assertRaises(EOFError):
            arc.read_all_entries()

    def test_rejects_zip_slip_traversal(self):
        evil_json = json.dumps({"files": {"..": {"size": 3, "offset": "0"}}}).encode("utf-8")
        pad = (4 - (len(evil_json) % 4)) % 4
        total_size = len(evil_json) + pad + 8
        payload_size = total_size - 4
        evil_asar = os.path.join(self.test_dir, "evil.asar")
        with open(evil_asar, "wb") as f:
            f.write(struct.pack("<IIII", 4, total_size, payload_size, len(evil_json)))
            f.write(evil_json + (b"\x00" * pad) + b"pwn")
        arc = AsarArchive(evil_asar)
        with self.assertRaises(ValueError):
            arc.verify_structural_bounds()
        with self.assertRaises(ValueError):
            arc.extract_all(os.path.join(self.test_dir, "out"))

    def test_merge_json_preserves_corrupt_file_and_lock_guard(self):
        corrupt_cfg = os.path.join(self.test_dir, "agy_appearance.json")
        with open(corrupt_cfg, "w", encoding="utf-8") as f:
            f.write("{corrupt json")
        _merge_json_file(corrupt_cfg, {"lang": "ru"})
        self.assertEqual(open(corrupt_cfg, "r", encoding="utf-8").read(), "{corrupt json")
        self.assertTrue(os.path.exists(corrupt_cfg + ".corrupt"))

        # Exclusive lockfile prevents concurrent runs
        with _PatchLock(self.test_dir, writable=True):
            with self.assertRaises(RuntimeError):
                with _PatchLock(self.test_dir, writable=True):
                    pass
        # Re-acquiring after release succeeds
        with _PatchLock(self.test_dir, writable=True):
            pass

    def test_get_status_reports_corrupted_for_broken_asar(self):
        from patcher_core.engine import PatchEngine

        fake_ag = os.path.join(self.test_dir, "fake_ag")
        res_dir = os.path.join(fake_ag, "resources")
        os.makedirs(res_dir, exist_ok=True)
        with open(os.path.join(res_dir, "app.asar"), "wb") as f:
            f.write(b"broken asar bytes")
        with open(os.path.join(res_dir, "app.asar.orig"), "wb") as f:
            f.write(b"backup placeholder")
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        eng = PatchEngine(fake_ag, os.path.join(repo_root, "customization"))
        st = eng.get_status()
        self.assertEqual(st["status"], "corrupted", "Corrupt app.asar must report 'corrupted', not 'restored'")

    def test_rejects_missing_root_files_bad_size_and_path_collision(self):
        # 1. Header missing root "files" object must raise ValueError
        bad_root = os.path.join(self.test_dir, "missing_root_files.asar")
        hdr_json = b'{"other":{}}'
        pad = (4 - (len(hdr_json) % 4)) % 4
        padded = hdr_json + (b"\x00" * pad)
        total = len(padded) + 8
        with open(bad_root, "wb") as f:
            f.write(struct.pack("<IIII", 4, total, total - 4, len(hdr_json)))
            f.write(padded)
        with self.assertRaises(ValueError):
            AsarArchive(bad_root).read_header()

        # 2. Invalid/negative size field must fail strictly (never coerced to 0)
        bad_size = os.path.join(self.test_dir, "bad_size.asar")
        sz_json = b'{"files":{"a.txt":{"size":-5,"offset":"0"}}}'
        sz_pad = (4 - (len(sz_json) % 4)) % 4
        sz_padded = sz_json + (b"\x00" * sz_pad)
        sz_total = len(sz_padded) + 8
        with open(bad_size, "wb") as f:
            f.write(struct.pack("<IIII", 4, sz_total, sz_total - 4, len(sz_json)))
            f.write(sz_padded)
        with self.assertRaises(ValueError):
            AsarArchive(bad_size).verify_structural_bounds()

        # 3. File vs directory prefix collision ("a" and "a/b") must be rejected
        coll_path = os.path.join(self.test_dir, "collision.asar")
        with self.assertRaises(ValueError):
            pack_asar_from_entries(
                {
                    "a": {"kind": "packed", "data": b"file", "executable": False},
                    "a/b": {"kind": "packed", "data": b"nested", "executable": False},
                },
                coll_path,
            )

    def test_dry_run_bounds_and_restore_protects_updated_stock(self):
        from unittest import mock

        ag_dir = os.path.join(self.test_dir, "ag_inst")
        res_dir = os.path.join(ag_dir, "resources")
        os.makedirs(res_dir, exist_ok=True)
        orig_asar = os.path.join(res_dir, "app.asar.orig")
        live_asar = os.path.join(res_dir, "app.asar")
        manifest_path = os.path.join(res_dir, "agy_patch_manifest.json")

        # 1. Truncated archive fails dry_run_validate even when header is intact
        pack_asar_from_dict(
            {"package.json": b'{"version":"1.0.0"}', "dist/main.js": b"A" * 2048},
            live_asar,
        )
        raw = open(live_asar, "rb").read()
        with open(live_asar, "wb") as f:
            f.write(raw[:-512])
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        eng = PatchEngine(ag_dir, os.path.join(repo_root, "customization"))
        dry_ok, _dry_errs = eng.dry_run_validate()
        self.assertFalse(dry_ok, "Truncated ASAR must fail dry_run_validate")

        # 2. If live app.asar was auto-updated to newer stock, restore_original must NOT downgrade it with old .orig
        pack_asar_from_dict({"package.json": b'{"version":"1.0.0"}', "dist/main.js": b"stock v1"}, orig_asar)
        pack_asar_from_dict({"package.json": b'{"version":"2.99.0"}', "dist/main.js": b"stock v2"}, live_asar)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"version": "2.35.0"}, f)

        with mock.patch("patcher_core.engine.terminate_antigravity_processes", return_value=True):
            self.assertTrue(eng.restore_original())

        live_pkg = json.loads(AsarArchive(live_asar).extract_file("package.json").decode("utf-8"))
        self.assertEqual(live_pkg["version"], "2.99.0", "Newer stock ASAR must not be downgraded to old backup")
        self.assertFalse(os.path.exists(manifest_path), "Stale patch manifest should be cleaned up")

        # 3. Corrupt live app.asar with intact .orig recovers from .orig
        with open(live_asar, "wb") as f:
            f.write(b"corrupted bytes")
        pack_asar_from_dict({"package.json": b'{"version":"1.5.0"}', "dist/main.js": b"clean orig"}, orig_asar)
        with mock.patch("patcher_core.engine.terminate_antigravity_processes", return_value=True):
            self.assertTrue(eng.restore_original())
        recovered_pkg = json.loads(AsarArchive(live_asar).extract_file("package.json").decode("utf-8"))
        self.assertEqual(recovered_pkg["version"], "1.5.0")

    def test_sync_user_configs_preserves_paused_and_sets_custom_wallpapers(self):
        from unittest import mock

        ag_dir = os.path.join(self.test_dir, "ag_cfg")
        cfg_dir = os.path.join(self.test_dir, "user_cfg")
        cust_dir = os.path.join(self.test_dir, "isolated_repo", "customization")
        os.makedirs(os.path.join(ag_dir, "resources"), exist_ok=True)
        os.makedirs(cfg_dir, exist_ok=True)
        os.makedirs(cust_dir, exist_ok=True)
        appearance_file = os.path.join(cfg_dir, "agy_appearance.json")
        with open(appearance_file, "w", encoding="utf-8") as f:
            json.dump({"paused": True, "dim": 0.42}, f)

        eng = PatchEngine(ag_dir, cust_dir)
        with mock.patch("patcher_core.engine.get_antigravity_config_dir", return_value=cfg_dir), \
             mock.patch("patcher_core.engine._can_write_dir", return_value=False):
            eng.sync_user_configs(wallpaper_dir="", enabled_modules={"wallpaper": True})

        saved = json.loads(open(appearance_file, "r", encoding="utf-8").read())
        self.assertTrue(saved["paused"], "Existing user 'paused: true' must be preserved on patch update")
        self.assertNotIn("enabled", saved, "Dead key 'enabled' must not be written")
        self.assertNotIn("wallpaperEnabled", saved, "Dead key 'wallpaperEnabled' must not be written")
        self.assertTrue(os.path.isdir(os.path.join(cfg_dir, "custom_wallpapers")), "Fallback custom_wallpapers dir must be created when install root is read-only")

        # User choices (EN lang, showPlayer=False, showContextRing=False, showTopTabBar=False) survive re-patch when modules stay enabled
        extras_file = os.path.join(cfg_dir, "agy_extras_settings.json")
        with open(extras_file, "w", encoding="utf-8") as f:
            json.dump({"lang": "en", "showPlayer": False, "showContextRing": False}, f)
        with open(appearance_file, "w", encoding="utf-8") as f:
            json.dump({"lang": "en", "showTopTabBar": False, "paused": True}, f)

        with mock.patch("patcher_core.engine.get_antigravity_config_dir", return_value=cfg_dir), \
             mock.patch("patcher_core.engine._can_write_dir", return_value=False):
            eng.sync_user_configs(wallpaper_dir="", enabled_modules={"wallpaper": True, "media": True, "i18n": True, "accounts": True, "context": True})

        saved_ex = json.loads(open(extras_file, "r", encoding="utf-8").read())
        saved_app = json.loads(open(appearance_file, "r", encoding="utf-8").read())
        self.assertEqual(saved_ex["lang"], "en", "User EN lang in agy_extras_settings.json must survive re-patch")
        self.assertFalse(saved_ex["showPlayer"], "User showPlayer=False must survive re-patch")
        self.assertFalse(saved_ex["showContextRing"], "User showContextRing=False must survive re-patch")
        self.assertEqual(saved_app["lang"], "en", "User EN lang in agy_appearance.json must survive re-patch")
        self.assertFalse(saved_app["showTopTabBar"], "User showTopTabBar=False must survive re-patch")
        self.assertTrue(saved_app["paused"], "User paused=true must survive re-patch")

        # Lock path normalization keeps slashes consistent
        self.assertEqual(
            _normalize_lock_dir(os.path.join(cfg_dir, "")),
            _normalize_lock_dir(cfg_dir),
        )


if __name__ == "__main__":
    unittest.main()
