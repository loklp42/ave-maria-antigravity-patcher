"""
Test Suite: Anchor Signatures and Patch Validation for 13 System Files
"""

import os
import unittest


class TestPatchAnchors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls.orig_dir = os.path.join(base, "customization", "original_system")
        cls.mod_dir = os.path.join(base, "customization", "patched_system")

    def test_main_js_anchors(self):
        with open(os.path.join(self.orig_dir, "main.js"), "r", encoding="utf-8") as f:
            orig = f.read()
        with open(os.path.join(self.mod_dir, "main.js"), "r", encoding="utf-8") as f:
            mod = f.read()

        # Origin anchors
        self.assertIn("requestSingleInstanceLock", orig)
        self.assertIn("showOrCreateWindow", orig)

        # Mod checks
        self.assertIn("require(\"./agyTabManager\")", mod)
        self.assertIn("configureLanguageServerPool", mod)

    def test_language_server_anchors(self):
        with open(os.path.join(self.orig_dir, "languageServer.js"), "r", encoding="utf-8") as f:
            orig = f.read()
        with open(os.path.join(self.mod_dir, "languageServer.js"), "r", encoding="utf-8") as f:
            mod = f.read()

        self.assertIn("exports.startAndMonitorLanguageServer", orig)
        self.assertIn("exports.configureLanguageServerPool", mod)
        self.assertIn("spawnIsolatedLanguageServer", mod)

    def test_paths_js_anchors(self):
        with open(os.path.join(self.orig_dir, "paths.js"), "r", encoding="utf-8") as f:
            orig = f.read()
        with open(os.path.join(self.mod_dir, "paths.js"), "r", encoding="utf-8") as f:
            mod = f.read()

        self.assertIn("function getAppDataDir()", orig)
        self.assertIn("exports.getActiveProfileName", mod)
        self.assertIn("getGeminiDirForProfile", mod)

    def test_utils_js_anchors(self):
        with open(os.path.join(self.orig_dir, "utils.js"), "r", encoding="utf-8") as f:
            orig = f.read()
        with open(os.path.join(self.mod_dir, "utils.js"), "r", encoding="utf-8") as f:
            mod = f.read()

        self.assertIn("exports.getHubWebContents", orig)
        self.assertIn("exports.getTabBarHeightForWindow", mod)
        self.assertIn("isTabHostWindow", mod)

    def test_wcv_browser_registry_anchors(self):
        with open(os.path.join(self.orig_dir, "wcvBrowserRegistry.js"), "r", encoding="utf-8") as f:
            orig = f.read()
        with open(os.path.join(self.mod_dir, "wcvBrowserRegistry.js"), "r", encoding="utf-8") as f:
            mod = f.read()

        self.assertIn("nextBounds = {", orig)
        self.assertIn("tabBarOffsetY", mod)


if __name__ == "__main__":
    unittest.main()
