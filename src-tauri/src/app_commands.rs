//! Small application-level Tauri commands that do not belong to a feature domain.

#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
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
pub async fn resolve_service_url(
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
    Ok(format!("http://{host}:{port}/"))
}
