use russh::{client, keys, ChannelMsg};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest { pub host: String, pub port: u16, pub username: String, pub auth_method: String, pub password: Option<String>, pub private_key_path: Option<String>, pub passphrase: Option<String> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult { pub system: String, pub hostname: String, pub cpu: String, pub memory: String, pub disk: String, pub docker: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredService { pub id: String, pub name: String, pub kind: String, pub status: String, pub detail: String, pub port: Option<u16>, pub web_path: Option<String>, pub web_scheme: Option<String>, pub version: Option<String> }

struct Handler { host: String, port: u16 }
impl client::Handler for Handler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &russh::keys::ssh_key::PublicKey) -> Result<bool, Self::Error> {
        match keys::known_hosts::check_known_hosts(&self.host, self.port, key)? { true => Ok(true), false => { keys::known_hosts::learn_known_hosts(&self.host, self.port, key)?; Ok(true) } }
    }
}

async fn connect(request: &ScanRequest) -> Result<client::Handle<Handler>, String> {
    let host = request.host.trim();
    let config = client::Config { inactivity_timeout: None, keepalive_interval: Some(Duration::from_secs(10)), keepalive_max: 0, ..Default::default() };
    let mut session = tokio::time::timeout(Duration::from_secs(15), client::connect(Arc::new(config), format!("{host}:{}", request.port), Handler { host: host.to_string(), port: request.port }))
        .await.map_err(|_| "SSH 连接超时".to_string())?.map_err(|error| format!("SSH 握手失败: {error}"))?;
    let authenticated = if request.auth_method == "password" {
        session.authenticate_password(request.username.trim(), request.password.as_deref().unwrap_or("")).await.map_err(|error| format!("SSH 登录失败: {error}"))?
    } else {
        let path = request.private_key_path.as_deref().ok_or_else(|| "未提供 SSH 私钥".to_string())?;
        let key = keys::load_secret_key(path, request.passphrase.as_deref()).map_err(|error| format!("读取私钥失败: {error}"))?;
        session.authenticate_publickey(request.username.trim(), keys::PrivateKeyWithHashAlg::new(Arc::new(key), session.best_supported_rsa_hash().await.map_err(|error| error.to_string())?.flatten())).await.map_err(|error| format!("SSH 登录失败: {error}"))?
    };
    if !authenticated.success() { return Err("服务器拒绝了登录请求".to_string()); }
    Ok(session)
}

async fn execute(session: &client::Handle<Handler>, command: &str) -> Result<String, String> {
    let mut channel = session.channel_open_session().await.map_err(|error| error.to_string())?;
    channel.exec(true, command).await.map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    while let Some(message) = channel.wait().await { if let ChannelMsg::Data { data } = message { output.extend_from_slice(&data); } }
    Ok(String::from_utf8_lossy(&output).to_string())
}

#[tauri::command]
pub async fn inspect_linux_server(request: ScanRequest) -> Result<ScanResult, String> {
    let session = connect(&request).await?;
    let command = r#"printf 'SYSTEM='; (grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"' || uname -sr); printf '\nHOSTNAME='; hostname; printf '\nCPU='; (nproc 2>/dev/null || awk '/^processor/{n++} END{print n+0}' /proc/cpuinfo); printf '\nMEMORY='; awk '/MemTotal/{printf "%.1f GB", $2/1024/1024}' /proc/meminfo; printf '\nDISK='; df -h / 2>/dev/null | awk 'NR==2{print $4 " free of " $2}'; printf '\nDOCKER='; if command -v docker >/dev/null 2>&1; then printf 'installed · '; docker ps -q 2>/dev/null | wc -l | tr -d ' '; printf ' running'; else printf 'not installed'; fi"#;
    let raw = execute(&session, command).await?;
    let mut result = ScanResult { system: "未扫描".into(), hostname: "未扫描".into(), cpu: "未扫描".into(), memory: "未扫描".into(), disk: "未扫描".into(), docker: "未扫描".into() };
    for line in raw.lines() { if let Some((key, value)) = line.split_once('=') { match key { "SYSTEM" => result.system = value.trim().to_string(), "HOSTNAME" => result.hostname = value.trim().to_string(), "CPU" => result.cpu = format!("{} 核", value.trim()), "MEMORY" => result.memory = value.trim().to_string(), "DISK" => result.disk = value.trim().to_string(), "DOCKER" => result.docker = value.trim().to_string(), _ => {} } } }
    Ok(result)
}

#[tauri::command]
pub async fn discover_linux_services(request: ScanRequest) -> Result<Vec<DiscoveredService>, String> {
    let session = connect(&request).await?;
    let command = r#"printf 'PANEL\n'; if [ -d /opt/1panel ] || command -v 1pctl >/dev/null 2>&1; then panel_url=$(1pctl user-info 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | head -n 1); panel_port=$(printf '%s' \"$panel_url\" | sed -nE 's#^https?://[^/:]+:([0-9]+).*#\1#p'); [ -z \"$panel_port\" ] && panel_port=$(grep -E 'port:' /opt/1panel/conf/app.yaml 2>/dev/null | head -n 1 | sed -E 's/[^0-9]*([0-9]+).*/\1/'); [ -z \"$panel_port\" ] && panel_port=20520; panel_scheme=$(printf '%s' \"$panel_url\" | sed -nE 's#^(https?)://.*#\1#p'); [ -z \"$panel_scheme\" ] && panel_scheme=https; printf '1panel\t运行中\t%s\t%s\t%s\n' \"$panel_port\" \"$panel_scheme\" \"${panel_url#*://*/}\"; fi; printf 'DOCKER\n'; if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null; fi; printf 'SYSTEMD\n'; for service in nginx apache2 httpd caddy; do if command -v \"$service\" >/dev/null 2>&1; then status=stopped; systemctl is-active --quiet \"$service\" 2>/dev/null && status=running; port=$(ss -ltn 2>/dev/null | awk '$4 ~ /:(80|443|8080|8443)$/ {sub(/^.*:/,\"\",$4); print $4; exit}'); [ -n \"$port\" ] && printf '%s\t%s\t%s\t%s\n' \"$service\" \"$status\" \"$port\" \"$service\"; fi; done"#;
    let raw = execute(&session, command).await?;
    let mut services = Vec::new();
    let mut section = "";
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "PANEL" { section = "panel"; continue; }
        if line == "DOCKER" { section = "docker"; continue; }
        if line == "SYSTEMD" { section = "systemd"; continue; }
        if line == "PORT" { section = "port"; continue; }
        let parts = line.split('\t').collect::<Vec<_>>();
        match section {
            "panel" if parts.len() >= 4 => { if let Ok(port) = parts[2].parse::<u16>() { services.push(DiscoveredService { id: "1panel".into(), name: "1Panel".into(), kind: "Web".into(), status: parts[1].to_string(), detail: "1Panel 管理面板".into(), port: Some(port), web_path: None, web_scheme: Some(parts[3].to_string()), version: None }); } },
            "docker" if parts.len() >= 3 => { if let Some(port) = parts.get(3).and_then(|ports| ports.split(',').find_map(|item| item.split("->").next()?.rsplit(':').next()?.parse::<u16>().ok())) { services.push(DiscoveredService { id: format!("docker-{}", parts[0]), name: parts[0].to_string(), kind: "Docker".into(), status: parts[1].to_string(), detail: parts[2].to_string(), port: Some(port), web_path: None, web_scheme: Some(if port == 443 || port == 8443 { "https" } else { "http" }.into()), version: Some(parts[2].to_string()) }); } },
            "systemd" => { let name = line.split_whitespace().next().unwrap_or(line).to_string(); let port = line.split_whitespace().find_map(|part| part.parse::<u16>().ok()); if let Some(port) = port { services.push(DiscoveredService { id: format!("web-{}", name), name, kind: "Web".into(), status: "running".into(), detail: line.to_string(), port: Some(port), web_path: None, web_scheme: Some(if port == 443 || port == 8443 { "https" } else { "http" }.into()), version: None }); } },
            "port" => {},
            _ => {}
        }
    }
    if !services.iter().any(|service: &DiscoveredService| service.id == "1panel") {
        let fallback = execute(&session, r#"if [ -d /opt/1panel ] || [ -x /usr/local/bin/1pctl ] || [ -x /usr/bin/1pctl ] || pgrep -f '1panel' >/dev/null 2>&1; then port=$(grep -E '^[[:space:]]*port:' /opt/1panel/conf/app.yaml /opt/1panel/conf/app.yaml 2>/dev/null | grep -Eo '[0-9]{2,5}' | head -n 1); [ -z \"$port\" ] && port=$(ss -ltnp 2>/dev/null | grep -Eo ':(20520|[0-9]{4,5})[[:space:]]' | grep -Eo '[0-9]{4,5}' | head -n 1); [ -z \"$port\" ] && port=20520; printf '1PANEL_FALLBACK\\t%s\\n' \"$port\"; fi"#).await.unwrap_or_default();
        if let Some(port) = fallback.lines().find_map(|line| line.strip_prefix("1PANEL_FALLBACK\t").and_then(|value| value.trim().parse::<u16>().ok())) {
            services.push(DiscoveredService { id: "1panel".into(), name: "1Panel".into(), kind: "Web".into(), status: "运行中".into(), detail: "1Panel 管理面板".into(), port: Some(port), web_path: None, web_scheme: Some(if port == 443 || port == 8443 { "https" } else { "http" }.into()), version: None });
        }
    }
    Ok(services)
}
