use serde::Serialize;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{fs, path::{Path, PathBuf}};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use crate::ssh_session::SessionRequest;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub async fn list_remote_directory(request: SessionRequest, path: String) -> Result<Vec<RemoteFileEntry>, String> {
    let path = if path.trim().is_empty() { "/root" } else { path.trim() };
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let result = sftp.read_dir(path).await.map_err(|error| error.to_string());
    let _ = sftp.close().await;
    let mut entries = result?
        .map(|entry| {
            let metadata = entry.metadata();
            RemoteFileEntry { name: entry.file_name(), path: entry.path(), is_dir: metadata.is_dir(), size: metadata.len() }
        }).collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub async fn download_remote_file(request: SessionRequest, remote_path: String, local_path: String) -> Result<u64, String> {
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let mut remote = match sftp.open(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    let mut data = Vec::new();
    let read_result = remote.read_to_end(&mut data).await.map_err(|error| error.to_string());
    drop(remote);
    let _ = sftp.close().await;
    read_result?;
    fs::write(Path::new(&local_path), &data).map_err(|error| error.to_string())?;
    Ok(data.len() as u64)
}

#[tauri::command]
pub async fn upload_remote_file(request: SessionRequest, local_path: String, remote_path: String) -> Result<u64, String> {
    let data = fs::read(Path::new(&local_path)).map_err(|error| error.to_string())?;
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let mut remote = match sftp.create(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    let write_result = remote.write_all(&data).await.map_err(|error| error.to_string());
    let shutdown_result = if write_result.is_ok() {
        remote.shutdown().await.map_err(|error| error.to_string())
    } else {
        Ok(())
    };
    drop(remote);
    let _ = sftp.close().await;
    write_result?;
    shutdown_result?;
    Ok(data.len() as u64)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn safe_local_path(path: Option<String>) -> Result<PathBuf, String> {
    let mut value = path.filter(|item| !item.trim().is_empty()).unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("." )).to_string_lossy().to_string()
    });
    // `F:` is drive-relative on Windows (and can resolve to an unexpected
    // working directory). Treat a bare drive as its root explicitly.
    if value.len() == 2 && value.as_bytes()[1] == b':' {
        value.push('\\');
    }
    let target = PathBuf::from(value);
    if !target.exists() || !target.is_dir() { return Err("本地目录不存在或不可访问".into()); }
    Ok(target)
}

fn local_drive_entries() -> Vec<LocalFileEntry> {
    ('A'..='Z').filter_map(|letter| {
        let path = format!("{letter}:\\");
        let root = Path::new(&path);
        if !root.is_dir() { return None; }
        Some(LocalFileEntry { name: format!("{letter}:"), path, is_dir: true, size: 0 })
    }).collect()
}

#[tauri::command]
pub fn list_local_directory(path: Option<String>) -> Result<Vec<LocalFileEntry>, String> {
    // An empty path is the file-manager's drive picker. This keeps the local
    // pane independent from the process working directory and lets users
    // navigate to e.g. F:\\codex explicitly.
    if path.as_deref().map(str::trim).unwrap_or("").is_empty() {
        let drives = local_drive_entries();
        if !drives.is_empty() { return Ok(drives); }
    }
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
