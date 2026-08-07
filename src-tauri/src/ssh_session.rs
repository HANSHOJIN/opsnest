use russh::{client, keys, ChannelMsg, Pty};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
use tokio::sync::Notify;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

struct Handler {
    host: String,
    port: u16,
}
impl client::Handler for Handler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match keys::known_hosts::check_known_hosts(&self.host, self.port, key)? {
            true => Ok(true),
            false => {
                keys::known_hosts::learn_known_hosts(&self.host, self.port, key)?;
                Ok(true)
            }
        }
    }
}

type Session = client::Handle<Handler>;
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct InteractiveShell {
    writer: tokio::sync::Mutex<russh::ChannelWriteHalf<client::Msg>>,
    output: Mutex<Vec<u8>>,
    notify: Notify,
    blackboard: Mutex<BlackboardState>,
    last_activity: AtomicU64,
}
static INTERACTIVE: OnceLock<Mutex<HashMap<String, Arc<InteractiveShell>>>> = OnceLock::new();
static INTERACTIVE_REAPER: OnceLock<()> = OnceLock::new();
const INTERACTIVE_IDLE_SECS: u64 = 30 * 60;
fn interactive() -> &'static Mutex<HashMap<String, Arc<InteractiveShell>>> {
    INTERACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn prompt_seen_after_marker(text: &str, marker_end: usize) -> bool {
    let suffix = text.get(marker_end..).unwrap_or_default().replace('\r', "");
    let line = suffix.rsplit('\n').next().unwrap_or_default().trim_end();
    if line.is_empty() {
        return false;
    }
    // A PTY prompt is emitted by the shell after the marker command exits.
    // Do not assume a timing window: wait for the prompt itself. This covers
    // the common sh/bash/zsh forms without requiring us to rewrite PS1.
    line.ends_with("#") || line.ends_with('$') || line.ends_with('>')
}

fn touch_activity(shell: &InteractiveShell) {
    shell.last_activity.store(unix_seconds(), Ordering::Relaxed);
}

fn start_interactive_reaper() {
    if INTERACTIVE_REAPER.set(()).is_err() {
        return;
    }
    tokio::spawn(async {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        loop {
            ticker.tick().await;
            let now = unix_seconds();
            let expired = {
                let Ok(mut sessions) = interactive().lock() else {
                    continue;
                };
                let ids = sessions
                    .iter()
                    .filter_map(|(id, shell)| {
                        (now.saturating_sub(shell.last_activity.load(Ordering::Relaxed))
                            >= INTERACTIVE_IDLE_SECS)
                            .then(|| id.clone())
                    })
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| sessions.remove(&id))
                    .collect::<Vec<_>>()
            };
            for shell in expired {
                let _ = shell.writer.lock().await.close().await;
                shell.notify.notify_waiters();
            }
        }
    });
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub session_id: String,
    pub data: String,
    pub closed: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlackboardEvent {
    pub sequence: u64,
    pub kind: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlackboardSnapshot {
    pub session_id: String,
    pub cwd: Option<String>,
    pub events: Vec<BlackboardEvent>,
}

struct BlackboardState {
    cwd: Option<String>,
    next_sequence: u64,
    events: VecDeque<BlackboardEvent>,
}

fn new_blackboard() -> Mutex<BlackboardState> {
    Mutex::new(BlackboardState {
        cwd: None,
        next_sequence: 1,
        events: VecDeque::with_capacity(256),
    })
}

fn append_blackboard(shell: &InteractiveShell, kind: &str, text: impl Into<String>) {
    touch_activity(shell);
    let Ok(mut state) = shell.blackboard.lock() else {
        return;
    };
    let text = text.into();
    if kind == "terminal_output" && text.trim().is_empty() {
        return;
    }
    let event = BlackboardEvent {
        sequence: state.next_sequence,
        kind: kind.to_string(),
        text,
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    state.next_sequence += 1;
    state.events.push_back(event);
    while state.events.len() > 300 {
        state.events.pop_front();
    }
}

fn snapshot_blackboard(shell: &InteractiveShell, session_id: &str) -> BlackboardSnapshot {
    let Ok(state) = shell.blackboard.lock() else {
        return BlackboardSnapshot {
            session_id: session_id.to_string(),
            cwd: None,
            events: Vec::new(),
        };
    };
    BlackboardSnapshot {
        session_id: session_id.to_string(),
        cwd: state.cwd.clone(),
        events: state.events.iter().cloned().collect(),
    }
}

pub fn session_context(session_id: &str, max_chars: usize) -> String {
    let Some(shell) = interactive()
        .lock()
        .ok()
        .and_then(|items| items.get(session_id).cloned())
    else {
        return String::new();
    };
    let snapshot = snapshot_blackboard(&shell, session_id);
    let mut lines = Vec::new();
    if let Some(cwd) = snapshot.cwd {
        lines.push(format!("当前工作目录：{cwd}"));
    }
    for event in snapshot.events.iter().rev() {
        // Marker lines are an internal synchronization detail of the PTY command
        // runner. Keep the surrounding output for the model, but never expose
        // the opaque marker token itself as useful terminal context.
        let mut text = event.text.clone();
        while let Some(start) = text.find("__OPSNEST_INTERACTIVE_END_") {
            let remainder = &text[start + "__OPSNEST_INTERACTIVE_END_".len()..];
            if let Some(end) = remainder.find("__") {
                text.replace_range(
                    start..start + "__OPSNEST_INTERACTIVE_END_".len() + end + 2,
                    "",
                );
            } else {
                text.truncate(start);
                break;
            }
        }
        lines.push(format!("[{}] {}", event.kind, text));
        if lines.join("\n").len() >= max_chars {
            break;
        }
    }
    lines.reverse();
    let context = lines.join("\n");
    if context.chars().count() > max_chars {
        context
            .chars()
            .rev()
            .take(max_chars)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    } else {
        context
    }
}

async fn connect(request: &SessionRequest) -> Result<Session, String> {
    let host = request.host.trim();
    if host.is_empty() || request.username.trim().is_empty() {
        return Err("SSH host and username are required".into());
    }
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(10)),
        keepalive_max: 0,
        ..Default::default()
    };
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(
            Arc::new(config),
            format!("{host}:{}", request.port),
            Handler {
                host: host.to_string(),
                port: request.port,
            },
        ),
    )
    .await
    .map_err(|_| "SSH connection timed out".to_string())?
    .map_err(|error| format!("SSH handshake failed: {error}"))?;
    let authenticated = if request.auth_method == "password" {
        session
            .authenticate_password(
                request.username.trim(),
                request.password.as_deref().unwrap_or(""),
            )
            .await
            .map_err(|error| format!("SSH login failed: {error}"))?
    } else {
        let path = request
            .private_key_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "SSH private key is required".to_string())?;
        let key = keys::load_secret_key(path, request.passphrase.as_deref())
            .map_err(|error| format!("Unable to read SSH key: {error}"))?;
        session
            .authenticate_publickey(
                request.username.trim(),
                keys::PrivateKeyWithHashAlg::new(
                    Arc::new(key),
                    session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|error| error.to_string())?
                        .flatten(),
                ),
            )
            .await
            .map_err(|error| format!("SSH login failed: {error}"))?
    };
    if !authenticated.success() {
        return Err("SSH server rejected the login".into());
    }
    Ok(session)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionResult {
    pub session_id: String,
}

#[tauri::command]
pub async fn open_ssh_session(request: SessionRequest) -> Result<OpenSessionResult, String> {
    let session = Arc::new(connect(&request).await?);
    let id = format!(
        "ssh-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    sessions()
        .lock()
        .map_err(|_| "SSH session lock failed".to_string())?
        .insert(id.clone(), session);
    Ok(OpenSessionResult { session_id: id })
}

#[tauri::command]
pub async fn open_interactive_ssh_terminal(
    app: tauri::AppHandle,
    request: SessionRequest,
    session_id: String,
) -> Result<bool, String> {
    start_interactive_reaper();
    if interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed")?
        .contains_key(&session_id)
    {
        return Ok(false);
    }
    let session = connect(&request).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    let _ = channel
        // Disable remote line echo at PTY allocation time. Sending a later
        // `stty -echo` command makes bash print an extra prompt.
        .request_pty(false, "xterm-256color", 240, 40, 0, 0, &[(Pty::ECHO, 0)])
        .await;
    let (mut reader, writer) = channel.split();
    writer
        .request_shell(true)
        .await
        .map_err(|error| error.to_string())?;
    let shell = Arc::new(InteractiveShell {
        writer: tokio::sync::Mutex::new(writer),
        output: Mutex::new(Vec::new()),
        notify: Notify::new(),
        blackboard: new_blackboard(),
        last_activity: AtomicU64::new(unix_seconds()),
    });
    append_blackboard(&shell, "session_opened", "SSH interactive session opened");
    interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed")?
        .insert(session_id.clone(), shell.clone());
    tokio::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    if let Ok(mut output) = shell.output.lock() {
                        output.extend_from_slice(&data);
                    }
                    append_blackboard(&shell, "terminal_output", text.clone());
                    shell.notify.notify_waiters();
                    let _ = app.emit(
                        "ssh-terminal-output",
                        TerminalEvent {
                            session_id: session_id.clone(),
                            data: text,
                            closed: false,
                        },
                    );
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = app.emit(
            "ssh-terminal-output",
            TerminalEvent {
                session_id: session_id.clone(),
                data: String::new(),
                closed: true,
            },
        );
        // Do not leave a dead PTY in the session pool. Otherwise the next
        // attempt reuses a closed channel and the UI can show stale prompts.
        let _ = interactive().lock().map(|mut sessions| sessions.remove(&session_id));
    });
    Ok(true)
}

#[tauri::command]
pub async fn write_interactive_ssh_terminal(
    session_id: String,
    data: String,
) -> Result<(), String> {
    let shell = interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed")?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "SSH terminal is not connected".to_string())?;
    touch_activity(&shell);
    let normalized = data.replace('\r', "").replace('\n', "");
    if !normalized.trim().is_empty() && normalized.trim() != "stty -echo" {
        append_blackboard(&shell, "user_input", normalized);
    }
    let result = shell
        .writer
        .lock()
        .await
        .data_bytes(data.into_bytes())
        .await
        .map_err(|error| error.to_string());
    result
}

pub fn record_session_event(
    session_id: &str,
    kind: &str,
    text: impl Into<String>,
) -> Result<(), String> {
    let shell = interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH terminal is not connected".to_string())?;
    append_blackboard(&shell, kind, text);
    Ok(())
}

#[tauri::command]
pub fn get_ssh_session_blackboard(session_id: String) -> Result<BlackboardSnapshot, String> {
    let shell = interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "SSH terminal is not connected".to_string())?;
    Ok(snapshot_blackboard(&shell, &session_id))
}

pub async fn run_interactive_command(
    session_id: &str,
    command: &str,
    approved: bool,
) -> Result<String, String> {
    let lowered = command.to_ascii_lowercase();
    let risky = [
        "sudo ",
        "rm ",
        "mv ",
        "chmod ",
        "chown ",
        "systemctl ",
        "service ",
        "reboot",
        "shutdown",
        "docker rm",
        "docker stop",
        "docker restart",
        "apt install",
        "apt remove",
        "apt purge",
        "apt upgrade",
    ]
    .iter()
    .any(|token| lowered.contains(token));
    if risky && !approved {
        return Err("This command requires explicit approval".into());
    }
    let shell = interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH terminal is not connected".to_string())?;
    let marker = format!(
        "__OPSNEST_INTERACTIVE_END_{}__",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    append_blackboard(&shell, "ai_command", command.trim().to_string());
    let start = shell
        .output
        .lock()
        .map_err(|_| "SSH terminal output lock failed".to_string())?
        .len();
    {
        let writer = shell.writer.lock().await;
        writer
            // Keep the marker on its own line without injecting a leading
            // blank line or a second carriage-return command. The previous
            // `printf '\nmarker\n'\r` sequence made the PTY redraw an extra
            // prompt after otherwise simple commands.
            .data_bytes(format!("{}\nprintf '%s\\n' '{}'\n", command.trim(), marker).into_bytes())
            .await
            .map_err(|error| error.to_string())?;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let data = shell
            .output
            .lock()
            .map_err(|_| "SSH terminal output lock failed".to_string())?
            .get(start..)
            .unwrap_or_default()
            .to_vec();
        let text = String::from_utf8_lossy(&data).into_owned();
        if let Some(index) = text.find(&marker) {
            let marker_end = index + marker.len();
            if prompt_seen_after_marker(&text, marker_end) {
                // Return only command output. The prompt remains in the PTY
                // stream and is rendered once by the terminal listener.
                return Ok(text[..index].to_string());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Interactive command timed out".into());
        }
        tokio::time::timeout(Duration::from_secs(2), shell.notify.notified())
            .await
            .ok();
    }
}

#[tauri::command]
pub async fn execute_interactive_ssh_command(
    session_id: String,
    command: String,
) -> Result<String, String> {
    run_interactive_command(&session_id, &command, true).await
}

#[tauri::command]
pub async fn resize_interactive_ssh_terminal(
    session_id: String,
    columns: u32,
    rows: u32,
) -> Result<(), String> {
    let shell = interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed")?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "SSH terminal is not connected".to_string())?;
    touch_activity(&shell);
    let result = shell
        .writer
        .lock()
        .await
        .window_change(columns.max(20), rows.max(5), 0, 0)
        .await
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub async fn close_interactive_ssh_terminal(session_id: String) -> Result<(), String> {
    let shell = {
        let mut sessions = interactive()
            .lock()
            .map_err(|_| "SSH terminal lock failed")?;
        sessions.remove(&session_id)
    };
    if let Some(shell) = shell {
        let _ = shell.writer.lock().await.close().await;
    }
    Ok(())
}

pub async fn run_session_command(
    session_id: &str,
    command: &str,
    approved: bool,
) -> Result<String, String> {
    let lowered = command.to_ascii_lowercase();
    let risky = [
        "sudo ",
        "rm ",
        "mv ",
        "chmod ",
        "chown ",
        "systemctl ",
        "service ",
        "reboot",
        "shutdown",
        "docker rm",
        "docker stop",
        "docker restart",
        "apt install",
        "apt remove",
        "apt purge",
        "apt upgrade",
        "dnf install",
        "dnf remove",
        "yum install",
        "yum update",
    ]
    .iter()
    .any(|token| lowered.contains(token));
    if risky && !approved {
        return Err("This command requires explicit approval".into());
    }
    let session = sessions()
        .lock()
        .map_err(|_| "SSH session lock failed".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH session is not available".to_string())?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    channel
        .exec(true, command.trim())
        .await
        .map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    while let Some(message) = channel.wait().await {
        if let ChannelMsg::Data { data } = message {
            output.extend_from_slice(&data);
        }
    }
    Ok(String::from_utf8_lossy(&output).to_string())
}

#[tauri::command]
pub async fn execute_ssh_command(
    session_id: String,
    command: String,
    approved: bool,
) -> Result<String, String> {
    run_session_command(&session_id, &command, approved).await
}

#[tauri::command]
pub fn close_ssh_session(session_id: String) -> Result<(), String> {
    sessions()
        .lock()
        .map_err(|_| "SSH session lock failed".to_string())?
        .remove(&session_id);
    Ok(())
}
