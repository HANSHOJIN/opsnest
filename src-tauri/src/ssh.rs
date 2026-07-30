use russh::{client, keys, ChannelMsg, Disconnect, Sig};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    #[serde(default)]
    pub sudo_password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub command_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

static COMMAND_CANCELLATIONS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    OnceLock::new();
static PERSISTENT_SHELLS: OnceLock<Mutex<HashMap<String, Arc<PersistentShell>>>> = OnceLock::new();
static INTERACTIVE_SHELLS: OnceLock<Mutex<HashMap<String, Arc<InteractiveShell>>>> =
    OnceLock::new();
static SHELL_COMMAND_COUNTER: AtomicU64 = AtomicU64::new(1);

fn command_cancellations() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    COMMAND_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn persistent_shells() -> &'static Mutex<HashMap<String, Arc<PersistentShell>>> {
    PERSISTENT_SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn interactive_shells() -> &'static Mutex<HashMap<String, Arc<InteractiveShell>>> {
    INTERACTIVE_SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResponse {
    pub system: String,
    pub latency_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWrtProfile {
    pub model: String,
    pub firmware: String,
    pub kernel: String,
    pub wan_ip: String,
    pub lan_ip: String,
    pub lan_clients: String,
    pub wifi_clients: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NasProfile {
    pub kind: String,
    pub version: String,
    pub management_port: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub os_id: String,
    pub os_version: String,
    pub os_name: String,
    pub hostname: String,
    pub cpu_cores: String,
    pub cpu_model: String,
    pub memory: String,
    pub disk: String,
    pub docker_installed: bool,
    pub docker_containers: String,
    pub docker_items: Vec<DockerContainer>,
    pub openwrt: Option<OpenWrtProfile>,
    pub nas: Option<NasProfile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredService {
    pub id: String,
    pub name: String,
    pub category: String,
    pub status: String,
    pub version: String,
    pub port: Option<u16>,
    pub web: bool,
    pub web_path: Option<String>,
    pub web_scheme: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisResult {
    pub label: String,
    pub command: String,
    pub output: String,
    pub success: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub name: String,
    pub source: String,
    pub user: String,
    pub schedule: String,
    pub command: String,
    pub enabled: bool,
    pub editable: bool,
    pub detail: String,
}

struct OpsNestHandler {
    host: String,
    port: u16,
}

impl client::Handler for OpsNestHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match keys::known_hosts::check_known_hosts(&self.host, self.port, server_public_key)? {
            true => Ok(true),
            false => {
                keys::known_hosts::learn_known_hosts(&self.host, self.port, server_public_key)?;
                Ok(true)
            }
        }
    }
}

async fn connect_session(
    request: &SshTestRequest,
) -> Result<client::Handle<OpsNestHandler>, String> {
    let host = request.host.trim();
    let username = request.username.trim();
    if host.is_empty() {
        return Err("请输入服务器地址。".into());
    }
    if username.is_empty() {
        return Err("请输入用户名。".into());
    }

    let config = client::Config {
        // Agent runs can spend longer than 15 seconds thinking, diagnosing or
        // waiting for a model. Do not kill an otherwise healthy Shell during
        // that quiet period; use SSH keepalives to detect a real disconnect.
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(10)),
        // Some Dropbear/OpenWrt SSH servers do not acknowledge every
        // keepalive request. A small finite limit makes a healthy idle shell
        // look disconnected after a few minutes. Zero means unlimited missed
        // keepalives; real socket failure is still reported by russh.
        keepalive_max: 0,
        ..Default::default()
    };
    let handler = OpsNestHandler {
        host: host.to_string(),
        port: request.port,
    };
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(
            Arc::new(config),
            format!("{host}:{}", request.port),
            handler,
        ),
    )
    .await
    .map_err(|_| "SSH 连接超时，请检查地址、端口和网络。".to_string())?
    .map_err(|error| format!("SSH 握手失败：{error}"))?;

    let auth_result = match request.auth_method.as_str() {
        "password" => session
            .authenticate_password(username, request.password.as_deref().unwrap_or(""))
            .await
            .map_err(|error| format!("SSH 登录失败：{error}"))?,
        "privateKey" => {
            let path = request
                .private_key_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "请选择 SSH 私钥文件。".to_string())?;
            let key = keys::load_secret_key(path, request.passphrase.as_deref())
                .map_err(|error| format!("读取 SSH 私钥失败：{error}"))?;
            session
                .authenticate_publickey(
                    username,
                    keys::PrivateKeyWithHashAlg::new(
                        Arc::new(key),
                        session
                            .best_supported_rsa_hash()
                            .await
                            .map_err(|error| format!("读取 SSH 算法失败：{error}"))?
                            .flatten(),
                    ),
                )
                .await
                .map_err(|error| format!("SSH 登录失败：{error}"))?
        }
        _ => return Err("暂不支持这种登录方式。".into()),
    };

    if !auth_result.success() {
        return Err("服务器拒绝了登录请求，请检查用户名、密码或私钥。".into());
    }
    Ok(session)
}

async fn measure_tcp_latency(request: &SshTestRequest) -> Result<u64, String> {
    let started = Instant::now();
    let address = format!("{}:{}", request.host.trim(), request.port);
    tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect(address),
    )
    .await
    .map_err(|_| "连接 SSH 端口超时。".to_string())?
    .map_err(|error| format!("无法连接 SSH 端口：{error}"))?;
    Ok(started.elapsed().as_millis().min(u64::MAX as u128).max(1) as u64)
}

async fn run_command(
    session: &client::Handle<OpsNestHandler>,
    command: &str,
    mut cancellation: Option<oneshot::Receiver<()>>,
) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("已登录，但无法打开远程会话：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("无法执行远程命令：{error}"))?;

    let mut output = Vec::new();
    loop {
        let message = match cancellation.as_mut() {
            Some(receiver) => tokio::select! {
                _ = receiver => return Err("命令已停止".to_string()),
                message = channel.wait() => message,
            },
            None => channel.wait().await,
        };
        let Some(message) = message else {
            break;
        };
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                output.extend_from_slice(&data);
            }
            // Some SSH servers send the exit status before flushing the last
            // stdout/stderr bytes. Keep draining until the channel closes so
            // short commands such as `hermes --version` cannot lose output.
            ChannelMsg::ExitStatus { .. } => {}
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

struct PersistentShell {
    session: client::Handle<OpsNestHandler>,
    writer: tokio::sync::Mutex<russh::ChannelWriteHalf<client::Msg>>,
    output: tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>,
    command_lock: tokio::sync::Mutex<()>,
}

struct InteractiveShell {
    session: client::Handle<OpsNestHandler>,
    writer: tokio::sync::Mutex<russh::ChannelWriteHalf<client::Msg>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshTerminalEvent {
    session_id: String,
    data: String,
    closed: bool,
}

async fn create_persistent_shell(request: &SshTestRequest) -> Result<Arc<PersistentShell>, String> {
    let session = connect_session(request).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("已登录，但无法打开持久 SSH 会话：{error}"))?;
    let (mut reader, writer) = channel.split();
    writer
        .request_shell(true)
        .await
        .map_err(|error| format!("无法启动远程 Shell：{error}"))?;

    let (output_sender, output_receiver) = mpsc::channel::<Vec<u8>>(256);
    tokio::spawn(async move {
        while let Some(message) = reader.wait().await {
            let bytes = match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => data.to_vec(),
                ChannelMsg::Close => break,
                _ => continue,
            };
            if output_sender.send(bytes).await.is_err() {
                break;
            }
        }
    });

    Ok(Arc::new(PersistentShell {
        session,
        writer: tokio::sync::Mutex::new(writer),
        output: tokio::sync::Mutex::new(output_receiver),
        command_lock: tokio::sync::Mutex::new(()),
    }))
}

async fn persistent_shell_for(
    request: &SshTestRequest,
    session_id: &str,
) -> Result<Arc<PersistentShell>, String> {
    if let Some(shell) = persistent_shells()
        .lock()
        .map_err(|_| "无法读取 SSH 会话表".to_string())?
        .get(session_id)
        .cloned()
    {
        return Ok(shell);
    }
    let shell = create_persistent_shell(request).await?;
    persistent_shells()
        .lock()
        .map_err(|_| "无法保存 SSH 会话".to_string())?
        .insert(session_id.to_string(), shell.clone());
    Ok(shell)
}

async fn receive_shell_output(shell: &PersistentShell) -> Option<Vec<u8>> {
    shell.output.lock().await.recv().await
}

async fn clear_pending_shell_output(shell: &PersistentShell) -> Result<(), String> {
    let mut output = shell.output.lock().await;
    loop {
        match output.try_recv() {
            Ok(_) => continue,
            Err(mpsc::error::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::error::TryRecvError::Disconnected) => return Err("SSH Shell 已断开".into()),
        }
    }
}

async fn interrupt_persistent_shell(shell: &PersistentShell) {
    let writer = shell.writer.lock().await;
    let _ = writer.data_bytes(vec![3]).await;
    let _ = writer.signal(Sig::INT).await;
}

async fn run_persistent_command(
    shell: &PersistentShell,
    command: &str,
    mut cancellation: Option<oneshot::Receiver<()>>,
) -> Result<String, String> {
    let _command_guard = shell.command_lock.lock().await;
    clear_pending_shell_output(shell).await?;

    let marker_id = SHELL_COMMAND_COUNTER.fetch_add(1, Ordering::Relaxed);
    let marker = format!("__OPSNEST_COMMAND_END_{marker_id}__");
    let script = format!("{command}\nprintf '\\n{marker}\\n'\n");
    shell
        .writer
        .lock()
        .await
        .data_bytes(script)
        .await
        .map_err(|error| format!("无法向远程 Shell 写入命令：{error}"))?;

    let mut output = Vec::new();
    let mut cancelled = false;
    loop {
        let chunk = if cancelled {
            receive_shell_output(shell).await
        } else {
            match cancellation.as_mut() {
                Some(receiver) => tokio::select! {
                    _ = receiver => {
                        cancelled = true;
                        interrupt_persistent_shell(shell).await;
                        continue;
                    }
                    chunk = receive_shell_output(shell) => chunk,
                },
                None => receive_shell_output(shell).await,
            }
        };
        let Some(chunk) = chunk else {
            return Err("SSH Shell 已断开".into());
        };
        output.extend_from_slice(&chunk);
        let text = String::from_utf8_lossy(&output);
        if let Some(marker_position) = text.find(&marker) {
            let result = text[..marker_position]
                .trim_matches(['\r', '\n'])
                .to_string();
            return if cancelled {
                Err("命令已停止".into())
            } else {
                Ok(result)
            };
        }
    }
}

async fn close_persistent_shell(session_id: &str) -> Result<(), String> {
    let shell = persistent_shells()
        .lock()
        .map_err(|_| "无法读取 SSH 会话表".to_string())?
        .remove(session_id);
    if let Some(shell) = shell {
        let _ = shell.writer.lock().await.close().await;
        close_session(&shell.session).await;
    }
    Ok(())
}

async fn close_interactive_shell(session_id: &str) -> Result<(), String> {
    let shell = interactive_shells()
        .lock()
        .map_err(|_| "无法读取交互式 SSH 会话表".to_string())?
        .remove(session_id);
    if let Some(shell) = shell {
        let _ = shell.writer.lock().await.close().await;
        close_session(&shell.session).await;
    }
    Ok(())
}

async fn create_interactive_shell(
    app: AppHandle,
    request: &SshTestRequest,
    session_id: &str,
) -> Result<(), String> {
    // A terminal panel can be remounted while the app is still open (for
    // example after switching views). Reuse the existing per-server PTY so a
    // view change never destroys the remote shell or its working directory.
    if interactive_shells()
        .lock()
        .map_err(|_| "无法读取交互式 SSH 会话表".to_string())?
        .contains_key(session_id)
    {
        return Ok(());
    }
    let session = connect_session(request).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("已登录，但无法打开交互式 SSH 会话：{error}"))?;
    let _ = channel
        .request_pty(false, "xterm-256color", 240, 40, 0, 0, &[])
        .await;
    let (mut reader, writer) = channel.split();
    writer
        .request_shell(true)
        .await
        .map_err(|error| format!("无法启动交互式 SSH Shell：{error}"))?;

    let shell = Arc::new(InteractiveShell {
        session,
        writer: tokio::sync::Mutex::new(writer),
    });
    interactive_shells()
        .lock()
        .map_err(|_| "无法保存交互式 SSH 会话".to_string())?
        .insert(session_id.to_string(), shell);

    let event_session_id = session_id.to_string();
    tokio::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let _ = app.emit(
                        "ssh-terminal-output",
                        SshTerminalEvent {
                            session_id: event_session_id.clone(),
                            data: String::from_utf8_lossy(&data).into_owned(),
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
            SshTerminalEvent {
                session_id: event_session_id,
                data: String::new(),
                closed: true,
            },
        );
    });
    Ok(())
}

async fn close_session(session: &client::Handle<OpsNestHandler>) {
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await;
}

fn value_for(output: &str, key: &str, fallback: &str) -> String {
    output
        .lines()
        .find_map(|line| line.strip_prefix(key).map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn clean_device_label(value: String, fallback: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.contains("default string")
        || normalized.contains("to be filled by o.e.m")
        || normalized == "system product name"
        || normalized == "unknown"
    {
        fallback.to_string()
    } else {
        value.trim().to_string()
    }
}

fn parse_docker_items(output: &str) -> Vec<DockerContainer> {
    output
        .lines()
        .filter_map(|line| {
            let fields = line
                .strip_prefix("OPSNEST_DOCKER_ITEM=")?
                .splitn(5, '|')
                .collect::<Vec<_>>();
            if fields.len() < 5 || fields[0].trim().is_empty() || fields[1].trim().is_empty() {
                return None;
            }
            Some(DockerContainer {
                id: fields[0].trim().to_string(),
                name: fields[1].trim().to_string(),
                image: fields[2].trim().to_string(),
                status: fields[3].trim().to_string(),
                ports: fields[4].trim().to_string(),
            })
        })
        .collect()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn cron_line_parts(line: &str, system: bool) -> Option<(String, String, String)> {
    let mut rest = line.trim();
    if rest.is_empty()
        || rest.starts_with('#')
        || rest.starts_with("SHELL=")
        || rest.starts_with("PATH=")
        || rest.starts_with("MAILTO=")
    {
        return None;
    }
    if rest.starts_with('@') {
        let mut fields = rest.splitn(3, char::is_whitespace);
        let schedule = fields.next()?.to_string();
        let (user, command) = if system {
            (
                fields.next()?.to_string(),
                fields.next()?.trim().to_string(),
            )
        } else {
            (
                String::new(),
                rest.split_once(char::is_whitespace)?.1.trim().to_string(),
            )
        };
        if command.is_empty() {
            return None;
        }
        return Some((schedule, user, command));
    }
    let field_count = if system { 6 } else { 5 };
    let mut fields = Vec::new();
    for _ in 0..field_count {
        let trimmed = rest.trim_start();
        let end = trimmed.find(char::is_whitespace)?;
        fields.push(trimmed[..end].to_string());
        rest = &trimmed[end..];
    }
    let command = rest.trim().to_string();
    if command.is_empty() {
        return None;
    }
    let schedule = fields[..5].join(" ");
    let user = if system {
        fields[5].clone()
    } else {
        String::new()
    };
    Some((schedule, user, command))
}

fn cron_marker(line: &str) -> Option<(String, String, bool)> {
    let rest = line.strip_prefix("# OPSNEST-ID:")?;
    let (id, rest) = rest.split_once(" NAME:")?;
    let (name, enabled) = rest.rsplit_once(" ENABLED:")?;
    if id.trim().is_empty() || name.trim().is_empty() {
        return None;
    }
    Some((
        id.trim().to_string(),
        name.trim().to_string(),
        enabled.trim() == "1",
    ))
}

fn parse_cron_output(output: &str, username: &str) -> Vec<CronTask> {
    let section = |begin: &str, end: &str| {
        output
            .split_once(&format!("{begin}\n"))
            .and_then(|(_, rest)| rest.split_once(&format!("\n{end}")))
            .map(|(value, _)| value)
            .unwrap_or("")
    };
    let user_section = section("OPSNEST_USER_CRON_BEGIN", "OPSNEST_USER_CRON_END");
    let system_section = section("OPSNEST_SYSTEM_CRON_BEGIN", "OPSNEST_SYSTEM_CRON_END");
    let timer_section = section("OPSNEST_TIMERS_BEGIN", "OPSNEST_TIMERS_END");
    let mut tasks = Vec::new();
    let mut index = 0usize;
    let mut lines = user_section.lines();
    while let Some(line) = lines.next() {
        if let Some((id, name, enabled)) = cron_marker(line.trim()) {
            if let Some(entry) = lines.next() {
                let normalized = entry.trim().trim_start_matches("# ").trim();
                if let Some((schedule, _, command)) = cron_line_parts(normalized, false) {
                    tasks.push(CronTask {
                        id,
                        name,
                        source: "用户 Cron".into(),
                        user: username.into(),
                        schedule,
                        command,
                        enabled,
                        editable: true,
                        detail: "当前 SSH 用户的 crontab".into(),
                    });
                }
            }
            continue;
        }
        if let Some((schedule, _, command)) = cron_line_parts(line, false) {
            index += 1;
            tasks.push(CronTask {
                id: format!("user:{index}"),
                name: command
                    .split_whitespace()
                    .next()
                    .unwrap_or("Cron 任务")
                    .into(),
                source: "用户 Cron".into(),
                user: username.into(),
                schedule,
                command,
                enabled: true,
                editable: false,
                detail: "服务器上已有的用户 Cron".into(),
            });
        }
    }
    for line in system_section.lines() {
        if line.starts_with("OPSNEST_FILE=") || line.starts_with("--") {
            continue;
        }
        if let Some((schedule, user, command)) = cron_line_parts(line, true) {
            index += 1;
            tasks.push(CronTask {
                id: format!("system:{index}"),
                name: command
                    .split_whitespace()
                    .next()
                    .unwrap_or("系统 Cron")
                    .into(),
                source: "系统 Cron".into(),
                user,
                schedule,
                command,
                enabled: true,
                editable: false,
                detail: "/etc/crontab 或 /etc/cron.d".into(),
            });
        }
    }
    for line in timer_section
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.starts_with("NEXT") || line.starts_with("n/a") || line.contains("LAST") {
            continue;
        }
        index += 1;
        let name = line
            .split_whitespace()
            .last()
            .unwrap_or("systemd timer")
            .to_string();
        tasks.push(CronTask {
            id: format!("timer:{index}"),
            name,
            source: "systemd timer".into(),
            user: "system".into(),
            schedule: "timer".into(),
            command: line.into(),
            enabled: true,
            editable: false,
            detail: "服务器 systemd timer 状态".into(),
        });
    }
    tasks
}

const CRON_LIST_COMMAND: &str = r#"printf 'OPSNEST_USER_NAME='; id -un 2>/dev/null || printf 'unknown'; printf '\nOPSNEST_USER_CRON_BEGIN\n'; user_cron=$(crontab -l 2>/dev/null || true); if [ -n "$user_cron" ]; then printf '%s\n' "$user_cron"; else printf 'OPSNEST_USER_CRON_EMPTY\n'; fi; printf 'OPSNEST_USER_CRON_END\n'; printf 'OPSNEST_SYSTEM_CRON_BEGIN\n'; if [ -r /etc/crontab ]; then cat /etc/crontab; fi; for file in /etc/cron.d/*; do if [ -f "$file" ]; then printf 'OPSNEST_FILE=%s\n' "$file"; cat "$file"; fi; done; printf 'OPSNEST_SYSTEM_CRON_END\n'; printf 'OPSNEST_TIMERS_BEGIN\n'; systemctl list-timers --all --no-legend --no-pager 2>/dev/null || true; printf 'OPSNEST_TIMERS_END\n'"#;

const SYSTEM_INFO_COMMAND: &str = r#"os_name=""
if [ -r /etc/os-release ]; then
  os_name=$(awk -F= '/^PRETTY_NAME=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release 2>/dev/null)
  if [ -z "$os_name" ]; then os_name=$(awk -F= '/^NAME=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release 2>/dev/null); fi
fi
if [ -z "$os_name" ] && [ -r /etc/openwrt_release ]; then
  os_name=$(awk -F= '/^DISTRIB_DESCRIPTION=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/openwrt_release 2>/dev/null)
  if [ -z "$os_name" ]; then os_name=$(awk -F= '/^DISTRIB_ID=/{gsub(/^"|"$/, "", $2); id=$2} /^DISTRIB_RELEASE=/{gsub(/^"|"$/, "", $2); release=$2} END {if (id != "") print id " " release}' /etc/openwrt_release 2>/dev/null); fi
fi
if [ -z "$os_name" ]; then os_name=$(uname -srm 2>/dev/null); fi
printf '%s\n' "${os_name:-Linux}"
"#;

const PROFILE_FALLBACK_COMMAND_PREFIX: &str = r#"
printf 'OPSNEST_OS='; if [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_DESCRIPTION=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/openwrt_release; elif [ -r /etc/os-release ]; then awk -F= '/^PRETTY_NAME=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release; else uname -srm; fi
printf 'OPSNEST_OS_ID='; if [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_ID=/{gsub(/^"|"$/, "", $2); print tolower($2); exit}' /etc/openwrt_release; elif [ -r /etc/os-release ]; then awk -F= '/^ID=/{gsub(/^"|"$/, "", $2); print tolower($2); exit}' /etc/os-release; else printf 'linux'; fi
printf 'OPSNEST_OS_VERSION='; if [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_RELEASE=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/openwrt_release; elif [ -r /etc/os-release ]; then awk -F= '/^VERSION_ID=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release; else uname -r; fi
printf '\nOPSNEST_HOSTNAME='; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_CPU='; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_CPU_MODEL='; awk -F: '/^(model name|Hardware|Processor)[[:space:]]*:/{gsub(/^[[:space:]]+/, "", $2); if ($2 != "") {print $2; exit}}' /proc/cpuinfo 2>/dev/null
printf '\nOPSNEST_MEMORY='; awk '/MemTotal/{printf "%.1f GB", $2/1024/1024}' /proc/meminfo 2>/dev/null
printf '\nOPSNEST_DISK='; df -h / 2>/dev/null | awk 'NR==2 {print $4 " free of " $2}'
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then printf '\nOPSNEST_DOCKER=installed'; else printf '\nOPSNEST_DOCKER=missing'; fi
printf '\nOPSNEST_OPENWRT_MODEL='; [ -r /tmp/sysinfo/model ] && cat /tmp/sysinfo/model
printf '\nOPSNEST_OPENWRT_FIRMWARE='; [ -r /etc/openwrt_release ] && awk -F= '/^DISTRIB_DESCRIPTION=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/openwrt_release
printf '\nOPSNEST_OPENWRT_KERNEL='; uname -r 2>/dev/null
"#;

// OpenWrt variants do not all expose the same network helpers. Prefer ubus,
// then parse its JSON without jsonfilter, and finally fall back to UCI and the
// kernel routing/address tables. The markers are always emitted so a partial
// probe cannot make the frontend treat an old value as current.
const OPENWRT_NETWORK_PROBE: &str = r#"
openwrt_interface_ipv4() {
  interface_name="$1"
  interface_status=$(ubus call "network.interface.$interface_name" status 2>/dev/null || true)
  address=''
  if [ -n "$interface_status" ] && command -v jsonfilter >/dev/null 2>&1; then
    address=$(printf '%s' "$interface_status" | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null | head -n 1)
  fi
  if [ -z "$address" ] && [ -n "$interface_status" ]; then
    address=$(printf '%s' "$interface_status" | grep -o '"address"[[:space:]]*:[[:space:]]*"[0-9][0-9.]*"' 2>/dev/null | head -n 1 | sed 's/.*"\([0-9][0-9.]*\)".*/\1/')
  fi
  printf '%s' "$address"
}
openwrt_lan_device=$(uci -q get network.lan.device 2>/dev/null || true)
[ -z "$openwrt_lan_device" ] && openwrt_lan_device=$(uci -q get network.lan.ifname 2>/dev/null || true)
[ -z "$openwrt_lan_device" ] && openwrt_lan_device=br-lan
openwrt_wan_ip=$(openwrt_interface_ipv4 wan)
[ -z "$openwrt_wan_ip" ] && openwrt_wan_ip=$(uci -q get network.wan.ipaddr 2>/dev/null || true)
[ -z "$openwrt_wan_ip" ] && openwrt_wan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i == "src") {print $(i+1); exit}}')
printf '\nOPSNEST_WAN_IP=%s' "${openwrt_wan_ip:-unknown}"
openwrt_lan_ip=$(openwrt_interface_ipv4 lan)
[ -z "$openwrt_lan_ip" ] && openwrt_lan_ip=$(uci -q get network.lan.ipaddr 2>/dev/null || true)
[ -z "$openwrt_lan_ip" ] && openwrt_lan_ip=$(ip -4 addr show dev "$openwrt_lan_device" 2>/dev/null | awk '/inet / {sub("/.*", "", $2); if ($2 != "127.0.0.1") {print $2; exit}}')
printf '\nOPSNEST_LAN_IP=%s' "${openwrt_lan_ip:-unknown}"
printf '\nOPSNEST_LAN_CLIENTS='
openwrt_lan_clients=''
if command -v ubus >/dev/null 2>&1; then
  openwrt_dhcp_leases=$(ubus call dhcp ipv4leases 2>/dev/null || true)
  if [ -n "$openwrt_dhcp_leases" ]; then
    openwrt_lan_clients=$(printf '%s' "$openwrt_dhcp_leases" | grep -o '"mac"' 2>/dev/null | wc -l)
  fi
fi
if [ -z "$openwrt_lan_clients" ] || [ "$openwrt_lan_clients" -eq 0 ] 2>/dev/null; then
  if [ -r /tmp/dhcp.leases ]; then
    openwrt_lan_clients=$(awk 'NF >= 3 {print tolower($2)}' /tmp/dhcp.leases | sort -u | wc -l)
  else
    openwrt_lan_clients=0
  fi
fi
printf '%s' "${openwrt_lan_clients:-0}"
printf '\nOPSNEST_WIFI_CLIENTS='
openwrt_wifi_clients=0
if command -v iw >/dev/null 2>&1; then
  for wifi_device in $(iw dev 2>/dev/null | awk '$1 == "Interface" {print $2}'); do
    count=$(iw dev "$wifi_device" station dump 2>/dev/null | awk '$1 == "Station" {count++} END {print count+0}')
    openwrt_wifi_clients=$((openwrt_wifi_clients + count))
  done
elif command -v iwinfo >/dev/null 2>&1; then
  for wifi_device in $(iwinfo 2>/dev/null | awk '$2 == "ESSID:" {print $1}'); do
    count=$(iwinfo "$wifi_device" assoclist 2>/dev/null | awk '/dBm/ {count++} END {print count+0}')
    openwrt_wifi_clients=$((openwrt_wifi_clients + count))
  done
fi
printf '%s' "$openwrt_wifi_clients"
"#;

#[tauri::command]
pub async fn test_ssh_connection(request: SshTestRequest) -> Result<SshTestResponse, String> {
    let latency_ms = measure_tcp_latency(&request).await?;
    let session = connect_session(&request).await?;
    let output = run_command(&session, SYSTEM_INFO_COMMAND, None).await?;
    close_session(&session).await;
    let system = output.trim().chars().take(120).collect::<String>();
    Ok(SshTestResponse {
        system: if system.is_empty() {
            "Linux 服务器".into()
        } else {
            system
        },
        latency_ms,
    })
}

#[tauri::command]
pub async fn inspect_server(request: SshTestRequest) -> Result<ServerProfile, String> {
    let session = connect_session(&request).await?;
    let sudo_password = request
        .sudo_password
        .as_deref()
        .or(request.password.as_deref())
        .map(shell_quote)
        .unwrap_or_else(|| "''".to_string());
    let command = format!(
        r#"
printf 'OPSNEST_OS='; {SYSTEM_INFO_COMMAND}
printf 'OPSNEST_OS_ID='; if [ -r /etc/os-release ]; then awk -F= '/^ID={{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/os-release 2>/dev/null; elif [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_ID={{gsub(/^"|"$/, "", $2); print tolower($2); exit}}' /etc/openwrt_release 2>/dev/null; else printf 'linux'; fi
printf 'OPSNEST_OS_VERSION='; if [ -r /etc/os-release ]; then awk -F= '/^VERSION_ID={{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/os-release 2>/dev/null; elif [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_RELEASE={{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/openwrt_release 2>/dev/null; else uname -r 2>/dev/null; fi
printf '\nOPSNEST_HOSTNAME='; hostname_value=$(hostname 2>/dev/null || true); if [ -z "$hostname_value" ] && [ -r /proc/sys/kernel/hostname ]; then hostname_value=$(cat /proc/sys/kernel/hostname 2>/dev/null || true); fi; if [ -z "$hostname_value" ] && command -v uci >/dev/null 2>&1; then hostname_value=$(uci -q get system.@system[0].hostname 2>/dev/null || true); fi; if [ -n "$hostname_value" ]; then printf '%s' "$hostname_value"; else printf 'unknown'; fi
printf '\nOPSNEST_CPU='; cpu_count=$(nproc 2>/dev/null || true); if [ -z "$cpu_count" ] && [ -r /proc/cpuinfo ]; then cpu_count=$(awk '/^processor[[:space:]]*:/ {{count++}} END {{print count+0}}' /proc/cpuinfo 2>/dev/null); fi; if [ -z "$cpu_count" ] && command -v getconf >/dev/null 2>&1; then cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true); fi; [ -n "$cpu_count" ] && [ "$cpu_count" -gt 0 ] 2>/dev/null && printf '%s' "$cpu_count" || printf 'unknown'
printf '\nOPSNEST_CPU_MODEL='; if [ -r /proc/cpuinfo ]; then awk -F: '/^(model name|Hardware|Processor)[[:space:]]*:/ {{gsub(/^[[:space:]]+/, "", $2); if ($2 != "") {{print $2; exit}}}}' /proc/cpuinfo 2>/dev/null; fi
printf '\nOPSNEST_MEMORY='; awk '/MemTotal/ {{printf "%.1f GB", $2/1024/1024}}' /proc/meminfo 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_DISK='; df -h / 2>/dev/null | awk 'NR==2 {{print $4 " free of " $2}}'
container_exec() {{
  if command -v docker >/dev/null 2>&1; then
    docker "$@" 2>/dev/null && return 0
    if command -v sudo >/dev/null 2>&1; then sudo -n docker "$@" 2>/dev/null && return 0; fi
    if command -v sudo >/dev/null 2>&1 && [ -n "$OPSNEST_SUDO_PASSWORD" ]; then
      printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' docker "$@" 2>/dev/null && return 0
    fi
  fi
  if command -v podman >/dev/null 2>&1; then
    podman "$@" 2>/dev/null && return 0
    if command -v sudo >/dev/null 2>&1; then sudo -n podman "$@" 2>/dev/null && return 0; fi
    if command -v sudo >/dev/null 2>&1 && [ -n "$OPSNEST_SUDO_PASSWORD" ]; then
      printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' podman "$@" 2>/dev/null && return 0
    fi
  fi
  return 1
}}
OPSNEST_SUDO_PASSWORD={sudo_password}
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
  printf '\nOPSNEST_DOCKER=installed'
  if container_exec info >/dev/null 2>&1; then
    printf '\nOPSNEST_DOCKER_ACCESS=ok'
    running_containers=$(container_exec ps -q 2>/dev/null)
    printf '\nOPSNEST_CONTAINERS='
    printf '%s\n' "$running_containers" | sed '/^[[:space:]]*$/d' | wc -l
  else
    printf '\nOPSNEST_DOCKER_ACCESS=unavailable'
    printf '\nOPSNEST_CONTAINERS=unavailable'
  fi
  container_list=$(container_exec ps -a --format '{{{{.ID}}}}|{{{{.Names}}}}|{{{{.Image}}}}|{{{{.Status}}}}|{{{{.Ports}}}}' 2>/dev/null || true)
  if [ -n "$container_list" ]; then
    printf '%s\n' "$container_list" | while IFS='|' read -r container_id container_name container_image container_status container_ports; do
      [ -n "$container_id" ] || continue
      if [ -z "$container_ports" ]; then
        network_mode=$(container_exec inspect "$container_id" --format '{{{{.HostConfig.NetworkMode}}}}' 2>/dev/null || true)
        if [ "$network_mode" = "host" ]; then
          exposed_port=$(container_exec inspect "$container_id" --format '{{{{json .Config.ExposedPorts}}}}' 2>/dev/null | sed -nE 's/.*"([0-9]+)\/(tcp|udp)".*/\1/p' | head -n 1)
          case "$container_name" in xiaoya|xiaoya-*) [ -z "$exposed_port" ] && exposed_port=5678;; esac
          [ -n "$exposed_port" ] && container_ports="0.0.0.0:$exposed_port->$exposed_port/tcp"
        fi
      fi
      printf 'OPSNEST_DOCKER_ITEM=%s|%s|%s|%s|%s\n' "$container_id" "$container_name" "$container_image" "$container_status" "$container_ports"
    done
  fi
  if [ -z "$container_list" ]; then
    for container_id in $(container_exec ps -aq 2>/dev/null); do
      [ -n "$container_id" ] || continue
      container_name=$(container_exec inspect "$container_id" --format '{{{{.Name}}}}' 2>/dev/null | sed 's#^/##' | head -n 1)
      container_image=$(container_exec inspect "$container_id" --format '{{{{.Config.Image}}}}' 2>/dev/null | head -n 1)
      container_status=$(container_exec inspect "$container_id" --format '{{{{.State.Status}}}}' 2>/dev/null | head -n 1)
      [ -n "$container_name" ] || container_name="$container_id"
      [ -n "$container_status" ] || container_status='unknown'
      printf 'OPSNEST_DOCKER_ITEM=%s|%s|%s|%s|%s\n' "$container_id" "$container_name" "$container_image" "$container_status" ''
    done
  fi
else
  printf '\nOPSNEST_DOCKER=missing'
  printf '\nOPSNEST_CONTAINERS=0'
fi
printf '\nOPSNEST_OPENWRT_MODEL='; if command -v ubus >/dev/null 2>&1 && command -v jsonfilter >/dev/null 2>&1; then ubus call system board 2>/dev/null | jsonfilter -e '@.model' 2>/dev/null | head -n 1; elif [ -r /tmp/sysinfo/model ]; then cat /tmp/sysinfo/model; fi
printf '\nOPSNEST_OPENWRT_FIRMWARE='; if command -v ubus >/dev/null 2>&1 && command -v jsonfilter >/dev/null 2>&1; then ubus call system board 2>/dev/null | jsonfilter -e '@.release.description' 2>/dev/null | head -n 1; elif [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_DESCRIPTION=/{{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/openwrt_release 2>/dev/null; fi
printf '\nOPSNEST_OPENWRT_KERNEL='; uname -r 2>/dev/null
{OPENWRT_NETWORK_PROBE}
printf '\nOPSNEST_NAS_KIND='; if grep -qiE 'fnos|fnnas|飞牛' /etc/os-release /etc/fnos_release /etc/fnos-version /etc/*release 2>/dev/null || [ -d /usr/local/fnos ] || [ -d /var/lib/fnos ] || hostname 2>/dev/null | grep -qiE 'feiniu|fnos|fnnas' || ps 2>/dev/null | grep -v grep | grep -E 'fnos|fnnas|fnmain' >/dev/null 2>&1; then printf 'fnos'; else printf ''; fi
printf '\nOPSNEST_NAS_VERSION='; for nas_version_file in /etc/fnos_release /etc/fnos-version /usr/local/fnos/version /usr/local/fnos/VERSION; do if [ -r "$nas_version_file" ]; then tr '\n\r' '  ' < "$nas_version_file"; break; fi; done
printf '\nOPSNEST_NAS_PORT='; nas_port=''; for candidate in 5666 8000; do if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{{print $4}}' | grep -E ":${{candidate}}$" >/dev/null 2>&1; then nas_port="$candidate"; break; elif command -v netstat >/dev/null 2>&1 && netstat -lnt 2>/dev/null | awk '{{print $4}}' | grep -E ":${{candidate}}$" >/dev/null 2>&1; then nas_port="$candidate"; break; fi; done; printf '%s' "$nas_port"
"#
    );
    let mut output = run_command(&session, &command, None).await?;
    if !output.contains("OPSNEST_HOSTNAME=") {
        close_session(&session).await;
        if let Ok(fallback_session) = connect_session(&request).await {
            let fallback_command =
                format!("{PROFILE_FALLBACK_COMMAND_PREFIX}{OPENWRT_NETWORK_PROBE}");
            if let Ok(fallback) = run_command(&fallback_session, &fallback_command, None).await {
                output.push_str(&fallback);
            }
            close_session(&fallback_session).await;
        }
    } else {
        close_session(&session).await;
    }
    let os_id = value_for(&output, "OPSNEST_OS_ID=", "linux").to_lowercase();
    let os_name = value_for(&output, "OPSNEST_OS=", "Linux");
    let openwrt_model =
        clean_device_label(value_for(&output, "OPSNEST_OPENWRT_MODEL=", ""), &os_name);
    let is_openwrt = matches!(os_id.as_str(), "openwrt" | "istoreos" | "immortalwrt")
        || os_name.to_ascii_lowercase().contains("openwrt")
        || os_name.to_ascii_lowercase().contains("istoreos")
        || os_name.to_ascii_lowercase().contains("immortalwrt");
    let docker_installed = value_for(&output, "OPSNEST_DOCKER=", "missing") == "installed";
    let nas_kind = value_for(&output, "OPSNEST_NAS_KIND=", "").to_lowercase();
    let nas = (nas_kind == "fnos").then(|| NasProfile {
        kind: "fnos".to_string(),
        version: value_for(&output, "OPSNEST_NAS_VERSION=", "unknown").to_string(),
        management_port: value_for(&output, "OPSNEST_NAS_PORT=", "5666").to_string(),
    });
    let openwrt = is_openwrt.then(|| OpenWrtProfile {
        model: openwrt_model,
        firmware: value_for(
            &output,
            "OPSNEST_OPENWRT_FIRMWARE=",
            &value_for(&output, "OPSNEST_OS_VERSION=", "unknown"),
        ),
        kernel: value_for(&output, "OPSNEST_OPENWRT_KERNEL=", "unknown"),
        wan_ip: value_for(&output, "OPSNEST_WAN_IP=", "unknown"),
        lan_ip: value_for(&output, "OPSNEST_LAN_IP=", "unknown"),
        lan_clients: value_for(&output, "OPSNEST_LAN_CLIENTS=", "0"),
        wifi_clients: value_for(&output, "OPSNEST_WIFI_CLIENTS=", "0"),
    });
    Ok(ServerProfile {
        os_id,
        os_version: value_for(&output, "OPSNEST_OS_VERSION=", "").to_string(),
        os_name,
        hostname: value_for(&output, "OPSNEST_HOSTNAME=", "未知主机"),
        cpu_cores: value_for(&output, "OPSNEST_CPU=", "未知"),
        cpu_model: clean_device_label(value_for(&output, "OPSNEST_CPU_MODEL=", ""), "未知"),
        memory: value_for(&output, "OPSNEST_MEMORY=", "未知"),
        disk: value_for(&output, "OPSNEST_DISK=", "未知"),
        docker_installed,
        docker_containers: value_for(&output, "OPSNEST_CONTAINERS=", "0"),
        docker_items: parse_docker_items(&output),
        openwrt,
        nas,
    })
}

const SERVICE_DISCOVERY_COMMAND: &str = r#"
emit_service() {
  service_id="$1"; service_name="$2"; category="$3"; status="$4"; version="$5"; port="$6"; web="$7"; web_scheme="${8:-http}"
  version=$(printf '%s' "$version" | tr '\n\r|' '   ' | cut -c1-80)
  web_path=''
  if [ "$service_id" = "1panel" ]; then
    if [ -r /opt/1panel/conf/app.yaml ]; then
      web_path=$(grep -Ei 'securityEntrance|security-entrance|security_entrance' /opt/1panel/conf/app.yaml 2>/dev/null | head -n 1 | sed -E 's/.*:[[:space:]]*//' | tr -d ' ' | tr -d '"')
    fi
    if [ -z "$web_path" ] && command -v 1pctl >/dev/null 2>&1; then
      one_url=$(1pctl user-info 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | head -n 1 | tr -d '\r')
      web_path=$(printf '%s' "$one_url" | sed -E 's#^https?://[^/]+(/.*)$#\1#')
    fi
    case "$web_path" in
      /*) ;;
      "") ;;
      *) web_path="/$web_path" ;;
    esac
  fi
  printf 'OPSNEST_SERVICE|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$service_id" "$service_name" "$category" "$status" "$version" "$port" "$web" "$web_path" "$web_scheme"
}

port_is_listening() {
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lntH 2>/dev/null | awk '{print $4}' | grep -E ":${port}$" >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lnt 2>/dev/null | awk '{print $4}' | grep -E ":${port}$" >/dev/null 2>&1
  else
    return 1
  fi
}

if grep -qiE 'fnos|fnnas|飞牛' /etc/os-release /etc/fnos_release /etc/fnos-version /etc/*release 2>/dev/null || [ -d /usr/local/fnos ] || [ -d /var/lib/fnos ] || hostname 2>/dev/null | grep -qiE 'feiniu|fnos|fnnas' || ps 2>/dev/null | grep -v grep | grep -E 'fnos|fnnas|fnmain' >/dev/null 2>&1; then
  fnos_port=''
  for candidate in 5666 8000; do
    if port_is_listening "$candidate"; then fnos_port="$candidate"; break; fi
  done
  [ -z "$fnos_port" ] && fnos_port=5666
  fnos_status=installed
  port_is_listening "$fnos_port" && fnos_status=running
  fnos_version=''
  for nas_version_file in /etc/fnos_release /etc/fnos-version /usr/local/fnos/version /usr/local/fnos/VERSION; do
    if [ -r "$nas_version_file" ]; then fnos_version=$(tr '\n\r' '  ' < "$nas_version_file"); break; fi
  done
  emit_service fnos '飞牛 fnOS' panel "$fnos_status" "$fnos_version" "$fnos_port" yes
fi

if [ -r /etc/openwrt_release ] || [ -r /etc/config/system ] && command -v ubus >/dev/null 2>&1; then
  for init_service in uhttpd dropbear dnsmasq odhcpd firewall rpcd netifd odhcp6c hostapd wpa_supplicant miniupnpd mwan3 sqm adblock banip ddns tailscale wireguard openclash passwall openlist lucky; do
    if [ -x "/etc/init.d/$init_service" ]; then
      service_status=installed
      pidof "$init_service" >/dev/null 2>&1 && service_status=running
      service_port=''
      service_web=no
      service_scheme=http
      case "$init_service" in
        uhttpd)
          service_web=yes; service_name='LuCI / uHTTPd'; service_category=panel
          https_port=$(uci -q get uhttpd.main.listen_https 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)
          http_port=$(uci -q get uhttpd.main.listen_http 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)
          if [ -n "$https_port" ]; then service_port="$https_port"; service_scheme=https
          elif [ -n "$http_port" ]; then service_port="$http_port"
          else service_port=80; fi
          ;;
        dropbear) service_port=22; service_name='Dropbear SSH'; service_category=network;;
        dnsmasq) service_port=53; service_name='Dnsmasq'; service_category=network;;
        odhcpd) service_port=547; service_name='odhcpd'; service_category=network;;
        rpcd) service_name='rpcd'; service_category=system;;
        netifd) service_name='netifd'; service_category=network;;
        firewall) service_name='Firewall'; service_category=network;;
        hostapd|wpa_supplicant) service_name="$init_service"; service_category=wifi;;
        openclash) service_name='OpenClash'; service_category=router;;
        passwall) service_name='PassWall'; service_category=router;;
        openlist) service_name='OpenList'; service_category=panel; service_port=5244; service_web=yes;;
        lucky) service_name='Lucky'; service_category=panel; service_port=16601; service_web=yes;;
        *) service_name="$init_service"; service_category=router;;
      esac
      emit_service "openwrt-$init_service" "$service_name" "$service_category" "$service_status" 'OpenWrt service' "$service_port" "$service_web" "$service_scheme"
    fi
  done
fi

if [ -x /www/server/panel/pyenv/bin/python ] || [ -d /www/server/panel ] || command -v bt >/dev/null 2>&1; then
  panel_status=stopped
  ps 2>/dev/null | grep -v grep | grep -E '(/www/server/panel|BT-Panel|panelAuth)' >/dev/null 2>&1 && panel_status=running
  panel_port=''
  if [ -r /www/server/panel/data/port.pl ]; then panel_port=$(tr -dc '0-9' < /www/server/panel/data/port.pl | cut -c1-5); fi
  [ -z "$panel_port" ] && panel_port=8888
  emit_service baota '宝塔面板' panel "$panel_status" 'detected' "$panel_port" yes
fi

if [ -d /opt/1panel ] || command -v 1pctl >/dev/null 2>&1; then
  one_status=stopped
  ps 2>/dev/null | grep -v grep | grep -E '1panel|1p-daemon' >/dev/null 2>&1 && one_status=running
  one_port=''
  one_url=''
  if command -v 1pctl >/dev/null 2>&1; then
    one_url=$(1pctl user-info 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | head -n 1 | tr -d '\r')
  fi
  if [ -n "$one_url" ]; then
    one_port=$(printf '%s' "$one_url" | sed -nE 's#^https?://[^/:]+:([0-9]+)(/.*)?$#\1#p')
  fi
  if [ -z "$one_port" ] && command -v ss >/dev/null 2>&1; then
    one_port=$(ss -lntpH 2>/dev/null | grep -E '1panel|1p-daemon' | sed -nE 's/.*:([0-9]+)[[:space:]].*/\1/p' | head -n 1)
  fi
  if [ -z "$one_port" ] && [ -r /opt/1panel/conf/app.yaml ]; then
    one_port=$(awk -F: '/^[[:space:]]*port:/{gsub(/[[:space:]]/, "", $2); print $2; exit}' /opt/1panel/conf/app.yaml 2>/dev/null)
  fi
  one_web=yes
  [ -z "$one_port" ] && one_web=no
  emit_service 1panel '1Panel' panel "$one_status" 'detected' "$one_port" "$one_web"
fi

container_exec() {
  if command -v docker >/dev/null 2>&1; then
    docker "$@" 2>/dev/null && return 0
    if command -v sudo >/dev/null 2>&1; then sudo -n docker "$@" 2>/dev/null && return 0; fi
    if command -v sudo >/dev/null 2>&1 && [ -n "$OPSNEST_SUDO_PASSWORD" ]; then
      printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' docker "$@" 2>/dev/null && return 0
    fi
  fi
  if command -v podman >/dev/null 2>&1; then
    podman "$@" 2>/dev/null && return 0
    if command -v sudo >/dev/null 2>&1; then sudo -n podman "$@" 2>/dev/null && return 0; fi
    if command -v sudo >/dev/null 2>&1 && [ -n "$OPSNEST_SUDO_PASSWORD" ]; then
      printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' podman "$@" 2>/dev/null && return 0
    fi
  fi
  return 1
}
container_ports_for() {
  container="$1"
  port_output=$(container_exec port "$container" 2>/dev/null || true)
  # MediaHelp's web UI listens on container port 80. Its 8091 mapping is a
  # backend/302 service and must not be used as the browser management URL.
  case "$container" in
    mediahelper|mediahelp|media-help)
      ports=$(printf '%s\n' "$port_output" | sed -nE '/^80\/tcp[[:space:]]*->/s/.*:([0-9][0-9]*)$/\1/p' | head -n 1)
      [ -z "$ports" ] && ports=3300
      [ -n "$ports" ] && printf '0.0.0.0:%s->80/tcp' "$ports"; return 0
      ;;
  esac
  ports=$(printf '%s\n' "$port_output" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)
  if [ -n "$ports" ]; then printf '0.0.0.0:%s->%s/tcp' "$ports" "$ports"; return 0; fi
  network_mode=$(container_exec inspect "$container" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null)
  if [ "$network_mode" != "host" ]; then return 0; fi
  exposed_port=$(container_exec inspect "$container" --format '{{json .Config.ExposedPorts}}' 2>/dev/null | sed -nE 's/.*"([0-9]+)\/(tcp|udp)".*/\1/p' | head -n 1)
  case "$container" in xiaoya|xiaoya-*) [ -z "$exposed_port" ] && exposed_port=5678;; esac
  [ -n "$exposed_port" ] && printf '0.0.0.0:%s->%s/tcp' "$exposed_port" "$exposed_port"
}
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
  docker_version=$(container_exec version --format '{{.Server.Version}}' 2>/dev/null || container_exec --version 2>/dev/null)
  emit_service docker 'Docker' container running "$docker_version" '' no
  for container in $(container_exec ps --format '{{.Names}}' 2>/dev/null); do
    service_name="$container"
    container_ports=$(container_ports_for "$container")
    service_port=$(printf '%s' "$container_ports" | sed -n 's/.*:\([0-9][0-9]*\)->.*/\1/p')
    service_web=no
    [ -n "$service_port" ] && service_web=yes
    case "$container" in
      mediahelper|mediahelp|media-help) service_name='MediaHelp'; [ -z "$service_port" ] && service_port=3300; service_web=yes;;
      portainer) service_name='Portainer';;
      grafana) service_name='Grafana';;
      uptime-kuma) service_name='Uptime Kuma';;
      openlist) service_name='OpenList'; [ -z "$service_port" ] && service_port=5244; service_web=yes;;
      lucky) service_name='Lucky'; [ -z "$service_port" ] && service_port=16601; service_web=yes;;
    esac
    container_image=$(container_exec inspect "$container" --format '{{.Config.Image}}' 2>/dev/null | head -n 1)
    emit_service "docker-$container" "$service_name" container running "$container_image" "$service_port" "$service_web"
  done
fi

for web_service in nginx apache2 httpd caddy; do
  if command -v "$web_service" >/dev/null 2>&1; then
    web_status=stopped
    ps 2>/dev/null | grep -v grep | grep "$web_service" >/dev/null 2>&1 && web_status=running
    web_version=$($web_service -v 2>/dev/null | head -n 1)
    emit_service "$web_service" "$web_service" web "$web_status" "$web_version" '' no
  fi
done

for runtime in php node python3 java; do
  if command -v "$runtime" >/dev/null 2>&1; then
    runtime_version=$($runtime --version 2>&1 | head -n 1)
    emit_service "$runtime" "$runtime" runtime installed "$runtime_version" '' no
  fi
done

for database in mysqld mariadbd postgres redis-server mongod; do
  if command -v "$database" >/dev/null 2>&1; then
    database_version=$($database --version 2>&1 | head -n 1)
    emit_service "$database" "$database" database detected "$database_version" '' no
  fi
done
printf 'OPSNEST_SERVICE_SCAN_DONE\n'
"#;

// Some OpenWrt/iStoreOS SSH servers reject the larger discovery script before
// it can emit its final marker. Keep a short platform probe as a fallback so
// the common router services are still discoverable.
const OPENWRT_SERVICE_FALLBACK_COMMAND: &str = r#"
emit() { printf 'OPSNEST_SERVICE|%s|%s|%s|%s|%s|%s|%s||%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8"; }
if [ -r /etc/openwrt_release ] || command -v ubus >/dev/null 2>&1; then
  for service in uhttpd dropbear dnsmasq odhcpd rpcd netifd firewall hostapd wpa_supplicant miniupnpd openclash passwall openlist lucky; do
    if [ -x "/etc/init.d/$service" ]; then
      status=installed; pidof "$service" >/dev/null 2>&1 && status=running
      name="$service"; category=router; port=''; web=no; scheme=http
      case "$service" in
        uhttpd)
          name='LuCI / uHTTPd'; category=panel; web=yes
          https_port=$(uci -q get uhttpd.main.listen_https 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)
          http_port=$(uci -q get uhttpd.main.listen_http 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)
          if [ -n "$https_port" ]; then port="$https_port"; scheme=https
          elif [ -n "$http_port" ]; then port="$http_port"
          else port=80; fi
          ;;
        dropbear) name='Dropbear SSH'; category=network; port=22;;
        dnsmasq) name='Dnsmasq'; category=network; port=53;;
        odhcpd) name='odhcpd'; category=network; port=547;;
        rpcd) name='rpcd'; category=system;;
        netifd) name='netifd'; category=network;;
        firewall) name='Firewall'; category=network;;
        hostapd|wpa_supplicant) category=wifi;;
        openclash) name='OpenClash'; category=router;;
        passwall) name='PassWall'; category=router;;
        openlist) name='OpenList'; category=panel; port=5244; web=yes;;
        lucky) name='Lucky'; category=panel; port=16601; web=yes;;
      esac
      emit "openwrt-$service" "$name" "$category" "$status" 'OpenWrt service' "$port" "$web" "$scheme"
    fi
  done
fi
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
  container_exec() { if command -v docker >/dev/null 2>&1; then docker "$@" 2>/dev/null && return 0; if command -v sudo >/dev/null 2>&1; then sudo -n docker "$@" 2>/dev/null && return 0; [ -n "$OPSNEST_SUDO_PASSWORD" ] && printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' docker "$@" 2>/dev/null && return 0; fi; fi; if command -v podman >/dev/null 2>&1; then podman "$@" 2>/dev/null && return 0; if command -v sudo >/dev/null 2>&1; then sudo -n podman "$@" 2>/dev/null && return 0; [ -n "$OPSNEST_SUDO_PASSWORD" ] && printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' podman "$@" 2>/dev/null && return 0; fi; fi; return 1; }
  version=$(container_exec version --format '{{.Server.Version}}' 2>/dev/null || container_exec --version 2>/dev/null | head -n 1)
  emit docker Docker container running "$version" '' no
  for container in $(container_exec ps --format '{{.Names}}' 2>/dev/null); do
    name="$container"; port_output=$(container_exec port "$container" 2>/dev/null | head -n 1); port=$(printf '%s' "$port_output" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p'); web=no
    case "$container" in
      xiaoya|xiaoya-*) name='Xiaoya'; [ -z "$port" ] && port=5678; web=yes;;
      mediahelper|mediahelp|media-help) name='MediaHelp'; [ -z "$port" ] && port=3300; web=yes;;
      openlist) name='OpenList'; [ -z "$port" ] && port=5244; web=yes;;
      lucky) name='Lucky'; [ -z "$port" ] && port=16601; web=yes;;
    esac
    emit "docker-$container" "$name" container running "$container" "$port" "$web"
  done
fi
printf 'OPSNEST_SERVICE_SCAN_DONE\n'
"#;

fn parse_discovered_services(output: &str) -> Vec<DiscoveredService> {
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let fields = line
                .strip_prefix("OPSNEST_SERVICE|")?
                .split('|')
                .collect::<Vec<_>>();
            if fields.len() < 7 {
                return None;
            }
            let id = fields[0].to_string();
            if !seen.insert(id.clone()) {
                return None;
            }
            let port = fields[5].parse::<u16>().ok();
            // Some OpenWrt/container probes report a port but lose the
            // explicit web marker when output is combined with a fallback
            // probe. Recover the useful browser entry points deterministically
            // from the service category and published port.
            let web = fields[6] == "yes"
                || (fields[2] == "panel" && port.is_some())
                || (fields[2] == "container" && port.is_some());
            Some(DiscoveredService {
                id,
                name: fields[1].to_string(),
                category: fields[2].to_string(),
                status: fields[3].to_string(),
                version: fields[4].to_string(),
                port,
                web,
                web_path: fields
                    .get(7)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string()),
                web_scheme: fields
                    .get(8)
                    .filter(|value| **value == "http" || **value == "https")
                    .map(|value| value.to_string()),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn discover_server_services(
    request: SshTestRequest,
) -> Result<Vec<DiscoveredService>, String> {
    let session = connect_session(&request).await?;
    let sudo_password = request
        .sudo_password
        .as_deref()
        .or(request.password.as_deref())
        .map(shell_quote)
        .unwrap_or_else(|| "''".to_string());
    let compact_command =
        format!("OPSNEST_SUDO_PASSWORD={sudo_password}\n{OPENWRT_SERVICE_FALLBACK_COMMAND}");
    let generic_command =
        format!("OPSNEST_SUDO_PASSWORD={sudo_password}\n{SERVICE_DISCOVERY_COMMAND}");
    // Run the compact probe first. OpenWrt/iStoreOS variants may reject or
    // truncate the larger generic command through Dropbear.
    let compact = run_command(&session, &compact_command, None)
        .await
        .unwrap_or_default();
    let generic = run_command(&session, &generic_command, None)
        .await
        .unwrap_or_default();
    let output = format!("{compact}\n{generic}");
    close_session(&session).await;
    let services = parse_discovered_services(&output);
    if services.is_empty() && output.trim().is_empty() {
        return Err("服务扫描未返回结果，请重新连接后再试。".into());
    }
    Ok(services)
}

fn validate_cron_field(value: &str, label: &str, max_len: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_len || value.contains('\n') || value.contains('\r') {
        return Err(format!("{label}不能为空，且不能包含换行。"));
    }
    Ok(value.to_string())
}

fn cron_mutation_script(
    id: &str,
    name: &str,
    schedule: &str,
    command: &str,
    enabled: bool,
    delete: bool,
) -> String {
    let raw_id = id.to_string();
    let quoted_id = shell_quote(id);
    let line = if delete {
        None
    } else {
        let safe_name = name
            .replace(['\r', '\n', '#'], " ")
            .replace(" ENABLED:", " ");
        let marker = format!(
            "# OPSNEST-ID:{raw_id} NAME:{} ENABLED:{}",
            safe_name.trim(),
            if enabled { "1" } else { "0" }
        );
        let entry = format!(
            "{} {}{}",
            if enabled { "" } else { "# " },
            schedule,
            if command.is_empty() {
                String::new()
            } else {
                format!(" {command}")
            }
        );
        Some((marker, entry))
    };
    let mut script = format!("tmp=$(mktemp) || exit 1; (crontab -l 2>/dev/null || true) | awk -v id={quoted_id} 'index($0, \"# OPSNEST-ID:\" id \" \" ) != 1 {{print}}' > \"$tmp\" || exit 1; ");
    if let Some((marker, entry)) = line {
        script.push_str(&format!(
            "printf '%s\\n' {} {} >> \"$tmp\"; ",
            shell_quote(&marker),
            shell_quote(&entry)
        ));
    }
    script.push_str("crontab \"$tmp\"; status=$?; rm -f \"$tmp\"; exit $status");
    script
}

#[tauri::command]
pub async fn list_server_cron(request: SshTestRequest) -> Result<Vec<CronTask>, String> {
    let session = connect_session(&request).await?;
    let output = run_command(&session, CRON_LIST_COMMAND, None).await?;
    close_session(&session).await;
    Ok(parse_cron_output(&output, request.username.trim()))
}

#[tauri::command]
pub async fn save_server_cron(
    request: SshTestRequest,
    id: String,
    name: String,
    schedule: String,
    command: String,
    enabled: bool,
) -> Result<(), String> {
    let id = validate_cron_field(&id, "任务 ID", 100)?;
    if !id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("任务 ID 格式不正确。".into());
    }
    let name = validate_cron_field(&name, "任务名称", 120)?;
    let schedule = validate_cron_field(&schedule, "Cron 表达式", 100)?;
    let command = validate_cron_field(&command, "执行命令", 4000)?;
    let session = connect_session(&request).await?;
    let script = cron_mutation_script(&id, &name, &schedule, &command, enabled, false);
    let result = run_command(&session, &script, None).await;
    close_session(&session).await;
    result.map(|_| ())
}

#[tauri::command]
pub async fn delete_server_cron(request: SshTestRequest, id: String) -> Result<(), String> {
    let id = validate_cron_field(&id, "任务 ID", 100)?;
    if !id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("任务 ID 格式不正确。".into());
    }
    let session = connect_session(&request).await?;
    let script = cron_mutation_script(&id, "", "", "", false, true);
    let result = run_command(&session, &script, None).await;
    close_session(&session).await;
    result.map(|_| ())
}

fn diagnosis_commands(focus: &str) -> Vec<(&'static str, &'static str)> {
    let focus = focus.to_lowercase();
    let mut commands = vec![
        ("系统版本", "uname -a"),
        ("运行时间与负载", "uptime"),
        ("磁盘空间", "df -hP"),
        ("内存状态", "free -h 2>/dev/null || true"),
        (
            "失败服务",
            "systemctl --failed --no-legend --no-pager 2>/dev/null || true",
        ),
        (
            "监听端口",
            "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true",
        ),
        (
            "Docker 容器",
            "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null || true",
        ),
    ];
    if focus.contains("网站")
        || focus.contains("网页")
        || focus.contains("nginx")
        || focus.contains("502")
        || focus.contains("打不开")
        || focus.contains("website")
        || focus.contains("web site")
        || focus.contains("web")
        || focus.contains("http")
        || focus.contains("https")
        || focus.contains("site")
        || focus.contains("gateway")
    {
        commands.extend([
            ("Web 端口", "ss -lntp 2>/dev/null | grep -E ':(80|443)\\b' || true"),
            ("Nginx 配置", "if command -v nginx >/dev/null 2>&1; then nginx -t 2>&1; else printf 'nginx not installed\\n'; fi"),
            ("本机 HTTP", "curl -I -L --max-time 5 -sS http://127.0.0.1 2>&1 | head -n 12 || true"),
        ]);
    }
    if focus.contains("docker") || focus.contains("容器") || focus.contains("compose") {
        commands.push(("Docker 服务", "docker info --format 'Server={{.ServerVersion}} Containers={{.Containers}} Running={{.ContainersRunning}}' 2>&1 || true"));
    }
    if focus.contains("hermes") {
        commands.push(("Hermes 安装位置", "command -v hermes || true"));
        commands.push(("Hermes 版本", "hermes --version 2>&1 || true"));
    }
    if focus.contains("llama") {
        commands.push((
            "llama.cpp 安装位置",
            "command -v llama-server || command -v llama-cli || true",
        ));
    }
    commands
}

#[tauri::command]
pub async fn diagnose_server(
    request: SshTestRequest,
    focus: String,
) -> Result<Vec<DiagnosisResult>, String> {
    let session = connect_session(&request).await?;
    let mut results = Vec::new();
    for (label, command) in diagnosis_commands(&focus) {
        match run_command(&session, command, None).await {
            Ok(output) => results.push(DiagnosisResult {
                label: label.to_string(),
                command: command.to_string(),
                output: output.chars().take(4000).collect(),
                success: true,
            }),
            Err(error) => results.push(DiagnosisResult {
                label: label.to_string(),
                command: command.to_string(),
                output: error,
                success: false,
            }),
        }
    }
    close_session(&session).await;
    Ok(results)
}

#[tauri::command]
pub async fn execute_ssh_command(
    request: SshTestRequest,
    command: String,
) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("请输入命令。".into());
    }
    if command.len() > 8_000 {
        return Err("命令太长，请分次执行。".into());
    }
    let (cancellation, command_id) = if let Some(command_id) = request
        .command_id
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        let (sender, receiver) = oneshot::channel();
        command_cancellations()
            .lock()
            .map_err(|_| "无法创建命令控制器".to_string())?
            .insert(command_id.clone(), sender);
        (Some(receiver), Some(command_id))
    } else {
        (None, None)
    };
    let result = if let Some(session_id) = request
        .session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let shell = persistent_shell_for(&request, session_id).await?;
        let result = run_persistent_command(&shell, command, cancellation).await;
        if matches!(&result, Err(error) if error == "SSH Shell 已断开") {
            let _ = close_persistent_shell(session_id).await;
        }
        result
    } else {
        let session = connect_session(&request).await?;
        let result = run_command(&session, command, cancellation).await;
        close_session(&session).await;
        result
    };
    if let Some(command_id) = command_id {
        if let Ok(mut commands) = command_cancellations().lock() {
            commands.remove(&command_id);
        }
    }
    result
}

#[tauri::command]
pub async fn open_ssh_terminal(
    app: AppHandle,
    request: SshTestRequest,
    session_id: String,
) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("SSH 会话 ID 不能为空。".into());
    }
    create_interactive_shell(app, &request, session_id).await
}

#[tauri::command]
pub async fn write_ssh_terminal(session_id: String, data: String) -> Result<(), String> {
    let session_id = session_id.trim();
    let shell = interactive_shells()
        .lock()
        .map_err(|_| "无法读取交互式 SSH 会话表".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH 终端尚未连接。".to_string())?;
    let result = shell
        .writer
        .lock()
        .await
        .data_bytes(data.into_bytes())
        .await
        .map_err(|error| format!("无法写入 SSH 终端：{error}"));
    result
}

#[tauri::command]
pub async fn resize_ssh_terminal(
    session_id: String,
    columns: u32,
    rows: u32,
) -> Result<(), String> {
    let session_id = session_id.trim();
    let shell = interactive_shells()
        .lock()
        .map_err(|_| "无法读取交互式 SSH 会话表".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH 终端尚未连接。".to_string())?;
    let result = shell
        .writer
        .lock()
        .await
        .window_change(columns.max(20), rows.max(5), 0, 0)
        .await
        .map_err(|error| format!("无法调整 SSH 终端大小：{error}"));
    result
}

#[tauri::command]
pub async fn close_interactive_ssh_terminal(session_id: String) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(());
    }
    close_interactive_shell(session_id).await
}

#[tauri::command]
pub async fn close_ssh_shell(session_id: String) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(());
    }
    close_persistent_shell(session_id).await
}

#[tauri::command]
pub fn stop_ssh_command(command_id: String) -> Result<(), String> {
    let sender = command_cancellations()
        .lock()
        .map_err(|_| "无法停止命令".to_string())?
        .remove(command_id.trim());
    match sender {
        Some(sender) => sender.send(()).map_err(|_| "命令已经结束".to_string()),
        None => Err("没有正在执行的命令".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_and_system_cron_entries() {
        let output = "OPSNEST_USER_CRON_BEGIN\n# OPSNEST-ID:job-1 NAME:每日备份 ENABLED:1\n0 3 * * * /opt/backup.sh\nOPSNEST_USER_CRON_END\nOPSNEST_SYSTEM_CRON_BEGIN\n17 * * * * root /usr/lib/command-not-found\nOPSNEST_SYSTEM_CRON_END\nOPSNEST_TIMERS_BEGIN\nOPSNEST_TIMERS_END\n";
        let tasks = parse_cron_output(output, "root");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "job-1");
        assert!(tasks[0].editable);
        assert_eq!(tasks[1].source, "系统 Cron");
        assert_eq!(tasks[1].user, "root");
    }

    #[test]
    fn parses_user_crontab_and_special_schedules() {
        let output = "OPSNEST_USER_NAME=root\nOPSNEST_USER_CRON_BEGIN\n0 * * * * /usr/local/bin/sd-server\n@reboot /usr/local/bin/autssh\nOPSNEST_USER_CRON_END\nOPSNEST_SYSTEM_CRON_BEGIN\n@daily root /usr/local/bin/system-job\nOPSNEST_SYSTEM_CRON_END\nOPSNEST_TIMERS_BEGIN\nOPSNEST_TIMERS_END\n";
        let tasks = parse_cron_output(output, "root");
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].command, "/usr/local/bin/sd-server");
        assert_eq!(tasks[1].schedule, "@reboot");
        assert_eq!(tasks[1].command, "/usr/local/bin/autssh");
        assert_eq!(tasks[2].schedule, "@daily");
        assert_eq!(tasks[2].user, "root");
    }

    #[test]
    fn mutation_script_keeps_marker_id_unquoted() {
        let script = cron_mutation_script(
            "job-1",
            "Backup",
            "0 3 * * *",
            "/opt/backup.sh",
            true,
            false,
        );
        assert!(script.contains("# OPSNEST-ID:job-1 NAME:Backup ENABLED:1"));
        assert!(script.contains("awk -v id='job-1'"));
    }

    #[test]
    fn parses_docker_container_fields() {
        let output =
            "OPSNEST_DOCKER_ITEM=abc123|web|nginx:latest|Up 2 hours|0.0.0.0:8080->80/tcp\n";
        let items = parse_docker_items(output);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "web");
        assert_eq!(items[0].image, "nginx:latest");
        assert_eq!(items[0].status, "Up 2 hours");
        assert_eq!(items[0].ports, "0.0.0.0:8080->80/tcp");
    }

    #[test]
    fn restores_web_entry_for_panel_and_container_ports() {
        let output = concat!(
            "OPSNEST_SERVICE|openwrt-luci|LuCI / uHTTPd|panel|running|OpenWrt service|80|no||https\n",
            "OPSNEST_SERVICE|docker-xiaoya|Xiaoya|container|running|xiaoya|5678|no|\n",
            "OPSNEST_SERVICE|openwrt-dropbear|Dropbear SSH|network|running|OpenWrt service|22|no|\n",
        );
        let services = parse_discovered_services(output);
        assert_eq!(services.len(), 3, "{services:?}");
        assert!(
            services
                .iter()
                .find(|item| item.name == "LuCI / uHTTPd")
                .unwrap()
                .web
        );
        assert_eq!(
            services
                .iter()
                .find(|item| item.name == "LuCI / uHTTPd")
                .unwrap()
                .web_scheme
                .as_deref(),
            Some("https")
        );
        assert!(
            services
                .iter()
                .find(|item| item.name == "Xiaoya")
                .unwrap()
                .web
        );
        assert!(
            !services
                .iter()
                .find(|item| item.name == "Dropbear SSH")
                .unwrap()
                .web
        );
    }
}
