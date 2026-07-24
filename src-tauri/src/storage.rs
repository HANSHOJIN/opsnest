use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("opsnest-data.json"))
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
