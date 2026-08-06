use serde::Serialize;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{fs, path::{Path, PathBuf}};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn safe_local_path(path: Option<String>) -> Result<PathBuf, String> {
    let value = path.filter(|item| !item.trim().is_empty()).unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("." )).to_string_lossy().to_string()
    });
    let target = PathBuf::from(value);
    if !target.exists() || !target.is_dir() { return Err("本地目录不存在或不可访问".into()); }
    Ok(target)
}

#[tauri::command]
pub fn list_local_directory(path: Option<String>) -> Result<Vec<LocalFileEntry>, String> {
    let target = safe_local_path(path)?;
    let mut entries = fs::read_dir(&target).map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            Some(LocalFileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            })
        }).collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

pub fn read_local_file(path: &str) -> Result<Vec<u8>, String> {
    let target = Path::new(path);
    if !target.is_file() { return Err("本地文件不存在".into()); }
    fs::read(target).map_err(|error| error.to_string())
}

pub fn write_local_file(path: &str, data: &[u8]) -> Result<(), String> {
    fs::write(Path::new(path), data).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_local_file_base64(path: String) -> Result<String, String> {
    Ok(STANDARD.encode(read_local_file(&path)?))
}

#[tauri::command]
pub fn write_local_file_base64(path: String, content: String) -> Result<(), String> {
    let data = STANDARD.decode(content).map_err(|error| error.to_string())?;
    write_local_file(&path, &data)
}
