"""
Test Suite: ASAR Reader and Packer Integrity
"""

import os
import unittest
import tempfile
import hashlib

from patcher_core.asar_engine import AsarArchive, pack_asar_from_dict, compute_file_integrity


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


if __name__ == "__main__":
    unittest.main()
