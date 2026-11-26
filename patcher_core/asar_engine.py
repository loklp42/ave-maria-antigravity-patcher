"""
Chromium ASAR Archive Reader and Packer.
Fully compliant with Electron / Chromium ASAR archive format.
Supports streaming extraction, repackaging with unpacked/executable/symlink
and unpacked-directory metadata preservation, and SHA-256 integrity blocks.
"""

import os
import json
import time
import struct
import hashlib
from typing import Dict, Any, Tuple, Optional, Callable, Set

BLOCK_SIZE = 4 * 1024 * 1024  # 4 MB blocks for Electron integrity verification
MAX_HEADER_JSON_BYTES = 64 * 1024 * 1024  # 64 MiB anti-OOM ceiling
MAX_ENTRY_BYTES = 512 * 1024 * 1024  # 512 MiB single-entry ceiling


def _validate_node_name(name: str):
    if not name or name in (".", "..") or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError(f"Unsafe ASAR node name: {name!r}")


def _parse_int_field(
    meta: Dict[str, Any],
    key: str,
    rel_path: str,
    required: bool = True,
    default: int = 0,
) -> int:
    if key not in meta:
        if required:
            raise ValueError(f"Missing ASAR {key!r} for {rel_path}")
        return default
    val = meta[key]
    if isinstance(val, bool):
        raise ValueError(f"Invalid ASAR {key!r} (bool) for {rel_path}")
    if isinstance(val, int):
        parsed = val
    elif isinstance(val, str):
        parsed = int(val)
    else:
        raise ValueError(f"Invalid ASAR {key!r} type for {rel_path}")
    if parsed < 0:
        raise ValueError(f"Negative ASAR {key!r} for {rel_path}")
    return parsed


def _unique_tmp_path(target_path: str, suffix: str) -> str:
    parent = os.path.dirname(os.path.abspath(target_path)) or "."
    fname = os.path.basename(target_path) or "file"
    return os.path.join(parent, f".{fname}.{os.getpid()}.{time.time_ns()}.{suffix}")


def atomic_replace_with_retry(src: str, dst: str, max_attempts: int = 10):
    """Atomically replaces dst with src using os.replace with backoff against Windows AV/lock races."""
    delay = 0.05
    last_err: Optional[OSError] = None
    for attempt in range(1, max_attempts + 1):
        try:
            os.replace(src, dst)
            return
        except OSError as exc:
            winerr = getattr(exc, "winerror", None)
            retryable = isinstance(exc, PermissionError) or winerr in (5, 32, 33)
            if attempt < max_attempts and retryable:
                last_err = exc
                time.sleep(delay)
                delay = min(delay * 2, 0.4)
                continue
            raise
    if last_err:
        raise last_err


def atomic_copy_file(src: str, dst: str):
    """Atomically copies src to dst via sibling .tmp + fsync + atomic_replace_with_retry."""
    tmp_path = _unique_tmp_path(dst, "copy.tmp")
    try:
        with open(src, "rb") as rf, open(tmp_path, "wb") as wf:
            while True:
                chunk = rf.read(512 * 1024)
                if not chunk:
                    break
                wf.write(chunk)
            wf.flush()
            os.fsync(wf.fileno())
        atomic_replace_with_retry(tmp_path, dst)
        if os.name != "nt":
            try:
                os.chmod(dst, 0o644)
            except OSError:
                pass
    except BaseException:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_bytes(dst: str, data: bytes):
    """Atomically writes bytes to dst via sibling .tmp + fsync + atomic_replace_with_retry."""
    parent = os.path.dirname(os.path.abspath(dst))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_path = _unique_tmp_path(dst, "write.tmp")
    try:
        with open(tmp_path, "wb") as wf:
            wf.write(data)
            wf.flush()
            os.fsync(wf.fileno())
        atomic_replace_with_retry(tmp_path, dst)
        if os.name != "nt":
            try:
                os.chmod(dst, 0o644)
            except OSError:
                pass
    except BaseException:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise


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
        self.file_len: int = 0
        self._read_header()

    def _read_header(self):
        self.file_len = os.path.getsize(self.asar_path)
        with open(self.asar_path, "rb") as f:
            raw_h = f.read(16)
            if len(raw_h) < 16:
                raise ValueError("Invalid ASAR: file is too small")
            u1, total_size, payload_size, json_len = struct.unpack("<IIII", raw_h)
            if u1 != 4:
                raise ValueError(f"Unsupported ASAR format signature: {u1}")
            self.base_offset = 8 + total_size
            if (
                json_len > MAX_HEADER_JSON_BYTES
                or total_size < json_len + 8
                or self.base_offset > self.file_len
            ):
                raise ValueError(
                    f"Corrupted ASAR header (json_len={json_len}, total_size={total_size}, file_len={self.file_len})"
                )
            json_bytes = f.read(json_len)
            if len(json_bytes) != json_len:
                raise EOFError("Truncated ASAR JSON header")
            self.header = json.loads(json_bytes.decode("utf-8"))
            if not isinstance(self.header, dict) or not isinstance(self.header.get("files"), dict):
                raise ValueError("Invalid ASAR header: missing root 'files' object")

    def has_file(self, internal_path: str) -> bool:
        """Checks whether a non-directory entry exists in the header without reading payload bytes."""
        parts = [p for p in internal_path.replace("\\", "/").strip("/").split("/") if p]
        curr: Any = self.header
        for part in parts:
            if not isinstance(curr, dict):
                return False
            files = curr.get("files")
            if not isinstance(files, dict) or part not in files:
                return False
            curr = files[part]
        return isinstance(curr, dict) and "files" not in curr

    def verify_structural_bounds(self):
        """Verifies all node names are safe and every packed entry lies within file_len."""
        if not isinstance(self.header, dict) or not isinstance(self.header.get("files"), dict):
            raise ValueError("Invalid ASAR header: missing root 'files' object")

        def traverse(node: Dict[str, Any], prefix: str = ""):
            files = node.get("files")
            if not isinstance(files, dict):
                raise ValueError(f"Invalid ASAR directory node: {prefix or '<root>'}")
            for name, child in files.items():
                _validate_node_name(name)
                sub = f"{prefix}/{name}" if prefix else name
                if not isinstance(child, dict):
                    raise ValueError(f"Invalid ASAR entry metadata: {sub}")
                if "files" in child:
                    traverse(child, sub)
                elif "link" in child:
                    if not isinstance(child["link"], str):
                        raise ValueError(f"Invalid ASAR symlink target for {sub}")
                elif child.get("unpacked"):
                    if "size" in child:
                        _parse_int_field(child, "size", sub, required=True)
                else:
                    size = _parse_int_field(child, "size", sub, required=True)
                    offset = _parse_int_field(child, "offset", sub, required=(size > 0), default=0)
                    if size > MAX_ENTRY_BYTES or self.base_offset + offset + size > self.file_len:
                        raise EOFError(f"Truncated or out-of-bounds ASAR entry: {sub}")

        traverse(self.header)

    def list_files(self) -> Dict[str, Dict[str, Any]]:
        """Returns a flat dictionary of filepath -> file metadata."""
        out: Dict[str, Dict[str, Any]] = {}

        def traverse(node: Dict[str, Any], prefix: str = ""):
            if "files" in node:
                files = node["files"]
                if not isinstance(files, dict):
                    raise ValueError(f"Invalid ASAR directory node: {prefix or '<root>'}")
                for name, child in files.items():
                    _validate_node_name(name)
                    sub = f"{prefix}/{name}" if prefix else name
                    if not isinstance(child, dict):
                        raise ValueError(f"Invalid ASAR entry metadata: {sub}")
                    traverse(child, sub)
            else:
                out[prefix] = node

        traverse(self.header)
        return out

    def list_unpacked_dirs(self) -> Set[str]:
        """Returns a set of relative directory paths that carry `unpacked: true`."""
        out: Set[str] = set()

        def traverse(node: Dict[str, Any], prefix: str = ""):
            if "files" in node:
                if prefix and node.get("unpacked"):
                    out.add(prefix)
                for name, child in node["files"].items():
                    if isinstance(child, dict) and "files" in child:
                        sub = f"{prefix}/{name}" if prefix else name
                        traverse(child, sub)

        traverse(self.header)
        return out

    def read_all_entries(self) -> Tuple[Dict[str, Dict[str, Any]], Set[str]]:
        """
        Reads all archive entries preserving packed bytes, unpacked metadata,
        executable flags, symlinks, and unpacked directory markers.
        """
        files = self.list_files()
        unpacked_dirs = self.list_unpacked_dirs()
        entries: Dict[str, Dict[str, Any]] = {}

        with open(self.asar_path, "rb") as f:
            for rel_path, meta in files.items():
                if "link" in meta:
                    if not isinstance(meta["link"], str):
                        raise ValueError(f"Invalid ASAR symlink target for {rel_path}")
                    entries[rel_path] = {"kind": "symlink", "link": meta["link"]}
                elif meta.get("unpacked"):
                    entries[rel_path] = {
                        "kind": "unpacked",
                        "size": _parse_int_field(meta, "size", rel_path, required=False, default=0),
                        "executable": bool(meta.get("executable", False)),
                        "integrity": meta.get("integrity"),
                    }
                else:
                    size = _parse_int_field(meta, "size", rel_path, required=True)
                    offset = _parse_int_field(meta, "offset", rel_path, required=(size > 0), default=0)
                    if size > MAX_ENTRY_BYTES or self.base_offset + offset + size > self.file_len:
                        raise EOFError(f"ASAR entry out of bounds: {rel_path}")
                    if size > 0:
                        f.seek(self.base_offset + offset)
                        data = f.read(size)
                        if len(data) != size:
                            raise EOFError(f"Truncated ASAR entry: {rel_path} ({len(data)} < {size})")
                    else:
                        data = b""
                    entries[rel_path] = {
                        "kind": "packed",
                        "data": data,
                        "executable": bool(meta.get("executable", False)),
                    }
        return entries, unpacked_dirs

    def extract_file(self, internal_path: str) -> Optional[bytes]:
        """Extracts a single file by its relative path inside the archive."""
        parts = [p for p in internal_path.replace("\\", "/").strip("/").split("/") if p]
        curr = self.header
        for part in parts:
            if "files" not in curr or part not in curr["files"]:
                return None
            curr = curr["files"][part]

        if curr.get("unpacked") or "files" in curr or "link" in curr:
            return None

        size = _parse_int_field(curr, "size", internal_path, required=True)
        offset = _parse_int_field(curr, "offset", internal_path, required=(size > 0), default=0)
        if size > MAX_ENTRY_BYTES or self.base_offset + offset + size > self.file_len:
            raise EOFError(f"ASAR entry out of bounds: {internal_path}")

        with open(self.asar_path, "rb") as f:
            f.seek(self.base_offset + offset)
            data = f.read(size)
            if len(data) != size:
                raise EOFError(f"Truncated ASAR entry: {internal_path} ({len(data)} < {size})")
            return data

    def extract_all(self, dest_dir: str, filter_fn: Optional[Callable[[str], bool]] = None):
        """Extracts all or filtered files from the archive to a destination directory."""
        files = self.list_files()
        real_dest = os.path.realpath(dest_dir)
        os.makedirs(real_dest, exist_ok=True)
        with open(self.asar_path, "rb") as f:
            for rel_path, meta in files.items():
                if filter_fn and not filter_fn(rel_path):
                    continue
                if meta.get("unpacked") or "link" in meta:
                    continue
                size = _parse_int_field(meta, "size", rel_path, required=True)
                offset = _parse_int_field(meta, "offset", rel_path, required=(size > 0), default=0)
                if size > MAX_ENTRY_BYTES or self.base_offset + offset + size > self.file_len:
                    raise EOFError(f"ASAR entry out of bounds: {rel_path}")
                f.seek(self.base_offset + offset)
                content = f.read(size)
                if len(content) != size:
                    raise EOFError(f"Truncated ASAR entry: {rel_path} ({len(content)} < {size})")

                target = os.path.realpath(os.path.join(real_dest, rel_path.replace("/", os.sep)))
                if os.path.commonpath([real_dest, target]) != real_dest or target == real_dest:
                    raise ValueError(f"Unsafe ASAR path traversal blocked: {rel_path}")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as out:
                    out.write(content)


def pack_asar_from_entries(
    entries: Dict[str, Dict[str, Any]],
    output_path: str,
    unpacked_dirs: Optional[Set[str]] = None,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
):
    """
    Packs a dictionary of structured ASAR entries (`packed`, `unpacked`, `symlink`)
    preserving unpacked directories, executable flags, and SHA-256 integrity blocks.
    """
    header_tree: Dict[str, Any] = {"files": {}}
    current_offset = 0
    unpacked_set = unpacked_dirs or set()

    sorted_paths = sorted(entries.keys())
    payloads = []

    for rel_path in sorted_paths:
        entry = entries[rel_path]
        parts = [p for p in rel_path.replace("\\", "/").strip("/").split("/") if p]
        if not parts:
            continue
        for part in parts:
            _validate_node_name(part)

        curr = header_tree
        prefix = ""
        for part in parts[:-1]:
            prefix = f"{prefix}/{part}" if prefix else part
            if part not in curr["files"]:
                curr["files"][part] = {"files": {}}
            elif not isinstance(curr["files"][part], dict) or "files" not in curr["files"][part]:
                raise ValueError(f"ASAR path conflict: {prefix!r} is both a file and a directory")
            curr = curr["files"][part]
            if prefix in unpacked_set:
                curr["unpacked"] = True

        filename = parts[-1]
        if filename in curr["files"]:
            raise ValueError(f"ASAR path conflict: {rel_path!r} collides with an existing file or directory")
        kind = entry.get("kind", "packed")
        if kind == "symlink":
            curr["files"][filename] = {"link": entry["link"]}
        elif kind == "unpacked":
            meta: Dict[str, Any] = {
                "size": int(entry.get("size", 0)),
                "unpacked": True,
            }
            if entry.get("executable"):
                meta["executable"] = True
            if entry.get("integrity") is not None:
                meta["integrity"] = entry["integrity"]
            curr["files"][filename] = meta
        else:
            data = entry["data"]
            size = len(data)
            meta = {
                "size": size,
                "offset": str(current_offset),
                "integrity": compute_file_integrity(data),
            }
            if entry.get("executable"):
                meta["executable"] = True
            curr["files"][filename] = meta
            payloads.append((rel_path, data))
            current_offset += size

    json_bytes = json.dumps(header_tree, separators=(",", ":")).encode("utf-8")
    json_len = len(json_bytes)
    if json_len > MAX_HEADER_JSON_BYTES:
        raise ValueError(f"ASAR JSON header exceeds ceiling ({json_len} > {MAX_HEADER_JSON_BYTES})")
    padding = (4 - (json_len % 4)) % 4
    total_size = json_len + padding + 8
    payload_size = total_size - 4
    if total_size > 0xFFFFFFFF or payload_size > 0xFFFFFFFF:
        raise OverflowError("ASAR header size exceeds u32 limit")

    header_bytes = (
        struct.pack("<IIII", 4, total_size, payload_size, json_len)
        + json_bytes
        + (b"\x00" * padding)
    )

    temp_output = _unique_tmp_path(output_path, "asar.tmp")
    try:
        with open(temp_output, "wb") as out_f:
            out_f.write(header_bytes)
            total_files = len(payloads)
            for idx, (rel_path, data) in enumerate(payloads, 1):
                if data:
                    out_f.write(data)
                if progress_callback:
                    progress_callback(idx, total_files, rel_path)
            out_f.flush()
            os.fsync(out_f.fileno())

        atomic_replace_with_retry(temp_output, output_path)
        if os.name != "nt":
            try:
                os.chmod(output_path, 0o644)
            except OSError:
                pass
    except BaseException:
        try:
            if os.path.exists(temp_output):
                os.remove(temp_output)
        except OSError:
            pass
        raise


def pack_asar_from_dict(
    files_dict: Dict[str, bytes],
    output_path: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
):
    """
    Packs a dictionary of {internal_path: bytes} into an ASAR file.
    Automatically generates valid Electron SHA-256 integrity metadata.
    """
    entries = {
        rel_path: {"kind": "packed", "data": data, "executable": False}
        for rel_path, data in files_dict.items()
    }
    pack_asar_from_entries(entries, output_path, progress_callback=progress_callback)
