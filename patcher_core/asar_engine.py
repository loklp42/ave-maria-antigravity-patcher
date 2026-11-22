"""
Chromium ASAR Archive Reader and Packer
Fully compliant with Electron / Chromium ASAR archive format.
Supports streaming extraction, repackaging, and SHA-256 integrity block generation.
"""

import os
import json
import struct
import hashlib
from typing import Dict, Any, Tuple, Optional, Callable

BLOCK_SIZE = 4 * 1024 * 1024  # 4 MB blocks for Electron integrity verification


def compute_file_integrity(data: bytes) -> Dict[str, Any]:
    """Computes Electron-compatible SHA256 integrity blocks."""
    total_hash = hashlib.sha256(data).hexdigest()
    blocks = []
    for i in range(0, len(data), BLOCK_SIZE):
        chunk = data[i : i + BLOCK_SIZE]
        blocks.append(hashlib.sha256(chunk).hexdigest())
    if not blocks:
        blocks.append(hashlib.sha256(b"").hexdigest())
    return {
        "algorithm": "SHA256",
        "hash": total_hash,
        "blockSize": BLOCK_SIZE,
        "blocks": blocks,
    }


class AsarArchive:
    def __init__(self, asar_path: str):
        self.asar_path = asar_path
        self.header: Dict[str, Any] = {}
        self.base_offset: int = 0
        self._read_header()

    def _read_header(self):
        with open(self.asar_path, "rb") as f:
            raw_h = f.read(16)
            if len(raw_h) < 16:
                raise ValueError("Invalid ASAR: file is too small")
            u1, total_size, payload_size, json_len = struct.unpack("<IIII", raw_h)
            if u1 != 4:
                raise ValueError(f"Unsupported ASAR format signature: {u1}")
            self.base_offset = 8 + total_size
            json_bytes = f.read(json_len)
            self.header = json.loads(json_bytes.decode("utf-8"))

    def list_files(self) -> Dict[str, Dict[str, Any]]:
        """Returns a flat dictionary of filepath -> file metadata."""
        out = {}

        def traverse(node: Dict[str, Any], prefix: str = ""):
            if "files" in node:
                for name, child in node["files"].items():
                    sub = f"{prefix}/{name}" if prefix else name
                    traverse(child, sub)
            else:
                out[prefix] = node

        traverse(self.header)
        return out

    def extract_file(self, internal_path: str) -> Optional[bytes]:
        """Extracts a single file by its relative path inside the archive."""
        parts = [p for p in internal_path.replace("\\", "/").strip("/").split("/") if p]
        curr = self.header
        for part in parts:
            if "files" not in curr or part not in curr["files"]:
                return None
            curr = curr["files"][part]

        if "offset" not in curr or "size" not in curr:
            return None

        offset = int(curr["offset"])
        size = int(curr["size"])

        with open(self.asar_path, "rb") as f:
            f.seek(self.base_offset + offset)
            return f.read(size)

    def extract_all(self, dest_dir: str, filter_fn: Optional[Callable[[str], bool]] = None):
        """Extracts all or filtered files from the archive to a destination directory."""
        files = self.list_files()
        with open(self.asar_path, "rb") as f:
            for rel_path, meta in files.items():
                if filter_fn and not filter_fn(rel_path):
                    continue
                offset = int(meta["offset"])
                size = int(meta["size"])
                f.seek(self.base_offset + offset)
                content = f.read(size)

                target = os.path.join(dest_dir, rel_path.replace("/", os.sep))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as out:
                    out.write(content)


def pack_asar_from_dict(
    files_dict: Dict[str, bytes],
    output_path: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
):
    """
    Packs a dictionary of {internal_path: bytes} into an ASAR file.
    Automatically generates valid Electron SHA-256 integrity metadata.
    """
    # 1. Build directory tree and metadata
    header_tree: Dict[str, Any] = {"files": {}}
    current_offset = 0

    sorted_paths = sorted(files_dict.keys())
    file_records = []

    for rel_path in sorted_paths:
        data = files_dict[rel_path]
        size = len(data)
        integrity = compute_file_integrity(data)

        # Navigate / build tree
        parts = [p for p in rel_path.replace("\\", "/").strip("/").split("/") if p]
        curr = header_tree
        for part in parts[:-1]:
            if part not in curr["files"]:
                curr["files"][part] = {"files": {}}
            curr = curr["files"][part]

        filename = parts[-1]
        curr["files"][filename] = {
            "size": size,
            "offset": str(current_offset),
            "integrity": integrity,
        }

        file_records.append((rel_path, data, current_offset))
        current_offset += size

    # 2. Serialize header JSON
    json_bytes = json.dumps(header_tree, separators=(",", ":")).encode("utf-8")
    json_len = len(json_bytes)

    # Chromium ASAR 4-byte padding alignment:
    # Header format: [4, total_size, payload_size, json_len] + json_bytes + padding
    # total_size = payload_size + 4
    # base_offset = 8 + total_size
    padding = (4 - (json_len % 4)) % 4
    total_size = json_len + padding + 8
    payload_size = total_size - 4

    header_bytes = (
        struct.pack("<IIII", 4, total_size, payload_size, json_len)
        + json_bytes
        + (b"\x00" * padding)
    )

    # 3. Write output file
    temp_output = output_path + ".tmp"
    with open(temp_output, "wb") as out_f:
        out_f.write(header_bytes)

        total_files = len(file_records)
        for idx, (path, data, _) in enumerate(file_records, 1):
            out_f.write(data)
            if progress_callback:
                progress_callback(idx, total_files, path)

    if os.path.exists(output_path):
        os.remove(output_path)
    os.rename(temp_output, output_path)
