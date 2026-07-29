#![cfg_attr(windows, windows_subsystem = "windows")]

mod ai;
mod ssh;
mod storage;
mod web;

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http and https URLs can be opened.".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn resolve_service_url(
    host: String,
    port: u16,
    preferred_scheme: Option<String>,
) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err("Invalid service address.".into());
    }
    let preferred = preferred_scheme
        .as_deref()
        .filter(|scheme| matches!(*scheme, "http" | "https"));
    let mut schemes = Vec::with_capacity(2);
    if let Some(scheme) = preferred {
        schemes.push(scheme);
    }
    for scheme in ["https", "http"] {
        if !schemes.contains(&scheme) {
            schemes.push(scheme);
        }
    }
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    for scheme in schemes {
        let url = format!("{scheme}://{host}:{port}/");
        if client.head(&url).send().await.is_ok() {
            return Ok(url);
        }
    }
    // Keep the common HTTP fallback when the service rejects HEAD or is not
    // reachable from the local machine. The browser can still provide the
    // final diagnostic to the user.
    Ok(format!("http://{host}:{port}/"))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_version,
            open_external_url,
            resolve_service_url,
            ai::chat_completion,
            web::search_web,
            ssh::test_ssh_connection,
            ssh::inspect_server,
            ssh::discover_server_services,
            ssh::diagnose_server,
            ssh::list_server_cron,
            ssh::save_server_cron,
            ssh::delete_server_cron,
            ssh::execute_ssh_command,
            ssh::open_ssh_terminal,
            ssh::write_ssh_terminal,
            ssh::resize_ssh_terminal,
            ssh::close_interactive_ssh_terminal,
            ssh::stop_ssh_command,
            ssh::close_ssh_shell,
            storage::load_local_data,
            storage::save_local_data,
            storage::append_runtime_log,
            storage::load_runtime_logs,
            storage::clear_runtime_logs,
            storage::append_conversation_log,
            storage::load_conversation_logs,
            storage::clear_conversation_logs,
            storage::save_server_credential,
            storage::load_server_credential,
            storage::delete_server_credential,
            storage::save_ai_credential,
            storage::load_ai_credential,
            storage::delete_ai_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpsNest");
}
