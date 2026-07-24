use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::{io::Read, net::{SocketAddr, TcpStream}, path::Path, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestRequest {
    pub name: String,
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

#[tauri::command]
pub fn test_ssh_connection(request: SshTestRequest) -> Result<SshTestResponse, String> {
    if request.host.trim().is_empty() { return Err("请输入服务器地址。".into()); }
    if request.username.trim().is_empty() { return Err("请输入用户名。".into()); }
    let address: SocketAddr = format!("{}:{}", request.host.trim(), request.port).parse().map_err(|_| "服务器地址或端口格式不正确。")?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(10)).map_err(|_| "无法连接服务器，请检查地址、端口和防火墙。")?;
    tcp.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;

    let mut session = Session::new().map_err(|e| e.to_string())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(10_000);
    session.handshake().map_err(|_| "SSH 握手失败，请确认端口提供的是 SSH 服务。")?;
    match request.auth_method.as_str() {
        "password" => session.userauth_password(request.username.trim(), request.password.as_deref().unwrap_or("")).map_err(|_| "登录失败，请检查用户名和密码。")?,
        "privateKey" => session.userauth_pubkey_file(request.username.trim(), None, Path::new(request.private_key_path.as_deref().unwrap_or("")), request.passphrase.as_deref()).map_err(|_| "私钥登录失败，请检查文件路径和私钥密码。")?,
        _ => return Err("暂不支持这种登录方式。".into()),
    }
    if !session.authenticated() { return Err("服务器拒绝了登录请求。".into()); }

    let mut channel = session.channel_session().map_err(|_| "已登录，但无法打开远程会话。")?;
    channel.exec("uname -srm").map_err(|_| "已登录，但无法读取系统信息。")?;
    let mut output = String::new();
    channel.read_to_string(&mut output).map_err(|_| "无法读取服务器信息。")?;
    channel.wait_close().map_err(|_| "远程会话关闭失败。")?;
    let system = output.trim().chars().take(120).collect::<String>();
    Ok(SshTestResponse { system: if system.is_empty() { "Linux 服务器".into() } else { system } })
}
