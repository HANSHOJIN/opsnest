use russh::{client, keys, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tokio::sync::oneshot;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub command_id: Option<String>,
}

static COMMAND_CANCELLATIONS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

fn command_cancellations() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    COMMAND_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResponse {
    pub system: String,
    pub latency_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub os_id: String,
    pub os_version: String,
    pub os_name: String,
    pub hostname: String,
    pub cpu_cores: String,
    pub memory: String,
    pub disk: String,
    pub docker_installed: bool,
    pub docker_containers: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisResult {
    pub label: String,
    pub command: String,
    pub output: String,
    pub success: bool,
}

struct OpsNestHandler;

impl client::Handler for OpsNestHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Host-key verification will be added to the local credential store before
        // production release. For now this keeps first-time connections simple.
        Ok(true)
    }
}

async fn connect_session(request: &SshTestRequest) -> Result<client::Handle<OpsNestHandler>, String> {
    let host = request.host.trim();
    let username = request.username.trim();
    if host.is_empty() {
        return Err("请输入服务器地址。".into());
    }
    if username.is_empty() {
        return Err("请输入用户名。".into());
    }

    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..Default::default()
    };
    let mut session = client::connect(
        Arc::new(config),
        format!("{host}:{}", request.port),
        OpsNestHandler,
    )
    .await
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
    tokio::net::TcpStream::connect(address)
        .await
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
        let Some(message) = message else { break; };
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                output.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { .. } | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

async fn close_session(session: client::Handle<OpsNestHandler>) {
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

#[tauri::command]
pub async fn test_ssh_connection(request: SshTestRequest) -> Result<SshTestResponse, String> {
    let latency_ms = measure_tcp_latency(&request).await?;
    let session = connect_session(&request).await?;
    let output = run_command(&session, SYSTEM_INFO_COMMAND, None).await?;
    close_session(session).await;
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
    let command = format!(r#"
printf 'OPSNEST_OS='; {SYSTEM_INFO_COMMAND}
printf 'OPSNEST_OS_ID='; if [ -r /etc/os-release ]; then awk -F= '/^ID={{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/os-release 2>/dev/null; elif [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_ID={{gsub(/^"|"$/, "", $2); print tolower($2); exit}}' /etc/openwrt_release 2>/dev/null; else printf 'linux'; fi
printf 'OPSNEST_OS_VERSION='; if [ -r /etc/os-release ]; then awk -F= '/^VERSION_ID={{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/os-release 2>/dev/null; elif [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_RELEASE={{gsub(/^"|"$/, "", $2); print $2; exit}}' /etc/openwrt_release 2>/dev/null; else uname -r 2>/dev/null; fi
printf '\nOPSNEST_HOSTNAME='; hostname 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_CPU='; nproc 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_MEMORY='; awk '/MemTotal/ {{printf "%.1f GB", $2/1024/1024}}' /proc/meminfo 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_DISK='; df -h / 2>/dev/null | awk 'NR==2 {{print $4 " free of " $2}}'
if command -v docker >/dev/null 2>&1; then printf '\nOPSNEST_DOCKER=installed'; printf '\nOPSNEST_CONTAINERS='; docker ps -q 2>/dev/null | wc -l; else printf '\nOPSNEST_DOCKER=missing'; printf '\nOPSNEST_CONTAINERS=0'; fi
"#);
    let output = run_command(&session, &command, None).await?;
    close_session(session).await;
    let docker_installed = value_for(&output, "OPSNEST_DOCKER=", "missing") == "installed";
    Ok(ServerProfile {
        os_id: value_for(&output, "OPSNEST_OS_ID=", "linux").to_lowercase(),
        os_version: value_for(&output, "OPSNEST_OS_VERSION=", "").to_string(),
        os_name: value_for(&output, "OPSNEST_OS=", "Linux"),
        hostname: value_for(&output, "OPSNEST_HOSTNAME=", "未知主机"),
        cpu_cores: value_for(&output, "OPSNEST_CPU=", "未知"),
        memory: value_for(&output, "OPSNEST_MEMORY=", "未知"),
        disk: value_for(&output, "OPSNEST_DISK=", "未知"),
        docker_installed,
        docker_containers: value_for(&output, "OPSNEST_CONTAINERS=", "0"),
    })
}

fn diagnosis_commands(focus: &str) -> Vec<(&'static str, &'static str)> {
    let focus = focus.to_lowercase();
    let mut commands = vec![
        ("系统版本", "uname -a"),
        ("运行时间与负载", "uptime"),
        ("磁盘空间", "df -hP"),
        ("内存状态", "free -h 2>/dev/null || true"),
        ("失败服务", "systemctl --failed --no-legend --no-pager 2>/dev/null || true"),
        ("监听端口", "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true"),
        ("Docker 容器", "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null || true"),
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
        commands.push(("llama.cpp 安装位置", "command -v llama-server || command -v llama-cli || true"));
    }
    commands
}

#[tauri::command]
pub async fn diagnose_server(request: SshTestRequest, focus: String) -> Result<Vec<DiagnosisResult>, String> {
    let session = connect_session(&request).await?;
    let mut results = Vec::new();
    for (label, command) in diagnosis_commands(&focus) {
        match run_command(&session, command, None).await {
            Ok(output) => results.push(DiagnosisResult { label: label.to_string(), command: command.to_string(), output: output.chars().take(4000).collect(), success: true }),
            Err(error) => results.push(DiagnosisResult { label: label.to_string(), command: command.to_string(), output: error, success: false }),
        }
    }
    close_session(session).await;
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
    let session = connect_session(&request).await?;
    let (cancellation, command_id) = if let Some(command_id) = request.command_id.clone().filter(|value| !value.trim().is_empty()) {
        let (sender, receiver) = oneshot::channel();
        command_cancellations().lock().map_err(|_| "无法创建命令控制器".to_string())?.insert(command_id.clone(), sender);
        (Some(receiver), Some(command_id))
    } else {
        (None, None)
    };
    let result = run_command(&session, command, cancellation).await;
    if let Some(command_id) = command_id {
        if let Ok(mut commands) = command_cancellations().lock() { commands.remove(&command_id); }
    }
    close_session(session).await;
    result
}

#[tauri::command]
pub fn stop_ssh_command(command_id: String) -> Result<(), String> {
    let sender = command_cancellations().lock().map_err(|_| "无法停止命令".to_string())?.remove(command_id.trim());
    match sender {
        Some(sender) => sender.send(()).map_err(|_| "命令已经结束".to_string()),
        None => Err("没有正在执行的命令".to_string()),
    }
}
