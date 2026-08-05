use russh::{client, keys, ChannelMsg};
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::Notify;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest { pub host: String, pub port: u16, pub username: String, pub auth_method: String, pub password: Option<String>, pub private_key_path: Option<String>, pub passphrase: Option<String> }

struct Handler { host: String, port: u16 }
impl client::Handler for Handler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &russh::keys::ssh_key::PublicKey) -> Result<bool, Self::Error> {
        match keys::known_hosts::check_known_hosts(&self.host, self.port, key)? { true => Ok(true), false => { keys::known_hosts::learn_known_hosts(&self.host, self.port, key)?; Ok(true) } }
    }
}

type Session = client::Handle<Handler>;
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> { SESSIONS.get_or_init(|| Mutex::new(HashMap::new())) }

struct InteractiveShell { writer: tokio::sync::Mutex<russh::ChannelWriteHalf<client::Msg>>, output: Mutex<Vec<u8>>, notify: Notify }
static INTERACTIVE: OnceLock<Mutex<HashMap<String, Arc<InteractiveShell>>>> = OnceLock::new();
fn interactive() -> &'static Mutex<HashMap<String, Arc<InteractiveShell>>> { INTERACTIVE.get_or_init(|| Mutex::new(HashMap::new())) }

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent { pub session_id: String, pub data: String, pub closed: bool }

async fn connect(request: &SessionRequest) -> Result<Session, String> {
    let host = request.host.trim();
    if host.is_empty() || request.username.trim().is_empty() { return Err("SSH host and username are required".into()); }
    let config = client::Config { inactivity_timeout: None, keepalive_interval: Some(Duration::from_secs(10)), keepalive_max: 0, ..Default::default() };
    let mut session = tokio::time::timeout(Duration::from_secs(15), client::connect(Arc::new(config), format!("{host}:{}", request.port), Handler { host: host.to_string(), port: request.port }))
        .await.map_err(|_| "SSH connection timed out".to_string())?.map_err(|error| format!("SSH handshake failed: {error}"))?;
    let authenticated = if request.auth_method == "password" {
        session.authenticate_password(request.username.trim(), request.password.as_deref().unwrap_or(""))
            .await.map_err(|error| format!("SSH login failed: {error}"))?
    } else {
        let path = request.private_key_path.as_deref().filter(|value| !value.trim().is_empty()).ok_or_else(|| "SSH private key is required".to_string())?;
        let key = keys::load_secret_key(path, request.passphrase.as_deref()).map_err(|error| format!("Unable to read SSH key: {error}"))?;
        session.authenticate_publickey(request.username.trim(), keys::PrivateKeyWithHashAlg::new(Arc::new(key), session.best_supported_rsa_hash().await.map_err(|error| error.to_string())?.flatten()))
            .await.map_err(|error| format!("SSH login failed: {error}"))?
    };
    if !authenticated.success() { return Err("SSH server rejected the login".into()); }
    Ok(session)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionResult { pub session_id: String }

#[tauri::command]
pub async fn open_ssh_session(request: SessionRequest) -> Result<OpenSessionResult, String> {
    let session = Arc::new(connect(&request).await?);
    let id = format!("ssh-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    sessions().lock().map_err(|_| "SSH session lock failed".to_string())?.insert(id.clone(), session);
    Ok(OpenSessionResult { session_id: id })
}

#[tauri::command]
pub async fn open_interactive_ssh_terminal(app: tauri::AppHandle, request: SessionRequest, session_id: String) -> Result<(), String> {
    if interactive().lock().map_err(|_| "SSH terminal lock failed")?.contains_key(&session_id) { return Ok(()); }
    let session = connect(&request).await?;
    let channel = session.channel_open_session().await.map_err(|error| error.to_string())?;
    let _ = channel.request_pty(false, "xterm-256color", 240, 40, 0, 0, &[]).await;
    let (mut reader, writer) = channel.split();
    writer.request_shell(true).await.map_err(|error| error.to_string())?;
    let shell = Arc::new(InteractiveShell { writer: tokio::sync::Mutex::new(writer), output: Mutex::new(Vec::new()), notify: Notify::new() });
    interactive().lock().map_err(|_| "SSH terminal lock failed")?.insert(session_id.clone(), shell.clone());
    tokio::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => { if let Ok(mut output) = shell.output.lock() { output.extend_from_slice(&data); } shell.notify.notify_waiters(); let _ = app.emit("ssh-terminal-output", TerminalEvent { session_id: session_id.clone(), data: String::from_utf8_lossy(&data).into_owned(), closed: false }); }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = app.emit("ssh-terminal-output", TerminalEvent { session_id, data: String::new(), closed: true });
    });
    Ok(())
}

#[tauri::command]
pub async fn write_interactive_ssh_terminal(session_id: String, data: String) -> Result<(), String> {
    let shell = interactive().lock().map_err(|_| "SSH terminal lock failed")?.get(&session_id).cloned().ok_or_else(|| "SSH terminal is not connected".to_string())?;
    let result = shell.writer.lock().await.data_bytes(data.into_bytes()).await.map_err(|error| error.to_string());
    result
}

pub async fn run_interactive_command(session_id: &str, command: &str, approved: bool) -> Result<String, String> {
    let lowered = command.to_ascii_lowercase();
    let risky = ["sudo ", "rm ", "mv ", "chmod ", "chown ", "systemctl ", "service ", "reboot", "shutdown", "docker rm", "docker stop", "docker restart", "apt install", "apt remove", "apt purge", "apt upgrade"].iter().any(|token| lowered.contains(token));
    if risky && !approved { return Err("This command requires explicit approval".into()); }
    let shell = interactive().lock().map_err(|_| "SSH terminal lock failed".to_string())?.get(session_id).cloned().ok_or_else(|| "SSH terminal is not connected".to_string())?;
    let marker = format!("__OPSNEST_INTERACTIVE_END_{}__", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let start = shell.output.lock().map_err(|_| "SSH terminal output lock failed".to_string())?.len();
    { let writer = shell.writer.lock().await; writer.data_bytes(format!("{}\nprintf '\\n{}\\n'\r", command.trim(), marker).into_bytes()).await.map_err(|error| error.to_string())?; }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let data = shell.output.lock().map_err(|_| "SSH terminal output lock failed".to_string())?.get(start..).unwrap_or_default().to_vec();
        let text = String::from_utf8_lossy(&data).into_owned();
        if let Some(index) = text.find(&marker) { return Ok(text[..index].to_string()); }
        if tokio::time::Instant::now() >= deadline { return Err("Interactive command timed out".into()); }
        tokio::time::timeout(Duration::from_secs(2), shell.notify.notified()).await.ok();
    }
}

#[tauri::command]
pub async fn resize_interactive_ssh_terminal(session_id: String, columns: u32, rows: u32) -> Result<(), String> {
    let shell = interactive().lock().map_err(|_| "SSH terminal lock failed")?.get(&session_id).cloned().ok_or_else(|| "SSH terminal is not connected".to_string())?;
    let result = shell.writer.lock().await.window_change(columns.max(20), rows.max(5), 0, 0).await.map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub async fn close_interactive_ssh_terminal(session_id: String) -> Result<(), String> {
    let shell = {
        let mut sessions = interactive().lock().map_err(|_| "SSH terminal lock failed")?;
        sessions.remove(&session_id)
    };
    if let Some(shell) = shell { let _ = shell.writer.lock().await.close().await; }
    Ok(())
}

pub async fn run_session_command(session_id: &str, command: &str, approved: bool) -> Result<String, String> {
    let lowered = command.to_ascii_lowercase();
    let risky = ["sudo ", "rm ", "mv ", "chmod ", "chown ", "systemctl ", "service ", "reboot", "shutdown", "docker rm", "docker stop", "docker restart", "apt install", "apt remove", "apt purge", "apt upgrade", "dnf install", "dnf remove", "yum install", "yum update"].iter().any(|token| lowered.contains(token));
    if risky && !approved { return Err("This command requires explicit approval".into()); }
    let session = sessions().lock().map_err(|_| "SSH session lock failed".to_string())?.get(session_id).cloned().ok_or_else(|| "SSH session is not available".to_string())?;
    let mut channel = session.channel_open_session().await.map_err(|error| error.to_string())?;
    channel.exec(true, command.trim()).await.map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    while let Some(message) = channel.wait().await { if let ChannelMsg::Data { data } = message { output.extend_from_slice(&data); } }
    Ok(String::from_utf8_lossy(&output).to_string())
}

#[tauri::command]
pub async fn execute_ssh_command(session_id: String, command: String, approved: bool) -> Result<String, String> {
    run_session_command(&session_id, &command, approved).await
}

#[tauri::command]
pub fn close_ssh_session(session_id: String) -> Result<(), String> {
    sessions().lock().map_err(|_| "SSH session lock failed".to_string())?.remove(&session_id);
    Ok(())
}
