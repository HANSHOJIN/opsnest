use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::{io::Read, net::{TcpStream, ToSocketAddrs}, path::Path, time::Duration};

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
}

#[derive(Debug, Serialize)]
pub struct SshTestResponse { pub system: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub os_name: String,
    pub hostname: String,
    pub cpu_cores: String,
    pub memory: String,
    pub disk: String,
    pub docker_installed: bool,
    pub docker_containers: String,
}

fn connect_session(request: &SshTestRequest) -> Result<Session, String> {
    if request.host.trim().is_empty() { return Err("请输入服务器地址。".into()); }
    if request.username.trim().is_empty() { return Err("请输入用户名。".into()); }
    let address = format!("{}:{}", request.host.trim(), request.port).to_socket_addrs().map_err(|_| "服务器地址或端口格式不正确。")?.next().ok_or("无法解析服务器域名。")?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(10)).map_err(|_| "无法连接服务器，请检查地址、端口和防火墙。")?;
    tcp.set_read_timeout(Some(Duration::from_secs(10))).map_err(|error| error.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(10))).map_err(|error| error.to_string())?;

    let mut session = Session::new().map_err(|error| error.to_string())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(10_000);
    session.handshake().map_err(|_| "SSH 握手失败，请确认目标端口提供的是 SSH 服务。")?;
    match request.auth_method.as_str() {
        "password" => session.userauth_password(request.username.trim(), request.password.as_deref().unwrap_or("")).map_err(|_| "登录失败，请检查用户名和密码。")?,
        "privateKey" => session.userauth_pubkey_file(request.username.trim(), None, Path::new(request.private_key_path.as_deref().unwrap_or("")), request.passphrase.as_deref()).map_err(|_| "私钥登录失败，请检查文件路径和私钥密码。")?,
        _ => return Err("暂不支持这种登录方式。".into()),
    }
    if !session.authenticated() { return Err("服务器拒绝了登录请求。".into()); }
    Ok(session)
}

fn run_command(session: &mut Session, command: &str) -> Result<String, String> {
    let mut channel = session.channel_session().map_err(|_| "已登录，但无法打开远程会话。")?;
    channel.exec(command).map_err(|_| "无法执行远程命令。")?;
    let mut output = String::new();
    channel.read_to_string(&mut output).map_err(|_| "无法读取服务器输出。")?;
    let mut error_output = String::new();
    channel.stderr().read_to_string(&mut error_output).map_err(|_| "无法读取命令错误信息。")?;
    channel.wait_close().map_err(|_| "远程会话关闭失败。")?;
    if !error_output.trim().is_empty() {
        if !output.ends_with('\n') && !output.is_empty() { output.push('\n'); }
        output.push_str(&error_output);
    }
    Ok(output)
}

fn value_for(output: &str, key: &str, fallback: &str) -> String {
    output.lines().find_map(|line| line.strip_prefix(key).map(|value| value.trim().to_string())).filter(|value| !value.is_empty()).unwrap_or_else(|| fallback.to_string())
}

#[tauri::command]
pub fn test_ssh_connection(request: SshTestRequest) -> Result<SshTestResponse, String> {
    let mut session = connect_session(&request)?;
    let output = run_command(&mut session, "uname -srm")?;
    let system = output.trim().chars().take(120).collect::<String>();
    Ok(SshTestResponse { system: if system.is_empty() { "Linux 服务器".into() } else { system } })
}

#[tauri::command]
pub fn inspect_server(request: SshTestRequest) -> Result<ServerProfile, String> {
    let mut session = connect_session(&request)?;
    let command = r#"
printf 'OPSNEST_OS='; (grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"') || uname -s
printf '\nOPSNEST_HOSTNAME='; hostname 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_CPU='; nproc 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_MEMORY='; awk '/MemTotal/ {printf "%.1f GB", $2/1024/1024}' /proc/meminfo 2>/dev/null || printf 'unknown'
printf '\nOPSNEST_DISK='; df -h / 2>/dev/null | awk 'NR==2 {print $4 " free of " $2}'
if command -v docker >/dev/null 2>&1; then printf '\nOPSNEST_DOCKER=installed'; printf '\nOPSNEST_CONTAINERS='; docker ps -q 2>/dev/null | wc -l; else printf '\nOPSNEST_DOCKER=missing'; printf '\nOPSNEST_CONTAINERS=0'; fi
"#;
    let output = run_command(&mut session, command)?;
    let docker_installed = value_for(&output, "OPSNEST_DOCKER=", "missing") == "installed";
    Ok(ServerProfile {
        os_name: value_for(&output, "OPSNEST_OS=", "Linux"),
        hostname: value_for(&output, "OPSNEST_HOSTNAME=", "未知主机"),
        cpu_cores: value_for(&output, "OPSNEST_CPU=", "未知"),
        memory: value_for(&output, "OPSNEST_MEMORY=", "未知"),
        disk: value_for(&output, "OPSNEST_DISK=", "未知"),
        docker_installed,
        docker_containers: value_for(&output, "OPSNEST_CONTAINERS=", "0"),
    })
}

#[tauri::command]
pub fn execute_ssh_command(request: SshTestRequest, command: String) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() { return Err("请输入命令。".into()); }
    if command.len() > 8_000 { return Err("命令太长，请分次执行。".into()); }
    let mut session = connect_session(&request)?;
    run_command(&mut session, command)
}
