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
use tokio::io::{duplex, AsyncWriteExt};
use tokio::sync::{oneshot, Notify};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub sudo_password: Option<String>,
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
    // Keep the credentials associated with the already-open PTY in backend
    // memory. AI read-only tools can open a short-lived SFTP/scan connection
    // without asking the frontend to send credentials through the model
    // request, and without coupling those tools to PTY output ordering.
    request: SessionRequest,
    writer: tokio::sync::Mutex<russh::ChannelWriteHalf<client::Msg>>,
    // One interactive PTY has one input stream. The direct terminal and AI
    // tool loop must not write to it concurrently.
    execution: tokio::sync::Mutex<()>,
    output: Mutex<Vec<u8>>,
    notify: Notify,
    blackboard: Mutex<BlackboardState>,
    last_activity: AtomicU64,
}
static INTERACTIVE: OnceLock<Mutex<HashMap<String, Arc<InteractiveShell>>>> = OnceLock::new();
static INTERACTIVE_REAPER: OnceLock<()> = OnceLock::new();
// Keep the interactive PTY alive across ordinary panel collapse/tab switches.
// The SSH transport has its own keepalive; reaping after 30 minutes made a
// still-open user session unexpectedly turn into "SSH terminal is not
// connected". Only reap sessions that have genuinely been abandoned for a
// long period.
const INTERACTIVE_IDLE_SECS: u64 = 8 * 60 * 60;
fn interactive() -> &'static Mutex<HashMap<String, Arc<InteractiveShell>>> {
    INTERACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
        // Agent lifecycle events are durable UI/audit facts, not model
        // context. Keep the event log replayable without leaking internal
        // phase JSON into the next prompt.
        if event.kind == "agent_phase" {
            continue;
        }
        // Marker lines are an internal synchronization detail of the PTY command
        // runner. Keep the surrounding output for the model, but never expose
        // the opaque marker token itself as useful terminal context.
        let mut text = event.text.clone();
        for prefix in ["__OPSNEST_INTERACTIVE_START_", "__OPSNEST_INTERACTIVE_END_"] {
            while let Some(start) = text.find(prefix) {
                let remainder = &text[start + prefix.len()..];
                if let Some(end) = remainder.find("__") {
                    text.replace_range(start..start + prefix.len() + end + 2, "");
                } else {
                    text.truncate(start);
                    break;
                }
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

/// Return durable user/assistant turns from the shared terminal blackboard so
/// follow-up AI requests keep their conversational context after a new UI
/// render or terminal tab mount.
pub fn conversation_history(session_id: &str, max_chars: usize) -> Vec<(String, String)> {
    let Some(shell) = interactive()
        .lock()
        .ok()
        .and_then(|items| items.get(session_id).cloned())
    else {
        return Vec::new();
    };
    let Ok(state) = shell.blackboard.lock() else {
        return Vec::new();
    };
    let mut history = Vec::new();
    let mut used = 0usize;
    for event in state.events.iter().rev() {
        let role = match event.kind.as_str() {
            "user_message" | "user_question" => "user",
            "ai_message" | "ai_tool_result" => "assistant",
            _ => continue,
        };
        let mut text = event.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > 8000 {
            text = text
                .chars()
                .rev()
                .take(8000)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
        let cost = text.chars().count();
        if used + cost > max_chars {
            break;
        }
        used += cost;
        history.push((role.to_string(), text));
    }
    if history.len() > 200 {
        history.truncate(200);
    }
    history.reverse();
    history
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

/// Opens a dedicated SFTP subsystem. File management must not share the
/// interactive shell or emulate transfers with shell commands.
pub async fn open_sftp_session(
    request: &SessionRequest,
) -> Result<russh_sftp::client::SftpSession, String> {
    let session = connect(request).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| error.to_string())?;
    russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("SFTP subsystem unavailable: {error}"))
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

/// Verifies that the supplied SSH credentials can authenticate successfully.
/// This intentionally does not register a reusable session: a successful test
/// only proves the credentials, it must never create a phantom "connected"
/// terminal in the UI.
#[tauri::command]
pub async fn test_ssh_connection(request: SessionRequest) -> Result<String, String> {
    let _session = connect(&request).await?;
    Ok("SSH authentication successful".to_string())
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
        request: request.clone(),
        writer: tokio::sync::Mutex::new(writer),
        execution: tokio::sync::Mutex::new(()),
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
                    let _ = app.emit(
                        "ssh-terminal-output",
                        TerminalEvent {
                            session_id: session_id.clone(),
                            data: text,
                            closed: false,
                        },
                    );
                    // Publish the visible PTY bytes before waking the AI tool
                    // waiter. This preserves terminal ordering when the tool
                    // result immediately starts a model summary request.
                    shell.notify.notify_waiters();
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
        let _ = interactive()
            .lock()
            .map(|mut sessions| sessions.remove(&session_id));
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
    // Ctrl+C must still interrupt an in-flight remote command. Ordinary
    // terminal input waits until an AI command owns and releases the PTY.
    let _execution = if data == "\x03" {
        None
    } else {
        Some(shell.execution.lock().await)
    };
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

/// Converts a leading `sudo` into a non-interactive sudo invocation while
/// keeping the password out of the command string. Commands without an
/// explicitly configured sudo credential retain their original behavior.
fn prepare_sudo_command<'a>(
    command: &'a str,
    sudo_password: Option<&'a str>,
) -> (String, Option<&'a str>) {
    let trimmed = command.trim();
    let Some(password) = sudo_password.filter(|value| !value.is_empty()) else {
        return (trimmed.to_string(), None);
    };
    let Some(rest) = trimmed.strip_prefix("sudo ") else {
        return (trimmed.to_string(), None);
    };
    (format!("sudo -S -p '' {rest}"), Some(password))
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

pub struct InteractiveCommandResult {
    pub output: String,
    pub terminal_marker: String,
}

/// Returns the credentials for an existing interactive terminal to backend
/// code only. The value is never serialized into model messages or emitted to
/// the frontend.
pub fn session_request(session_id: &str) -> Result<SessionRequest, String> {
    let shell = interactive()
        .lock()
        .map_err(|_| "SSH terminal lock failed".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH interactive session is not connected".to_string())?;
    touch_activity(&shell);
    Ok(shell.request.clone())
}

fn command_result_error(error: impl ToString) -> String {
    format!("__OPSNEST_COMMAND_ERROR__{}", error.to_string())
}

pub async fn run_interactive_command_with_marker(
    session_id: &str,
    command: &str,
    approved: bool,
    sudo_password: Option<&str>,
) -> Result<InteractiveCommandResult, String> {
    run_interactive_command_with_marker_inner(session_id, command, approved, sudo_password, None)
        .await
}

/// Variant used by the Agent loop.  The same cancellation signal that aborts
/// the model request also interrupts a running PTY command with Ctrl+C.
pub async fn run_interactive_command_with_marker_cancel(
    session_id: &str,
    command: &str,
    approved: bool,
    sudo_password: Option<&str>,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<InteractiveCommandResult, String> {
    run_interactive_command_with_marker_inner(
        session_id,
        command,
        approved,
        sudo_password,
        Some(cancel),
    )
    .await
}

async fn run_interactive_command_with_marker_inner(
    session_id: &str,
    command: &str,
    approved: bool,
    sudo_password: Option<&str>,
    mut cancel: Option<&mut oneshot::Receiver<()>>,
) -> Result<InteractiveCommandResult, String> {
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
    let marker_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let start_marker = format!("__OPSNEST_INTERACTIVE_START_{marker_id}__");
    let marker = format!("__OPSNEST_INTERACTIVE_END_{marker_id}__");
    // Keep the completion marker and the following real shell prompt atomic
    // relative to direct input and other tool commands.
    let _execution = if let Some(cancel_receiver) = cancel.as_deref_mut() {
        tokio::select! {
            guard = tokio::time::timeout(Duration::from_secs(120), shell.execution.lock()) => {
                match guard {
                    Ok(guard) => guard,
                    Err(_) => {
                        return Ok(InteractiveCommandResult {
                            output: command_result_error("Interactive command queue timed out"),
                            terminal_marker: String::new(),
                        })
                    }
                }
            }
            _ = cancel_receiver => {
                return Err("AI-SSH command cancelled".into());
            }
        }
    } else {
        match tokio::time::timeout(Duration::from_secs(120), shell.execution.lock()).await {
            Ok(guard) => guard,
            Err(_) => {
                return Ok(InteractiveCommandResult {
                    output: command_result_error("Interactive command queue timed out"),
                    terminal_marker: String::new(),
                })
            }
        }
    };
    append_blackboard(&shell, "ai_command", command.trim().to_string());
    let (command_to_run, sudo_password) = prepare_sudo_command(command, sudo_password);
    let start = shell
        .output
        .lock()
        .map_err(|_| "SSH terminal output lock failed".to_string())?
        .len();
    {
        let writer = shell.writer.lock().await;
        if let Err(error) = writer
            // Emit a self-contained completion record. The command's exit
            // code is captured before the marker, so completion never depends
            // on a prompt arriving within an arbitrary timing window.
            // Keep the command and completion marker in one shell input line.
            // Sending them as two lines makes an interactive shell print a
            // prompt after the command and another prompt after the marker,
            // which leaks duplicate prompts into the terminal blackboard.
            // Remote echo is disabled. The start/end records turn the PTY
            // stream into an explicit transaction, so the UI never has to
            // clear rows or guess where the previous prompt ended.
            .data_bytes(
                format!(
                    "printf '\\r\\n{}\\r\\n'; {}; rc=$?; printf '{} rc=%s\\n' \"$rc\"\n",
                    start_marker, command_to_run, marker
                )
                .into_bytes(),
            )
            .await
        {
            return Ok(InteractiveCommandResult {
                output: command_result_error(error),
                terminal_marker: String::new(),
            });
        }
        // `sudo -S` reads this directly from the PTY after the command has
        // started. The password is not part of the shell command, terminal
        // output, blackboard, model request, or portable JSON files.
        if let Some(password) = sudo_password {
            if let Err(error) = writer
                .data_bytes(format!("{password}\n").into_bytes())
                .await
            {
                return Ok(InteractiveCommandResult {
                    output: command_result_error(error),
                    terminal_marker: String::new(),
                });
            }
        }
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
            // Return only command output. The marker line is the protocol
            // boundary; the following shell prompt remains in the PTY stream
            // and is rendered once by the terminal listener.
            let output_start = text
                .find(&start_marker)
                .map(|start_index| start_index + start_marker.len())
                .unwrap_or_default();
            return Ok(InteractiveCommandResult {
                output: text[output_start..index]
                    .trim_matches(['\r', '\n'])
                    .to_string(),
                terminal_marker: marker,
            });
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(InteractiveCommandResult {
                output: command_result_error("Interactive command timed out"),
                terminal_marker: marker,
            });
        }
        if let Some(cancel_receiver) = cancel.as_deref_mut() {
            tokio::select! {
                _ = cancel_receiver => {
                    let _ = shell
                        .writer
                        .lock()
                        .await
                        .data_bytes(vec![3])
                        .await;
                    return Err("AI-SSH command cancelled".into());
                }
                _ = tokio::time::timeout(Duration::from_secs(2), shell.notify.notified()) => {}
            }
        } else {
            tokio::time::timeout(Duration::from_secs(2), shell.notify.notified())
                .await
                .ok();
        }
    }
}

pub async fn run_interactive_command(
    session_id: &str,
    command: &str,
    approved: bool,
    sudo_password: Option<&str>,
) -> Result<String, String> {
    Ok(
        run_interactive_command_with_marker(session_id, command, approved, sudo_password)
            .await?
            .output,
    )
}

#[tauri::command]
pub async fn execute_interactive_ssh_command(
    session_id: String,
    command: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    run_interactive_command(&session_id, &command, true, sudo_password.as_deref()).await
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
    sudo_password: Option<&str>,
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
    let (command_to_run, sudo_password) = prepare_sudo_command(command, sudo_password);
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
        .exec(true, command_to_run)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(password) = sudo_password {
        let password_bytes = format!("{password}\n").into_bytes();
        let (mut password_writer, password_reader) = duplex(password_bytes.len());
        password_writer
            .write_all(&password_bytes)
            .await
            .map_err(|error| error.to_string())?;
        drop(password_writer);
        channel
            .data(password_reader)
            .await
            .map_err(|error| error.to_string())?;
    }
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
    sudo_password: Option<String>,
) -> Result<String, String> {
    run_session_command(&session_id, &command, approved, sudo_password.as_deref()).await
}

#[tauri::command]
pub fn close_ssh_session(session_id: String) -> Result<(), String> {
    sessions()
        .lock()
        .map_err(|_| "SSH session lock failed".to_string())?
        .remove(&session_id);
    Ok(())
}
