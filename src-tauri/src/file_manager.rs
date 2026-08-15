use crate::ssh_session::SessionRequest;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub async fn list_remote_directory(
    request: SessionRequest,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let path = if path.trim().is_empty() {
        "/root"
    } else {
        path.trim()
    };
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let result = sftp.read_dir(path).await.map_err(|error| error.to_string());
    let _ = sftp.close().await;
    let mut entries = result?
        .map(|entry| {
            let metadata = entry.metadata();
            RemoteFileEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

/// Reads a bounded UTF-8 text file over a dedicated SFTP connection. This is
/// intentionally separate from the interactive PTY so a model inspection
/// cannot reorder terminal bytes or consume the user's prompt. The SFTP
/// subsystem is closed on both success and read errors.
pub async fn read_remote_text(
    request: &SessionRequest,
    remote_path: &str,
    max_bytes: usize,
) -> Result<String, String> {
    if max_bytes == 0 {
        return Err("max_bytes must be greater than zero".to_string());
    }
    let remote_path = remote_path.trim();
    if remote_path.is_empty() {
        return Err("remote file path is required".to_string());
    }
    let sftp = crate::ssh_session::open_sftp_session(request).await?;
    let metadata = match sftp.metadata(remote_path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    let file_size = metadata.len();
    if file_size > max_bytes as u64 {
        let _ = sftp.close().await;
        return Err(format!(
            "remote file exceeds the {max_bytes}-byte read limit"
        ));
    }
    // Read exactly the advertised byte count instead of waiting for an EOF
    // packet. Some embedded SFTP servers do not terminate read-to-end
    // requests reliably even for tiny files.
    let read_result = async {
        let mut remote = sftp
            .open(remote_path)
            .await
            .map_err(|error| error.to_string())?;
        let length =
            usize::try_from(file_size).map_err(|_| "远程文件大小超出当前平台限制".to_string())?;
        let mut data = vec![0_u8; length];
        if length > 0 {
            remote
                .read_exact(&mut data)
                .await
                .map_err(|error| error.to_string())?;
        }
        drop(remote);
        Ok::<Vec<u8>, String>(data)
    }
    .await;
    let close_result = sftp.close().await.map_err(|error| error.to_string());
    let data = read_result?;
    close_result?;
    if data.len() > max_bytes {
        return Err(format!(
            "remote file exceeds the {max_bytes}-byte read limit"
        ));
    }
    String::from_utf8(data).map_err(|_| "remote file is not valid UTF-8 text".to_string())
}

/// Read a bounded remote file as bytes for the local AI workspace. This is
/// intentionally separate from the interactive PTY and closes the SFTP
/// session on every success and error path.
pub async fn read_remote_bytes(
    request: &SessionRequest,
    remote_path: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if max_bytes == 0 {
        return Err("max_bytes must be greater than zero".to_string());
    }
    let remote_path = remote_path.trim();
    if remote_path.is_empty() {
        return Err("remote file path is required".to_string());
    }
    let sftp = crate::ssh_session::open_sftp_session(request).await?;
    let metadata = match sftp.metadata(remote_path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    if metadata.len() > max_bytes as u64 {
        let _ = sftp.close().await;
        return Err(format!(
            "remote file exceeds the {max_bytes}-byte download limit"
        ));
    }
    let result = async {
        let mut remote = sftp
            .open(remote_path)
            .await
            .map_err(|error| error.to_string())?;
        let length = usize::try_from(metadata.len())
            .map_err(|_| "远程文件大小超出当前平台限制".to_string())?;
        let mut data = vec![0_u8; length];
        if length > 0 {
            remote
                .read_exact(&mut data)
                .await
                .map_err(|error| error.to_string())?;
        }
        drop(remote);
        Ok::<Vec<u8>, String>(data)
    }
    .await;
    let close_result = sftp.close().await.map_err(|error| error.to_string());
    let data = result?;
    close_result?;
    Ok(data)
}

/// Public Tauri wrapper for the bounded text reader used by the editor. Keep
/// the limit in the backend so a malformed or unexpectedly large remote file
/// cannot make the WebView allocate an unbounded document.
#[tauri::command]
pub async fn read_remote_text_file(
    request: SessionRequest,
    remote_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    tokio::time::timeout(
        Duration::from_secs(20),
        read_remote_text(&request, &remote_path, max_bytes.unwrap_or(2 * 1024 * 1024)),
    )
    .await
    .map_err(|_| "读取远程文件超时，请检查 SFTP 连接".to_string())?
}

#[tauri::command]
pub async fn write_remote_text_file(
    request: SessionRequest,
    remote_path: String,
    content: String,
) -> Result<u64, String> {
    let remote_path = remote_path.trim();
    if remote_path.is_empty() {
        return Err("remote file path is required".to_string());
    }
    if content.as_bytes().len() > 2 * 1024 * 1024 {
        return Err("remote file exceeds the 2 MiB editor limit".to_string());
    }
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;

    // Keep one rolling backup beside the file. The original bytes are read
    // before the target is truncated, so a failed backup leaves the live file
    // untouched and the editor never performs an unprotected overwrite.
    let metadata = match sftp.metadata(remote_path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(format!("无法读取原文件，未生成 .bak：{}", error));
        }
    };
    if metadata.len() > 2 * 1024 * 1024 {
        let _ = sftp.close().await;
        return Err("原文件超过 2 MiB，无法在编辑器限制内生成 .bak".to_string());
    }
    let original = {
        let length = metadata.len() as usize;
        let mut remote = match sftp.open(remote_path).await {
            Ok(file) => file,
            Err(error) => {
                let _ = sftp.close().await;
                return Err(format!("无法读取原文件，未生成 .bak：{}", error));
            }
        };
        let mut bytes = vec![0_u8; length];
        let read_result = if length == 0 {
            Ok(())
        } else {
            remote
                .read_exact(&mut bytes)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        };
        drop(remote);
        if let Err(error) = read_result {
            let _ = sftp.close().await;
            return Err(format!("无法读取原文件，未生成 .bak：{}", error));
        }
        bytes
    };
    let backup_path = format!("{remote_path}.bak");
    let mut backup = match sftp.create(&backup_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(format!("无法创建备份文件 {}：{}", backup_path, error));
        }
    };
    let backup_result = backup
        .write_all(&original)
        .await
        .map_err(|error| error.to_string());
    let backup_shutdown = if backup_result.is_ok() {
        backup.shutdown().await.map_err(|error| error.to_string())
    } else {
        Ok(())
    };
    drop(backup);
    if let Err(error) = backup_result {
        let _ = sftp.close().await;
        return Err(format!("写入备份文件失败：{}", error));
    }
    if let Err(error) = backup_shutdown {
        let _ = sftp.close().await;
        return Err(format!("保存备份文件失败：{}", error));
    }

    let mut remote = match sftp.create(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    let data = content.into_bytes();
    let write_result = remote
        .write_all(&data)
        .await
        .map_err(|error| error.to_string());
    let shutdown_result = if write_result.is_ok() {
        remote.shutdown().await.map_err(|error| error.to_string())
    } else {
        Ok(())
    };
    drop(remote);
    let close_result = sftp.close().await.map_err(|error| error.to_string());
    write_result?;
    shutdown_result?;
    close_result?;
    Ok(data.len() as u64)
}

fn remote_child_path(remote_path: &str, new_name: &str) -> Result<String, String> {
    let path = remote_path.trim();
    let name = new_name.trim();
    if path.is_empty() || name.is_empty() || name == "." || name == ".." {
        return Err("文件名不能为空或无效".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("新文件名只能包含当前目录中的名称".to_string());
    }
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|parent| !parent.is_empty())
        .unwrap_or("/");
    Ok(if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    })
}

#[tauri::command]
pub async fn rename_remote_file(
    request: SessionRequest,
    remote_path: String,
    new_name: String,
) -> Result<(), String> {
    let new_path = remote_child_path(&remote_path, &new_name)?;
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let result = sftp
        .rename(remote_path.trim(), new_path)
        .await
        .map_err(|error| error.to_string());
    let close_result = sftp.close().await.map_err(|error| error.to_string());
    result?;
    close_result?;
    Ok(())
}

#[tauri::command]
pub async fn delete_remote_file(
    request: SessionRequest,
    remote_path: String,
    is_dir: bool,
) -> Result<(), String> {
    if remote_path.trim().is_empty() || remote_path.trim() == "/" {
        return Err("不能删除根目录".to_string());
    }
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let result = if is_dir {
        sftp.remove_dir(remote_path.trim())
            .await
            .map_err(|error| error.to_string())
    } else {
        sftp.remove_file(remote_path.trim())
            .await
            .map_err(|error| error.to_string())
    };
    let close_result = sftp.close().await.map_err(|error| error.to_string());
    result?;
    close_result?;
    Ok(())
}

#[tauri::command]
pub async fn download_remote_file(
    request: SessionRequest,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let mut remote = match sftp.open(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    let mut data = Vec::new();
    let read_result = remote
        .read_to_end(&mut data)
        .await
        .map_err(|error| error.to_string());
    drop(remote);
    let _ = sftp.close().await;
    read_result?;
    fs::write(Path::new(&local_path), &data).map_err(|error| error.to_string())?;
    Ok(data.len() as u64)
}

#[tauri::command]
pub async fn upload_remote_file(
    request: SessionRequest,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let data = fs::read(Path::new(&local_path)).map_err(|error| error.to_string())?;
    let sftp = crate::ssh_session::open_sftp_session(&request).await?;
    let mut remote = match sftp.create(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            let _ = sftp.close().await;
            return Err(error.to_string());
        }
    };
    let write_result = remote
        .write_all(&data)
        .await
        .map_err(|error| error.to_string());
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
    let mut value = path
        .filter(|item| !item.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .to_string()
        });
    // `F:` is drive-relative on Windows (and can resolve to an unexpected
    // working directory). Treat a bare drive as its root explicitly.
    if value.len() == 2 && value.as_bytes()[1] == b':' {
        value.push('\\');
    }
    let target = PathBuf::from(value);
    if !target.exists() || !target.is_dir() {
        return Err("本地目录不存在或不可访问".into());
    }
    Ok(target)
}

fn local_drive_entries() -> Vec<LocalFileEntry> {
    ('A'..='Z')
        .filter_map(|letter| {
            let path = format!("{letter}:\\");
            let root = Path::new(&path);
            if !root.is_dir() {
                return None;
            }
            Some(LocalFileEntry {
                name: format!("{letter}:"),
                path,
                is_dir: true,
                size: 0,
            })
        })
        .collect()
}

#[tauri::command]
pub fn list_local_directory(path: Option<String>) -> Result<Vec<LocalFileEntry>, String> {
    // An empty path is the file-manager's drive picker. This keeps the local
    // pane independent from the process working directory and lets users
    // navigate to e.g. F:\\codex explicitly.
    if path.as_deref().map(str::trim).unwrap_or("").is_empty() {
        let drives = local_drive_entries();
        if !drives.is_empty() {
            return Ok(drives);
        }
    }
    let target = safe_local_path(path)?;
    let mut entries = fs::read_dir(&target)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            Some(LocalFileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

fn local_child_path(path: &str, new_name: &str) -> Result<PathBuf, String> {
    let name = new_name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("文件名不能为空或无效".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("新文件名只能包含当前目录中的名称".into());
    }
    let parent = Path::new(path)
        .parent()
        .ok_or_else(|| "无法确定本地文件所在目录".to_string())?;
    Ok(parent.join(name))
}

#[tauri::command]
pub fn rename_local_file(path: String, new_name: String) -> Result<(), String> {
    let source = Path::new(path.trim());
    if !source.exists() {
        return Err("本地文件不存在".into());
    }
    let target = local_child_path(path.trim(), &new_name)?;
    fs::rename(source, target).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_local_file(path: String, is_dir: bool) -> Result<(), String> {
    let target = Path::new(path.trim());
    if path.trim().is_empty() || !target.exists() {
        return Err("本地文件不存在".into());
    }
    let parent = target.parent();
    if target.file_name().is_none() || parent.is_none() || parent == Some(target) {
        return Err("不能删除本地根路径".into());
    }
    if is_dir {
        fs::remove_dir(target).map_err(|error| error.to_string())
    } else {
        fs::remove_file(target).map_err(|error| error.to_string())
    }
}

pub fn read_local_file(path: &str) -> Result<Vec<u8>, String> {
    let target = Path::new(path);
    if !target.is_file() {
        return Err("本地文件不存在".into());
    }
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
    let data = STANDARD
        .decode(content)
        .map_err(|error| error.to_string())?;
    write_local_file(&path, &data)
}
