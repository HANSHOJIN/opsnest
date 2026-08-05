use std::{
    fs,
    path::{Path, PathBuf},
};
use serde_json::Value;

mod ssh_scan;
mod ssh_session;
mod ai;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.chars().any(|ch| ch.is_control() || ch == '"') {
        return Err("only safe HTTP or HTTPS URLs can be opened".to_string());
    }
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&url).spawn().map_err(|error| error.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

fn portable_data_dir() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("unable to locate executable: {error}"))?;
    let parent = executable
        .parent()
        .ok_or_else(|| "unable to locate executable directory".to_string())?;
    let data_dir = parent.join("data");
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("unable to create portable data directory: {error}"))?;
    Ok(data_dir)
}

fn portable_file_path(file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let valid_name = path.file_name().and_then(|value| value.to_str()) == Some(file_name)
        && file_name.ends_with(".json")
        && !file_name.is_empty();
    if !valid_name {
        return Err("invalid portable data filename".to_string());
    }
    Ok(portable_data_dir()?.join(file_name))
}

#[tauri::command]
fn read_portable_json(file_name: String) -> Result<Option<String>, String> {
    let path = portable_file_path(&file_name)?;
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("unable to read portable data: {error}")),
    }
}

#[tauri::command]
fn write_portable_json(file_name: String, content: String) -> Result<(), String> {
    if content.len() > 2 * 1024 * 1024 {
        return Err("portable data file is too large".to_string());
    }
    let path = portable_file_path(&file_name)?;
    fs::write(path, content).map_err(|error| format!("unable to write portable data: {error}"))
}

fn credential_entry(server_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("OpsNest", &format!("server:{server_id}"))
        .map_err(|error| format!("unable to access Windows Credential Manager: {error}"))
}

#[tauri::command]
fn save_server_credential(server_id: String, password: String) -> Result<(), String> {
    credential_entry(&server_id)?.set_password(&password)
        .map_err(|error| format!("unable to save server credential: {error}"))
}

#[tauri::command]
fn load_server_credential(server_id: String) -> Result<Option<String>, String> {
    match credential_entry(&server_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("unable to load server credential: {error}")),
    }
}

#[tauri::command]
fn delete_server_credential(server_id: String) -> Result<(), String> {
    match credential_entry(&server_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("unable to delete server credential: {error}")),
    }
}

fn config_file_path(file_name: &str) -> Result<PathBuf, String> {
    const ALLOWED: &[&str] = &["appearance.json", "model.json", "servers.json", "debug.json", "layout.json"];
    if !ALLOWED.contains(&file_name) { return Err("configuration file is outside the approved allowlist".into()); }
    portable_file_path(file_name)
}

#[tauri::command]
fn read_opsnest_config(file_name: String) -> Result<Option<String>, String> {
    let path = config_file_path(&file_name)?;
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("unable to read configuration: {error}")),
    }
}

#[tauri::command]
fn write_opsnest_config(file_name: String, content: String, approved: bool) -> Result<(), String> {
    if !approved { return Err("configuration write requires explicit approval".into()); }
    if content.len() > 2 * 1024 * 1024 { return Err("configuration file is too large".into()); }
    let path = config_file_path(&file_name)?;
    let _parsed: Value = serde_json::from_str(&content).map_err(|error| format!("invalid JSON configuration: {error}"))?;
    if path.exists() { let backup = path.with_extension("json.bak"); fs::copy(&path, backup).map_err(|error| format!("unable to create configuration backup: {error}"))?; }
    fs::write(path, content).map_err(|error| format!("unable to write configuration: {error}"))
}

fn debug_logging_enabled(data_dir: &Path) -> bool {
    let path = data_dir.join("debug.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| value.get("enabled").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

#[tauri::command]
fn append_debug_log(level: String, message: String, details: Option<String>) -> Result<(), String> {
    let data_dir = portable_data_dir()?;
    if !debug_logging_enabled(&data_dir) {
        return Ok(());
    }
    let log_path = data_dir.join("opsnest-debug.log");
    if fs::metadata(&log_path).map(|meta| meta.len() > 5 * 1024 * 1024).unwrap_or(false) {
        fs::write(&log_path, "--- log rotated after reaching 5 MB ---\n")
            .map_err(|error| format!("unable to rotate debug log: {error}"))?;
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let mut line = format!("[{timestamp}] [{}] {}", level.trim().to_uppercase(), message.trim());
    if let Some(details) = details.filter(|value| !value.trim().is_empty()) {
        line.push_str(" | ");
        line.push_str(&details.replace(['\r', '\n'], " "));
    }
    line.push('\n');
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("unable to open debug log: {error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("unable to append debug log: {error}"))
}

#[tauri::command]
async fn test_model_connection(base_url: String, api_key: String, model: String) -> Result<String, String> {
    let _ = append_debug_log("info".to_string(), "model connection test started".to_string(), Some(format!("model={}", model.trim())));
    let base_url = base_url.trim().trim_end_matches('/');
    let model = model.trim();
    if base_url.is_empty() || model.is_empty() {
        return Err("API address and model name are required".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("unable to create HTTP client: {error}"))?;
    let mut request = client.post(format!("{base_url}/chat/completions")).json(&serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "Reply with OK." }],
        "max_tokens": 8,
        "temperature": 0
    }));
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request.send().await.map_err(|error| format!("connection failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("unable to read response: {error}"))?;
    if !status.is_success() {
        return Err(format!("API returned {}: {}", status.as_u16(), body.chars().take(240).collect::<String>()));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| format!("invalid API response: {error}"))?;
    if payload.get("choices").and_then(|choices| choices.get(0)).is_none() {
        return Err("API response did not contain choices".to_string());
    }
    let _ = append_debug_log("info".to_string(), "model connection test succeeded".to_string(), Some(format!("model={}", model)));
    Ok("Connection successful".to_string())
}

#[tauri::command]
async fn fetch_model_names(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let _ = append_debug_log("info".to_string(), "model list fetch started".to_string(), Some(format!("endpoint={}", base_url.trim())));
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("API address is required".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("unable to create HTTP client: {error}"))?;
    let mut request = client.get(format!("{base_url}/models"));
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request.send().await.map_err(|error| format!("connection failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("unable to read response: {error}"))?;
    if !status.is_success() {
        return Err(format!("API returned {}: {}", status.as_u16(), body.chars().take(240).collect::<String>()));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| format!("invalid models response: {error}"))?;
    let models = payload.get("data").and_then(Value::as_array).ok_or_else(|| "API response did not contain a model list".to_string())?;
    let mut names = models.iter().filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned)).collect::<Vec<_>>();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err("No models were returned".to_string());
    }
    let _ = append_debug_log("info".to_string(), "model list fetch succeeded".to_string(), Some(format!("count={}", names.len())));
    Ok(names)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            exit_app,
            open_external_url,
            read_portable_json,
            write_portable_json,
            save_server_credential,
            load_server_credential,
            delete_server_credential,
            read_opsnest_config,
            write_opsnest_config,
            test_model_connection,
            fetch_model_names,
            ssh_scan::inspect_linux_server,
            ssh_scan::discover_linux_services,
            ssh_session::open_ssh_session,
            ssh_session::open_interactive_ssh_terminal,
            ssh_session::write_interactive_ssh_terminal,
            ssh_session::resize_interactive_ssh_terminal,
            ssh_session::close_interactive_ssh_terminal,
            ssh_session::execute_ssh_command,
            ssh_session::close_ssh_session,
            ai::chat_completion,
            ai::chat_completion_with_tools,
            ai::ai_ssh_chat,
            append_debug_log
        ])
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show OpsNest", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .expect("application icon is required")
                        .clone(),
                )
                .tooltip("OpsNest")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OpsNest");
}
