//! Chromium ASAR archive reader and writer.
//!
//! Supports streaming single-file lookups, full archive repacking with
//! `unpacked`/`executable`/symlink metadata preservation, and Electron-compatible
//! 4 MiB SHA-256 integrity block computation.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufWriter, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BLOCK_SIZE: usize = 4 * 1024 * 1024; // 4 MB Electron integrity block size
const MAX_HEADER_JSON_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB anti-OOM ceiling
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB single-entry ceiling

struct TmpFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TmpFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TmpFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn unique_tmp_path(target: &Path, suffix: &str) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let fname = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    parent.join(format!(".{fname}.{}.{nanos}.{suffix}", std::process::id()))
}

fn is_retryable_replace_error(err: &std::io::Error) -> bool {
    if err.kind() == ErrorKind::PermissionDenied {
        return true;
    }
    #[cfg(windows)]
    {
        if let Some(code) = err.raw_os_error() {
            // ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33)
            return matches!(code, 5 | 32 | 33);
        }
    }
    false
}

/// Atomically replaces `dst` with `src` (same filesystem) with exponential backoff
/// against transient Windows AV / Explorer sharing violations (OS error 5 / 32 / 33).
pub fn atomic_replace_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    let mut delay_ms: u64 = 50;
    let max_attempts = 10;
    let mut last_err = None;
    for attempt in 1..=max_attempts {
        match fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < max_attempts && is_retryable_replace_error(&e) => {
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(400);
            }
            Err(e) => {
                return Err(format!(
                    "Ошибка атомарной замены {} -> {}: {e}",
                    src.display(),
                    dst.display()
                ));
            }
        }
    }
    Err(format!(
        "Не удалось заменить {} после {max_attempts} попыток: {}",
        dst.display(),
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "неизвестная ошибка".to_string())
    ))
}

/// Atomically copies `src` to `dst` via sibling `.tmp` + `sync_all()` + `atomic_replace_with_retry`.
pub fn atomic_copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    let tmp_path = unique_tmp_path(dst, "copy.tmp");
    let mut guard = TmpFileGuard::new(tmp_path.clone());
    {
        let mut reader = File::open(src)
            .map_err(|e| format!("Не удалось открыть исходный файл {}: {e}", src.display()))?;
        let mut writer = File::create(&tmp_path)
            .map_err(|e| format!("Не удалось создать временный файл {}: {e}", tmp_path.display()))?;
        std::io::copy(&mut reader, &mut writer)
            .map_err(|e| format!("Ошибка копирования {}: {e}", src.display()))?;
        writer
            .sync_all()
            .map_err(|e| format!("Ошибка sync_all при копировании: {e}"))?;
    }
    atomic_replace_with_retry(&tmp_path, dst)?;
    guard.disarm();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dst, fs::Permissions::from_mode(0o644));
    }
    Ok(())
}

/// Atomically writes `data` to `dst` via sibling `.tmp` + `sync_all()` + `atomic_replace_with_retry`.
pub fn atomic_write_bytes(dst: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Не удалось создать каталог {}: {e}", parent.display()))?;
        }
    }
    let tmp_path = unique_tmp_path(dst, "write.tmp");
    let mut guard = TmpFileGuard::new(tmp_path.clone());
    {
        let mut file = File::create(&tmp_path)
            .map_err(|e| format!("Не удалось создать временный файл {}: {e}", tmp_path.display()))?;
        file.write_all(data)
            .map_err(|e| format!("Ошибка записи {}: {e}", tmp_path.display()))?;
        file.sync_all()
            .map_err(|e| format!("Ошибка sync_all {}: {e}", tmp_path.display()))?;
    }
    atomic_replace_with_retry(&tmp_path, dst)?;
    guard.disarm();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dst, fs::Permissions::from_mode(0o644));
    }
    Ok(())
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(format!("Недопустимое имя узла ASAR: {name:?}"));
    }
    Ok(())
}

#[derive(Clone)]
pub enum AsarEntry {
    Packed {
        data: Vec<u8>,
        executable: bool,
    },
    Unpacked {
        size: u64,
        executable: bool,
        integrity: Option<Value>,
    },
    Symlink {
        link: String,
    },
}

pub struct AsarArchive {
    path: PathBuf,
    header: Value,
    base_offset: u64,
    file_len: u64,
}

impl AsarArchive {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let mut f = File::open(&path).map_err(|e| format!("Не удалось открыть ASAR: {e}"))?;
        let file_len = f
            .metadata()
            .map_err(|e| format!("Ошибка stat ASAR: {e}"))?
            .len();

        let mut hdr = [0u8; 16];
        f.read_exact(&mut hdr)
            .map_err(|e| format!("Некорректный заголовок ASAR: {e}"))?;

        let u1 = u32::from_le_bytes(hdr[0..4].try_into().unwrap());
        let total_size = u32::from_le_bytes(hdr[4..8].try_into().unwrap());
        let _payload_size = u32::from_le_bytes(hdr[8..12].try_into().unwrap());
        let json_len = u32::from_le_bytes(hdr[12..16].try_into().unwrap());

        if u1 != 4 {
            return Err(format!("Неподдерживаемая сигнатура ASAR: {u1}"));
        }

        let base_offset = 8u64
            .checked_add(total_size as u64)
            .ok_or_else(|| "Переполнение размера заголовка ASAR".to_string())?;
        if (json_len as u64) > MAX_HEADER_JSON_BYTES
            || (total_size as u64) < (json_len as u64).saturating_add(8)
            || base_offset > file_len
        {
            return Err(format!(
                "Повреждённый заголовок ASAR (json_len={json_len}, total_size={total_size}, file_len={file_len})"
            ));
        }

        let alloc_len = usize::try_from(json_len)
            .map_err(|_| "Размер JSON-заголовка ASAR превышает usize".to_string())?;
        let mut json_buf = vec![0u8; alloc_len];
        f.read_exact(&mut json_buf)
            .map_err(|e| format!("Ошибка чтения JSON-заголовка ASAR: {e}"))?;

        let header: Value = serde_json::from_slice(&json_buf)
            .map_err(|e| format!("Ошибка парсинга JSON-заголовка ASAR: {e}"))?;
        if header.get("files").and_then(|v| v.as_object()).is_none() {
            return Err("Некорректный заголовок ASAR: отсутствует корневой объект files".to_string());
        }

        Ok(Self {
            path,
            header,
            base_offset,
            file_len,
        })
    }

    /// Walks header metadata without loading payloads to verify every packed entry
    /// lies within `[base_offset, file_len]` and all node names are safe.
    pub fn verify_structural_bounds(&self) -> Result<(), String> {
        let Some(files) = self.header.get("files").and_then(|v| v.as_object()) else {
            return Err("Некорректный заголовок ASAR: отсутствует корневой объект files".to_string());
        };
        self.verify_files_map_bounds(files, "")
    }

    fn verify_files_map_bounds(
        &self,
        files: &Map<String, Value>,
        prefix: &str,
    ) -> Result<(), String> {
        for (name, item) in files {
            validate_entry_name(name)?;
            let full_path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Some(item_obj) = item.as_object() else {
                return Err(format!("Некорректный узел ASAR для {full_path}"));
            };
            if let Some(sub_files_val) = item_obj.get("files") {
                let Some(sub_files) = sub_files_val.as_object() else {
                    return Err(format!("Некорректный каталог ASAR для {full_path}"));
                };
                self.verify_files_map_bounds(sub_files, &full_path)?;
            } else if let Some(link_val) = item_obj.get("link") {
                if !link_val.is_string() {
                    return Err(format!("Некорректный symlink link для {full_path}"));
                }
            } else if item_obj
                .get("unpacked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                if let Some(sz) = item_obj.get("size") {
                    let _ = parse_size(Some(sz), &full_path)?;
                }
            } else {
                let size = parse_size(item_obj.get("size"), &full_path)?;
                let offset = parse_offset_for_entry(item_obj.get("offset"), &full_path, size > 0)?;
                let start = self
                    .base_offset
                    .checked_add(offset)
                    .ok_or_else(|| format!("Переполнение offset для {full_path}"))?;
                let end = start
                    .checked_add(size)
                    .ok_or_else(|| format!("Переполнение size для {full_path}"))?;
                if size > MAX_ENTRY_BYTES || end > self.file_len {
                    return Err(format!(
                        "Усечённый или повреждённый ASAR: запись {full_path} выходит за пределы файла ({end} > {})",
                        self.file_len
                    ));
                }
            }
        }
        Ok(())
    }

    fn lookup_node(&self, rel_path: &str) -> Option<&Value> {
        let mut curr = &self.header;
        for part in rel_path.replace('\\', "/").split('/').filter(|p| !p.is_empty()) {
            curr = curr.get("files")?.get(part)?;
        }
        Some(curr)
    }

    pub fn has_file(&self, rel_path: &str) -> bool {
        self.lookup_node(rel_path)
            .map(|n| n.get("files").is_none())
            .unwrap_or(false)
    }

    pub fn read_file(&self, rel_path: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(node) = self.lookup_node(rel_path) else {
            return Ok(None);
        };
        if node.get("unpacked").and_then(|v| v.as_bool()).unwrap_or(false)
            || node.get("files").is_some()
            || node.get("link").is_some()
        {
            return Ok(None);
        }
        let size = parse_size(node.get("size"), rel_path)?;
        let offset = parse_offset_for_entry(node.get("offset"), rel_path, size > 0)?;

        let mut f = File::open(&self.path).map_err(|e| format!("Ошибка открытия ASAR: {e}"))?;
        let file_len = f
            .metadata()
            .map_err(|e| format!("Ошибка stat ASAR: {e}"))?
            .len();
        let start = self
            .base_offset
            .checked_add(offset)
            .ok_or_else(|| format!("Переполнение offset для {rel_path}"))?;
        let end = start
            .checked_add(size)
            .ok_or_else(|| format!("Переполнение size для {rel_path}"))?;
        if size > MAX_ENTRY_BYTES || end > file_len {
            return Err(format!("Запись {rel_path} выходит за пределы ASAR"));
        }
        let alloc_len = usize::try_from(size)
            .map_err(|_| format!("Размер файла {rel_path} превышает usize"))?;
        f.seek(SeekFrom::Start(start))
            .map_err(|e| format!("Ошибка seek в ASAR: {e}"))?;
        let mut buf = vec![0u8; alloc_len];
        if size > 0 {
            f.read_exact(&mut buf)
                .map_err(|e| format!("Ошибка чтения файла {rel_path}: {e}"))?;
        }
        Ok(Some(buf))
    }

    pub fn read_all_entries(&self) -> Result<BTreeMap<String, AsarEntry>, String> {
        let mut f = File::open(&self.path).map_err(|e| format!("Ошибка открытия ASAR: {e}"))?;
        let mut out = BTreeMap::new();
        self.traverse_node(&self.header, "", &mut f, &mut out)?;
        Ok(out)
    }

    pub fn read_unpacked_dirs(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        collect_unpacked_dirs(&self.header, "", &mut out);
        out
    }

    fn traverse_node(
        &self,
        node: &Value,
        prefix: &str,
        file: &mut File,
        out: &mut BTreeMap<String, AsarEntry>,
    ) -> Result<(), String> {
        let Some(files) = node.get("files").and_then(|v| v.as_object()) else {
            return Ok(());
        };

        for (name, item) in files {
            validate_entry_name(name)?;
            let full_path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };

            if let Some(sub_files_val) = item.get("files") {
                if !sub_files_val.is_object() {
                    return Err(format!("Некорректный каталог ASAR для {full_path}"));
                }
                self.traverse_node(item, &full_path, file, out)?;
            } else if let Some(link) = item.get("link").and_then(|v| v.as_str()) {
                out.insert(
                    full_path,
                    AsarEntry::Symlink {
                        link: link.to_string(),
                    },
                );
            } else if item.get("link").is_some() {
                return Err(format!("Некорректный symlink link для {full_path}"));
            } else {
                let executable = item
                    .get("executable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if item.get("unpacked").and_then(|v| v.as_bool()).unwrap_or(false) {
                    let size = match item.get("size") {
                        Some(v) => parse_size(Some(v), &full_path)?,
                        None => 0,
                    };
                    out.insert(
                        full_path,
                        AsarEntry::Unpacked {
                            size,
                            executable,
                            integrity: item.get("integrity").cloned(),
                        },
                    );
                } else {
                    let size = parse_size(item.get("size"), &full_path)?;
                    let offset = parse_offset_for_entry(item.get("offset"), &full_path, size > 0)?;
                    let start = self
                        .base_offset
                        .checked_add(offset)
                        .ok_or_else(|| format!("Переполнение offset в ASAR для {full_path}"))?;
                    let end = start
                        .checked_add(size)
                        .ok_or_else(|| format!("Переполнение size в ASAR для {full_path}"))?;
                    if size > MAX_ENTRY_BYTES || end > self.file_len {
                        return Err(format!("Запись {full_path} выходит за пределы ASAR"));
                    }
                    let alloc_len = usize::try_from(size)
                        .map_err(|_| format!("Размер файла {full_path} превышает usize"))?;
                    let mut buf = vec![0u8; alloc_len];
                    if size > 0 {
                        file.seek(SeekFrom::Start(start))
                            .map_err(|e| format!("Ошибка seek {full_path}: {e}"))?;
                        file.read_exact(&mut buf)
                            .map_err(|e| format!("Ошибка чтения {full_path}: {e}"))?;
                    }
                    out.insert(
                        full_path,
                        AsarEntry::Packed {
                            data: buf,
                            executable,
                        },
                    );
                }
            }
        }
        Ok(())
    }
}

fn collect_unpacked_dirs(node: &Value, prefix: &str, out: &mut BTreeSet<String>) {
    let Some(files) = node.get("files").and_then(|v| v.as_object()) else {
        return;
    };
    for (name, item) in files {
        if item.get("files").is_some() {
            let full_path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if item.get("unpacked").and_then(|v| v.as_bool()).unwrap_or(false) {
                out.insert(full_path.clone());
            }
            collect_unpacked_dirs(item, &full_path, out);
        }
    }
}

fn parse_offset_for_entry(
    val: Option<&Value>,
    path: &str,
    required: bool,
) -> Result<u64, String> {
    match val {
        Some(Value::String(s)) => s
            .parse::<u64>()
            .map_err(|e| format!("Некорректный offset '{s}' для {path}: {e}")),
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| format!("Некорректный числовой offset для {path}")),
        None if !required => Ok(0),
        None => Err(format!("Отсутствует поле offset для {path}")),
        _ => Err(format!("Неподдерживаемый тип offset для {path}")),
    }
}

fn parse_size(val: Option<&Value>, path: &str) -> Result<u64, String> {
    match val {
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| format!("Некорректный размер файла {path} в ASAR")),
        Some(Value::String(s)) => s
            .parse::<u64>()
            .map_err(|_| format!("Некорректный строковый размер {path} в ASAR")),
        None => Err(format!("Отсутствует поле size для {path} в ASAR")),
        _ => Err(format!("Неподдерживаемый тип size для {path} в ASAR")),
    }
}

pub fn compute_integrity(data: &[u8]) -> Value {
    let mut total_hasher = Sha256::new();
    total_hasher.update(data);
    let total_hash = hex::encode(total_hasher.finalize());

    let mut blocks = Vec::new();
    if data.is_empty() {
        let empty_hash = hex::encode(Sha256::digest([]));
        blocks.push(Value::String(empty_hash));
    } else {
        for chunk in data.chunks(BLOCK_SIZE) {
            let h = hex::encode(Sha256::digest(chunk));
            blocks.push(Value::String(h));
        }
    }

    let mut obj = Map::new();
    obj.insert("algorithm".into(), Value::String("SHA256".into()));
    obj.insert("hash".into(), Value::String(total_hash));
    obj.insert("blockSize".into(), Value::from(BLOCK_SIZE as u64));
    obj.insert("blocks".into(), Value::Array(blocks));
    Value::Object(obj)
}

pub fn sha256_file<P: AsRef<Path>>(path: P) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("Ошибка чтения для SHA-256: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("Ошибка чтения: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[allow(dead_code)]
pub fn write_asar<P: AsRef<Path>>(
    output_path: P,
    entries: &BTreeMap<String, AsarEntry>,
) -> Result<(), String> {
    write_asar_with_unpacked_dirs(output_path, entries, &BTreeSet::new())
}

pub fn write_asar_with_unpacked_dirs<P: AsRef<Path>>(
    output_path: P,
    entries: &BTreeMap<String, AsarEntry>,
    unpacked_dirs: &BTreeSet<String>,
) -> Result<(), String> {
    let mut root = Map::new();
    root.insert("files".into(), Value::Object(Map::new()));

    let mut current_offset: u64 = 0;
    let mut payloads: Vec<&[u8]> = Vec::new();

    for (rel_path, entry) in entries {
        let normalized = rel_path.replace('\\', "/");
        let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        for part in &parts {
            validate_entry_name(part)?;
        }
        let filename = parts[parts.len() - 1];
        let dirs = &parts[..parts.len() - 1];

        let mut curr = &mut root;
        let mut dir_prefix = String::new();
        for dir in dirs {
            if !dir_prefix.is_empty() {
                dir_prefix.push('/');
            }
            dir_prefix.push_str(dir);
            let is_unpacked_dir = unpacked_dirs.contains(&dir_prefix);
            let files_map = curr
                .entry("files")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or("Некорректная структура дерева ASAR")?;
            if let Some(existing) = files_map.get(*dir) {
                if existing.get("files").and_then(|v| v.as_object()).is_none() {
                    return Err(format!(
                        "Конфликт путей в ASAR: '{dir_prefix}' уже существует как файл"
                    ));
                }
            }
            let next = files_map.entry((*dir).to_string()).or_insert_with(|| {
                let mut m = Map::new();
                m.insert("files".into(), Value::Object(Map::new()));
                Value::Object(m)
            });
            curr = next
                .as_object_mut()
                .ok_or("Некорректная директория в дереве ASAR")?;
            if is_unpacked_dir {
                curr.insert("unpacked".into(), Value::Bool(true));
            }
        }

        let files_map = curr
            .entry("files")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or("Некорректный узел files")?;
        if files_map.contains_key(filename) {
            return Err(format!(
                "Конфликт путей в ASAR: '{rel_path}' пересекается с существующим узлом"
            ));
        }

        let mut meta = Map::new();
        match entry {
            AsarEntry::Packed { data, executable } => {
                meta.insert("size".into(), Value::from(data.len() as u64));
                meta.insert("offset".into(), Value::String(current_offset.to_string()));
                meta.insert("integrity".into(), compute_integrity(data));
                if *executable {
                    meta.insert("executable".into(), Value::Bool(true));
                }
                payloads.push(data.as_slice());
                current_offset = current_offset
                    .checked_add(data.len() as u64)
                    .ok_or_else(|| "Переполнение смещения ASAR".to_string())?;
            }
            AsarEntry::Unpacked {
                size,
                executable,
                integrity,
            } => {
                meta.insert("size".into(), Value::from(*size));
                meta.insert("unpacked".into(), Value::Bool(true));
                if *executable {
                    meta.insert("executable".into(), Value::Bool(true));
                }
                if let Some(int) = integrity {
                    meta.insert("integrity".into(), int.clone());
                }
            }
            AsarEntry::Symlink { link } => {
                meta.insert("link".into(), Value::String(link.clone()));
            }
        }
        files_map.insert(filename.to_string(), Value::Object(meta));
    }

    let mut json_bytes = serde_json::to_vec(&Value::Object(root))
        .map_err(|e| format!("Ошибка сериализации заголовка ASAR: {e}"))?;
    if (json_bytes.len() as u64) > MAX_HEADER_JSON_BYTES {
        return Err("Размер JSON-заголовка ASAR превышает допустимый лимит".to_string());
    }
    let json_len = u32::try_from(json_bytes.len())
        .map_err(|_| "Размер JSON-заголовка ASAR превышает u32".to_string())?;
    let padding = (4 - (json_bytes.len() % 4)) % 4;
    json_bytes.resize(json_bytes.len() + padding, 0u8);

    let total_size = json_len
        .checked_add(padding as u32)
        .and_then(|v| v.checked_add(8))
        .ok_or_else(|| "Переполнение total_size заголовка ASAR".to_string())?;
    let payload_size = total_size
        .checked_sub(4)
        .ok_or_else(|| "Переполнение payload_size заголовка ASAR".to_string())?;

    let out_path = output_path.as_ref();
    let tmp_path = unique_tmp_path(out_path, "asar.tmp");
    let mut guard = TmpFileGuard::new(tmp_path.clone());

    {
        let file = File::create(&tmp_path)
            .map_err(|e| format!("Не удалось создать временный ASAR: {e}"))?;
        let mut writer = BufWriter::with_capacity(512 * 1024, file);

        writer
            .write_all(&4u32.to_le_bytes())
            .and_then(|_| writer.write_all(&total_size.to_le_bytes()))
            .and_then(|_| writer.write_all(&payload_size.to_le_bytes()))
            .and_then(|_| writer.write_all(&json_len.to_le_bytes()))
            .and_then(|_| writer.write_all(&json_bytes))
            .map_err(|e| format!("Ошибка записи заголовка ASAR: {e}"))?;

        for data in payloads {
            if !data.is_empty() {
                writer
                    .write_all(data)
                    .map_err(|e| format!("Ошибка записи данных ASAR: {e}"))?;
            }
        }
        writer
            .flush()
            .map_err(|e| format!("Ошибка flush ASAR: {e}"))?;
        let file = writer
            .into_inner()
            .map_err(|e| format!("Ошибка финализации буфера ASAR: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Ошибка sync_all ASAR: {e}"))?;
    }

    atomic_replace_with_retry(&tmp_path, out_path)?;
    guard.disarm();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(out_path, fs::Permissions::from_mode(0o644));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asar_roundtrip_preserves_packed_and_unpacked_entries() {
        let tmp = std::env::temp_dir().join("agy_test_roundtrip.asar");
        let mut entries = BTreeMap::new();
        entries.insert(
            "package.json".to_string(),
            AsarEntry::Packed {
                data: br#"{"version":"2.34.0"}"#.to_vec(),
                executable: false,
            },
        );
        entries.insert(
            "dist/main.js".to_string(),
            AsarEntry::Packed {
                data: b"console.log('ok');".to_vec(),
                executable: true,
            },
        );
        entries.insert(
            "node_modules/native/addon.node".to_string(),
            AsarEntry::Unpacked {
                size: 4096,
                executable: true,
                integrity: None,
            },
        );

        write_asar(&tmp, &entries).expect("write_asar failed");
        let archive = AsarArchive::open(&tmp).expect("open failed");
        assert!(archive.has_file("package.json"));
        assert!(archive.has_file("dist/main.js"));
        assert!(archive.has_file("node_modules/native/addon.node"));

        let pkg = archive.read_file("package.json").unwrap().unwrap();
        assert_eq!(pkg, br#"{"version":"2.34.0"}"#);

        let all = archive.read_all_entries().unwrap();
        assert!(matches!(
            all.get("node_modules/native/addon.node"),
            Some(AsarEntry::Unpacked { size: 4096, executable: true, .. })
        ));
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn asar_roundtrip_preserves_unpacked_dirs_and_symlinks() {
        let tmp = std::env::temp_dir().join("agy_test_unpacked_dirs.asar");
        let mut entries = BTreeMap::new();
        entries.insert(
            "node_modules/chrome-devtools-mcp/bin/cli.js".to_string(),
            AsarEntry::Unpacked {
                size: 128,
                executable: true,
                integrity: None,
            },
        );
        entries.insert(
            "bin/link".to_string(),
            AsarEntry::Symlink {
                link: "../target".to_string(),
            },
        );
        let mut unpacked_dirs = BTreeSet::new();
        unpacked_dirs.insert("node_modules/chrome-devtools-mcp".to_string());

        write_asar_with_unpacked_dirs(&tmp, &entries, &unpacked_dirs)
            .expect("write_asar_with_unpacked_dirs failed");
        let archive = AsarArchive::open(&tmp).expect("open failed");
        let read_dirs = archive.read_unpacked_dirs();
        assert!(read_dirs.contains("node_modules/chrome-devtools-mcp"));
        let all = archive.read_all_entries().unwrap();
        assert!(matches!(
            all.get("bin/link"),
            Some(AsarEntry::Symlink { link }) if link == "../target"
        ));
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn asar_rejects_oom_header_and_truncated_payload() {
        // 1. Malicious 16-byte header claiming json_len = 0xFFFFFFFF must return Err, not OOM abort
        let oom_path = std::env::temp_dir().join("agy_test_oom_hdr.asar");
        let mut bad_hdr = Vec::new();
        bad_hdr.extend_from_slice(&4u32.to_le_bytes());
        bad_hdr.extend_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        bad_hdr.extend_from_slice(&0xFFFFFFFBu32.to_le_bytes());
        bad_hdr.extend_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        fs::write(&oom_path, &bad_hdr).unwrap();
        assert!(AsarArchive::open(&oom_path).is_err(), "OOM header must be rejected");
        let _ = fs::remove_file(&oom_path);

        // 2. Truncated archive (valid header, truncated payload) must fail verify_structural_bounds
        let trunc_path = std::env::temp_dir().join("agy_test_truncated.asar");
        let mut entries = BTreeMap::new();
        entries.insert(
            "dist/main.js".to_string(),
            AsarEntry::Packed {
                data: vec![b'x'; 4096],
                executable: false,
            },
        );
        write_asar(&trunc_path, &entries).unwrap();
        let full_bytes = fs::read(&trunc_path).unwrap();
        // Keep header intact, cut payload in half
        fs::write(&trunc_path, &full_bytes[..full_bytes.len() - 2048]).unwrap();
        let arc = AsarArchive::open(&trunc_path).expect("header itself is intact");
        assert!(
            arc.verify_structural_bounds().is_err(),
            "Truncated payload must fail verify_structural_bounds"
        );
        let _ = fs::remove_file(&trunc_path);
    }

    #[test]
    fn asar_rejects_path_traversal_node_names() {
        let bad_path = std::env::temp_dir().join("agy_test_traversal.asar");
        let mut json_bytes = br#"{"files":{"..":{"size":1,"offset":"0"}}}"#.to_vec();
        let json_len = json_bytes.len() as u32;
        let padding = (4 - (json_bytes.len() % 4)) % 4;
        json_bytes.resize(json_bytes.len() + padding, 0u8);
        let total_size = json_len + (padding as u32) + 8;
        let payload_size = total_size - 4;
        let mut raw = Vec::new();
        raw.extend_from_slice(&4u32.to_le_bytes());
        raw.extend_from_slice(&total_size.to_le_bytes());
        raw.extend_from_slice(&payload_size.to_le_bytes());
        raw.extend_from_slice(&json_len.to_le_bytes());
        raw.extend_from_slice(&json_bytes);
        raw.push(b'A');
        fs::write(&bad_path, &raw).unwrap();

        let arc = AsarArchive::open(&bad_path).unwrap();
        assert!(arc.verify_structural_bounds().is_err());
        assert!(arc.read_all_entries().is_err());
        let _ = fs::remove_file(&bad_path);
    }

    #[test]
    fn atomic_copy_and_write_replace_existing_target() {
        let dir = std::env::temp_dir();
        let src = dir.join("agy_test_atomic_src.bin");
        let dst = dir.join("agy_test_atomic_dst.bin");
        fs::write(&src, b"new-payload-12345").unwrap();
        fs::write(&dst, b"old-payload").unwrap();

        atomic_copy_file(&src, &dst).expect("atomic_copy_file failed");
        assert_eq!(fs::read(&dst).unwrap(), b"new-payload-12345");

        atomic_write_bytes(&dst, br#"{"ok":true}"#).expect("atomic_write_bytes failed");
        assert_eq!(fs::read(&dst).unwrap(), br#"{"ok":true}"#);

        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dst);
    }

    #[test]
    fn asar_rejects_missing_root_files_and_path_collision() {
        let missing_files_path = std::env::temp_dir().join("agy_test_missing_files.asar");
        let mut json_bytes = br#"{"other":{}}"#.to_vec();
        let json_len = json_bytes.len() as u32;
        let padding = (4 - (json_bytes.len() % 4)) % 4;
        json_bytes.resize(json_bytes.len() + padding, 0u8);
        let total_size = json_len + (padding as u32) + 8;
        let payload_size = total_size - 4;
        let mut raw = Vec::new();
        raw.extend_from_slice(&4u32.to_le_bytes());
        raw.extend_from_slice(&total_size.to_le_bytes());
        raw.extend_from_slice(&payload_size.to_le_bytes());
        raw.extend_from_slice(&json_len.to_le_bytes());
        raw.extend_from_slice(&json_bytes);
        fs::write(&missing_files_path, &raw).unwrap();
        assert!(
            AsarArchive::open(&missing_files_path).is_err(),
            "ASAR header missing root 'files' object must be rejected"
        );
        let _ = fs::remove_file(&missing_files_path);

        let coll_path = std::env::temp_dir().join("agy_test_collision.asar");
        let mut entries = BTreeMap::new();
        entries.insert(
            "a".to_string(),
            AsarEntry::Packed {
                data: b"file".to_vec(),
                executable: false,
            },
        );
        entries.insert(
            "a/b".to_string(),
            AsarEntry::Packed {
                data: b"nested".to_vec(),
                executable: false,
            },
        );
        assert!(
            write_asar(&coll_path, &entries).is_err(),
            "write_asar must reject file vs directory prefix collision"
        );
        let _ = fs::remove_file(&coll_path);
    }
}
