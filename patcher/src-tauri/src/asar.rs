//! Chromium ASAR archive reader and writer.
//!
//! Supports streaming single-file lookups, full archive repacking with
//! `unpacked`/`executable`/symlink metadata preservation, and Electron-compatible
//! 4 MiB SHA-256 integrity block computation.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const BLOCK_SIZE: usize = 4 * 1024 * 1024; // 4 MB Electron integrity block size

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
}

impl AsarArchive {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let mut f = File::open(&path).map_err(|e| format!("Не удалось открыть ASAR: {e}"))?;

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

        let mut json_buf = vec![0u8; json_len as usize];
        f.read_exact(&mut json_buf)
            .map_err(|e| format!("Ошибка чтения JSON-заголовка ASAR: {e}"))?;

        let header: Value = serde_json::from_slice(&json_buf)
            .map_err(|e| format!("Ошибка парсинга JSON-заголовка ASAR: {e}"))?;

        Ok(Self {
            path,
            header,
            base_offset: 8 + total_size as u64,
        })
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
        if node.get("unpacked").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Ok(None);
        }
        let Some(size) = node.get("size").and_then(|v| v.as_u64()) else {
            return Ok(None);
        };
        let offset = parse_offset(node.get("offset"))?;

        let mut f = File::open(&self.path).map_err(|e| format!("Ошибка открытия ASAR: {e}"))?;
        f.seek(SeekFrom::Start(self.base_offset + offset))
            .map_err(|e| format!("Ошибка seek в ASAR: {e}"))?;
        let mut buf = vec![0u8; size as usize];
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
            let full_path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };

            if item.get("files").is_some() {
                self.traverse_node(item, &full_path, file, out)?;
            } else if let Some(link) = item.get("link").and_then(|v| v.as_str()) {
                out.insert(
                    full_path,
                    AsarEntry::Symlink {
                        link: link.to_string(),
                    },
                );
            } else {
                let executable = item
                    .get("executable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let size = item.get("size").and_then(|v| v.as_u64()).unwrap_or(0);

                if item.get("unpacked").and_then(|v| v.as_bool()).unwrap_or(false) {
                    out.insert(
                        full_path,
                        AsarEntry::Unpacked {
                            size,
                            executable,
                            integrity: item.get("integrity").cloned(),
                        },
                    );
                } else {
                    let offset = parse_offset(item.get("offset"))?;
                    let mut buf = vec![0u8; size as usize];
                    if size > 0 {
                        file.seek(SeekFrom::Start(self.base_offset + offset))
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

fn parse_offset(val: Option<&Value>) -> Result<u64, String> {
    match val {
        Some(Value::String(s)) => s
            .parse::<u64>()
            .map_err(|e| format!("Некорректный offset '{s}': {e}")),
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| "Некорректный числовой offset".to_string()),
        None => Ok(0),
        _ => Err("Неподдерживаемый тип offset".to_string()),
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

pub fn write_asar<P: AsRef<Path>>(
    output_path: P,
    entries: &BTreeMap<String, AsarEntry>,
) -> Result<(), String> {
    let mut root = Map::new();
    root.insert("files".into(), Value::Object(Map::new()));

    let mut current_offset: u64 = 0;
    let mut payloads: Vec<&[u8]> = Vec::new();

    for (rel_path, entry) in entries {
        let parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let filename = parts[parts.len() - 1];
        let dirs = &parts[..parts.len() - 1];

        let mut curr = &mut root;
        for dir in dirs {
            let files_map = curr
                .entry("files")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or("Некорректная структура дерева ASAR")?;
            let next = files_map.entry((*dir).to_string()).or_insert_with(|| {
                let mut m = Map::new();
                m.insert("files".into(), Value::Object(Map::new()));
                Value::Object(m)
            });
            curr = next
                .as_object_mut()
                .ok_or("Некорректная директория в дереве ASAR")?;
        }

        let files_map = curr
            .entry("files")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or("Некорректный узел files")?;

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
                current_offset += data.len() as u64;
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
    let json_len = json_bytes.len() as u32;
    let padding = (4 - (json_bytes.len() % 4)) % 4;
    json_bytes.extend(std::iter::repeat_n(0u8, padding));

    let total_size = json_len + (padding as u32) + 8;
    let payload_size = total_size - 4;

    let out_path = output_path.as_ref();
    let tmp_path = out_path.with_extension("asar.tmp");

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
    }

    if out_path.exists() {
        let _ = fs::remove_file(out_path);
    }
    fs::rename(&tmp_path, out_path)
        .map_err(|e| format!("Ошибка переименования временного ASAR: {e}"))?;

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
}
