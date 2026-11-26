"""
Test Suite: Anchor Signatures, Patch Parity, and Module Registry Invariants
for all 13 Patched System Files and 9 Autonomous Modules.
"""

import difflib
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from patcher_core import engine as py_engine


# Complete anchor contract for all 13/13 patched system files:
# file -> (required substrings in original_system, required substrings in patched_system)
ALL_SYSTEM_ANCHORS = {
    "authBootstrap.js": (
        ["setActiveLanguageServerAuth"],
        ["exports.mintBootstrapTokenForInstance = mintBootstrapTokenForInstance"],
    ),
    "customScheme.js": (
        ["exports.extensionAuthorities = new Map()"],
        [
            "exports.registerCustomSchemeHandlersForSession = registerCustomSchemeHandlersForSession",
            "exports.setExtensionAuthoritiesForSession = setExtensionAuthoritiesForSession",
            "isAllowedSidecarAuthorityUrl",
        ],
    ),
    "ipcHandlers.js": (
        ["localOnly('dialog:open-workspace'"],
        [
            'require("./agyAccounts")',
            'require("./agyTabManager")',
            "Unauthorized dialog:open-workspace sender",
            "Unauthorized dialog:open-workspaces sender",
            "setExtensionAuthoritiesForSession",
        ],
    ),
    "keybindings.js": (
        ["before-input-event"],
        ["hubContents.off?.('before-input-event', handleBeforeInput)"],
    ),
    "languageServer.js": (
        ["exports.startAndMonitorLanguageServer"],
        [
            "exports.configureLanguageServerPool",
            "spawnIsolatedLanguageServer",
            "Blocked non-OAuth openExternal from isolated LS",
            "const freshCsrf = crypto.randomUUID()",
        ],
    ),
    "lsDefaults.js": (
        ["baseLsArgs"],
        ["opts.overrideIdeName || 'antigravity'"],
    ),
    "main.js": (
        ["requestSingleInstanceLock", "showOrCreateWindow"],
        [
            'require("./agyTabManager")',
            "configureLanguageServerPool",
            "mendelFlagSync?.dispose?.()",
            "consumeOAuthInitiator",
        ],
    ),
    "paths.js": (
        ["function getAppDataDir()"],
        [
            "exports.getActiveProfileName",
            "getGeminiDirForProfile",
            "function isSubpathWithin",
        ],
    ),
    "storage.js": (
        ["getHubWebContents"],
        ["getAllHubWebContents"],
    ),
    "utils.js": (
        ["exports.getHubWebContents"],
        ["exports.getTabBarHeightForWindow", "isTabHostWindow"],
    ),
    "wcvBrowserRegistry.js": (
        ["nextBounds = {"],
        ["tabBarOffsetY"],
    ),
    "wcvIpcHandlers.js": (
        ["function isAuthorizedHubMainFrameEvent"],
        ["isRegisteredAccountTabWebContents"],
    ),
    "windowState.js": (
        ["scheduleSave"],
        ["win.off?.('resize', scheduleSave)"],
    ),
}


def _extract_rust_const_list(rs_source, const_name):
    m = re.search(rf"const\s+{const_name}\s*:\s*&\[&str\]\s*=\s*&\[(.*?)\];", rs_source, re.S)
    if not m:
        raise AssertionError(f"Could not find Rust const {const_name}")
    return re.findall(r'"([^"]+)"', m.group(1))


class TestPatchAnchors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.orig_dir = os.path.join(ROOT, "customization", "original_system")
        cls.mod_dir = os.path.join(ROOT, "customization", "patched_system")
        cls.patches_dir = os.path.join(ROOT, "customization", "patches")
        cls.modules_dir = os.path.join(ROOT, "customization", "modules")
        cls.rust_patcher_path = os.path.join(ROOT, "patcher", "src-tauri", "src", "patcher.rs")

    def test_all_13_system_file_anchors(self):
        self.assertEqual(len(ALL_SYSTEM_ANCHORS), 13, "Anchor contract must cover all 13 patched system files")
        for fname, (orig_anchors, mod_anchors) in ALL_SYSTEM_ANCHORS.items():
            orig_path = os.path.join(self.orig_dir, fname)
            mod_path = os.path.join(self.mod_dir, fname)
            self.assertTrue(os.path.isfile(orig_path), f"Missing original_system/{fname}")
            self.assertTrue(os.path.isfile(mod_path), f"Missing patched_system/{fname}")
            with open(orig_path, "r", encoding="utf-8") as f:
                orig = f.read()
            with open(mod_path, "r", encoding="utf-8") as f:
                mod = f.read()
            for anchor in orig_anchors:
                self.assertIn(anchor, orig, f"Missing original anchor {anchor!r} in {fname}")
            for anchor in mod_anchors:
                self.assertIn(anchor, mod, f"Missing patched anchor {anchor!r} in {fname}")

    def test_all_unified_patches_in_sync(self):
        """Every customization/patches/*.patch must match difflib(original_system, patched_system) exactly."""
        out_of_sync = []
        for fname in sorted(ALL_SYSTEM_ANCHORS.keys()):
            orig_path = os.path.join(self.orig_dir, fname)
            mod_path = os.path.join(self.mod_dir, fname)
            patch_path = os.path.join(self.patches_dir, f"{fname}.patch")
            if not os.path.isfile(patch_path):
                out_of_sync.append(f"{fname}.patch (missing)")
                continue
            with open(orig_path, "r", encoding="utf-8") as f:
                orig_lines = f.read().splitlines(keepends=True)
            with open(mod_path, "r", encoding="utf-8") as f:
                mod_lines = f.read().splitlines(keepends=True)
            expected = "".join(
                difflib.unified_diff(
                    orig_lines,
                    mod_lines,
                    fromfile=f"a/dist/{fname}",
                    tofile=f"b/dist/{fname}",
                )
            )
            with open(patch_path, "r", encoding="utf-8") as f:
                actual = f.read()
            if actual != expected:
                out_of_sync.append(f"{fname}.patch (diff mismatch: actual={len(actual)}B expected={len(expected)}B)")
        if out_of_sync:
            self.fail("Patches out of sync with original_system/patched_system:\n  " + "\n  ".join(out_of_sync))

    def test_autonomous_modules_and_patched_files_parity(self):
        """Rust patcher.rs, Python engine.py, and disk must list the exact same modules & system files."""
        with open(self.rust_patcher_path, "r", encoding="utf-8") as f:
            rs_src = f.read()

        rust_modules = sorted(_extract_rust_const_list(rs_src, "AUTONOMOUS_MODULES"))
        rust_patched = sorted(_extract_rust_const_list(rs_src, "PATCHED_SYSTEM_FILES"))
        py_modules = sorted(py_engine.AUTONOMOUS_MODULES)
        py_patched = sorted(py_engine.PATCHED_SYSTEM_FILES)
        disk_modules = sorted(f for f in os.listdir(self.modules_dir) if f.endswith(".js"))
        disk_patched = sorted(f for f in os.listdir(self.mod_dir) if f.endswith(".js"))
        anchor_files = sorted(ALL_SYSTEM_ANCHORS.keys())

        self.assertEqual(rust_modules, py_modules, "AUTONOMOUS_MODULES mismatch between Rust and Python")
        self.assertEqual(rust_modules, disk_modules, "AUTONOMOUS_MODULES mismatch between Rust and customization/modules/")
        self.assertEqual(len(disk_modules), 9, "Hard invariant: strictly 9 autonomous modules")

        self.assertEqual(rust_patched, py_patched, "PATCHED_SYSTEM_FILES mismatch between Rust and Python")
        self.assertEqual(rust_patched, disk_patched, "PATCHED_SYSTEM_FILES mismatch between Rust and customization/patched_system/")
        self.assertEqual(rust_patched, anchor_files, "ALL_SYSTEM_ANCHORS must cover every file in PATCHED_SYSTEM_FILES")


if __name__ == "__main__":
    unittest.main()
