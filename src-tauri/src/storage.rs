use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const CREDENTIAL_SERVICE: &str = "OpsNest";

fn credential_entry(server_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, &format!("server:{server_id}"))
        .map_err(|error| error.to_string())
}

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("opsnest-data.json"))
}

fn append_log_line(app: &AppHandle, filename: &str, entry: Value) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(filename);
    let mut lines = if path.exists() {
        fs::read_to_string(&path)
            .map_err(|error| error.to_string())?
            .lines()
            .map(str::to_owned)
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    lines.push(serde_json::to_string(&entry).map_err(|error| error.to_string())?);
    let content = lines.join("\n") + "\n";
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn load_log_lines(app: &AppHandle, filename: &str) -> Result<Vec<Value>, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = directory.join(filename);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect()
}

#[tauri::command]
pub fn load_local_data(app: AppHandle) -> Result<Value, String> {
    let path = data_path(&app)?;
    if !path.exists() {
        return Ok(json!({ "servers": [], "aiConfig": null }));
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| format!("本地数据读取失败：{error}"))
}

#[tauri::command]
pub fn save_local_data(app: AppHandle, data: Value) -> Result<(), String> {
    let path = data_path(&app)?;
    let temporary = path.with_extension("tmp");
    let content = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn append_runtime_log(app: AppHandle, entry: Value) -> Result<(), String> {
    append_log_line(&app, "opsnest-runtime.jsonl", entry)
}

#[tauri::command]
pub fn load_runtime_logs(app: AppHandle) -> Result<Vec<Value>, String> {
    load_log_lines(&app, "opsnest-runtime.jsonl")
}

#[tauri::command]
pub fn clear_runtime_logs(app: AppHandle) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = directory.join("opsnest-runtime.jsonl");
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn append_conversation_log(app: AppHandle, entry: Value) -> Result<(), String> {
    append_log_line(&app, "opsnest-conversations.jsonl", entry)
}

#[tauri::command]
pub fn load_conversation_logs(app: AppHandle) -> Result<Vec<Value>, String> {
    load_log_lines(&app, "opsnest-conversations.jsonl")
}

#[tauri::command]
pub fn clear_conversation_logs(app: AppHandle) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = directory.join("opsnest-conversations.jsonl");
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_server_credential(server_id: String, credential: Value) -> Result<(), String> {
    let entry = credential_entry(&server_id)?;
    let secret = serde_json::to_string(&credential).map_err(|error| error.to_string())?;
    entry.set_password(&secret).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_server_credential(server_id: String) -> Result<Option<Value>, String> {
    let entry = credential_entry(&server_id)?;
    let secret = match entry.get_password() {
        Ok(secret) => secret,
        Err(_) => return Ok(None),
    };
    serde_json::from_str(&secret).map(Some).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_server_credential(server_id: String) -> Result<(), String> {
    let entry = credential_entry(&server_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
