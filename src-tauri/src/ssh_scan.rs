use russh::{client, keys, ChannelMsg};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub system: String,
    pub hostname: String,
    pub kernel: String,
    pub cpu: String,
    pub cpu_model: String,
    pub memory: String,
    pub disk: String,
    pub docker: String,
    pub router: Option<RouterScanResult>,
    pub nas: Option<NasScanResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterScanResult {
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
pub struct NasScanResult {
    pub kind: String,
    pub version: String,
    pub management_port: String,
    pub storage: Vec<StorageScanResult>,
    pub apps: Vec<NasInstalledApp>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageScanResult {
    pub name: String,
    pub kind: String,
    pub profile: String,
    pub devices: String,
    pub mount_point: String,
    pub total: String,
    pub used: String,
    pub available: String,
    pub percent: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NasInstalledApp {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub status: String,
    pub port: Option<u16>,
    pub icon_data: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredService {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub detail: String,
    pub port: Option<u16>,
    pub web_path: Option<String>,
    pub web_scheme: Option<String>,
    pub version: Option<String>,
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

async fn connect(request: &ScanRequest) -> Result<client::Handle<Handler>, String> {
    let host = request.host.trim();
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
    .map_err(|_| "SSH 连接超时".to_string())?
    .map_err(|error| format!("SSH 握手失败: {error}"))?;
    let authenticated = if request.auth_method == "password" {
        session
            .authenticate_password(
                request.username.trim(),
                request.password.as_deref().unwrap_or(""),
            )
            .await
            .map_err(|error| format!("SSH 登录失败: {error}"))?
    } else {
        let path = request
            .private_key_path
            .as_deref()
            .ok_or_else(|| "未提供 SSH 私钥".to_string())?;
        let key = keys::load_secret_key(path, request.passphrase.as_deref())
            .map_err(|error| format!("读取私钥失败: {error}"))?;
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
            .map_err(|error| format!("SSH 登录失败: {error}"))?
    };
    if !authenticated.success() {
        return Err("服务器拒绝了登录请求".to_string());
    }
    Ok(session)
}

async fn execute(session: &client::Handle<Handler>, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    channel
        .exec(true, command)
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

// OpenWrt variants expose runtime network state through different helpers.
// This probe prefers ubus for DHCP/PPPoE interfaces, then falls back to UCI
// and the kernel tables. Client counts use leases plus live neighbors, while
// Wi-Fi clients come from hostapd/iw instead of a fixed zero.
const OPENWRT_ROUTER_PROBE: &str = r#"if [ -r /etc/openwrt_release ] || [ -r /etc/config/system ]; then
printf 'ROUTER=yes\n'
printf 'ROUTER_MODEL='; ([ -r /tmp/sysinfo/model ] && cat /tmp/sysinfo/model) || (ubus call system board 2>/dev/null | jsonfilter -e '@.model' 2>/dev/null); printf '\n'
printf 'ROUTER_FIRMWARE='; awk -F= '/^DISTRIB_DESCRIPTION=/{gsub(/^["\047]|["\047]$/,"",$2); print $2; exit}' /etc/openwrt_release 2>/dev/null; printf '\n'
printf 'ROUTER_KERNEL='; uname -r 2>/dev/null; printf '\n'

interface_ipv4() {
  interface_status=$(ubus call "network.interface.$1" status 2>/dev/null || ifstatus "$1" 2>/dev/null || true)
  address=''
  if [ -n "$interface_status" ] && command -v jsonfilter >/dev/null 2>&1; then
    address=$(printf '%s' "$interface_status" | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null | head -n 1)
  fi
  if [ -z "$address" ] && [ -n "$interface_status" ]; then
    address=$(printf '%s' "$interface_status" | grep -o '"address"[[:space:]]*:[[:space:]]*"[0-9][0-9.]*"' 2>/dev/null | head -n 1 | sed 's/.*"\([0-9][0-9.]*\)".*/\1/')
  fi
  printf '%s' "$address"
}

wan_ip=$(interface_ipv4 wan)
[ -z "$wan_ip" ] && wan_ip=$(uci -q get network.wan.ipaddr 2>/dev/null || true)
[ -z "$wan_ip" ] && wan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[ -z "$wan_ip" ] && wan_ip=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
if [ -z "$wan_ip" ]; then
  wan_device=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
  [ -n "$wan_device" ] && wan_ip=$(ip -4 addr show dev "$wan_device" 2>/dev/null | awk '$1=="inet"{sub("/.*","",$2); print $2; exit}')
fi
printf 'ROUTER_WAN=%s\n' "$wan_ip"

lan_device=$(uci -q get network.lan.device 2>/dev/null || true)
[ -z "$lan_device" ] && lan_device=$(uci -q get network.lan.ifname 2>/dev/null || true)
[ -z "$lan_device" ] && lan_device=br-lan
lan_ip=$(interface_ipv4 lan)
[ -z "$lan_ip" ] && lan_ip=$(uci -q get network.lan.ipaddr 2>/dev/null || true)
[ -z "$lan_ip" ] && lan_ip=$(ip -4 addr show dev "$lan_device" 2>/dev/null | awk '$1=="inet"{sub("/.*","",$2); print $2; exit}')
printf 'ROUTER_LAN=%s\n' "$lan_ip"

lan_clients=$({
  [ -r /tmp/dhcp.leases ] && awk 'NF >= 3 {print $2}' /tmp/dhcp.leases
  ip neigh show dev "$lan_device" 2>/dev/null | grep -Ev 'FAILED|INCOMPLETE'
  arp -an 2>/dev/null | awk -v dev="$lan_device" '$NF == dev'
} | awk '{for(i=1;i<=NF;i++) if(tolower($i) ~ /^[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]$/) print tolower($i)}' | sort -u | wc -l | tr -d ' ')
[ -z "$lan_clients" ] && lan_clients=0
printf 'ROUTER_LAN_CLIENTS=%s\n' "$lan_clients"

wifi_clients=$({
  if command -v ubus >/dev/null 2>&1; then
    for object in $(ubus list 'hostapd.*' 2>/dev/null); do ubus call "$object" get_clients 2>/dev/null; done
  fi
  if command -v iw >/dev/null 2>&1; then
    for device in $(iw dev 2>/dev/null | awk '$1=="Interface"{print $2}'); do iw dev "$device" station dump 2>/dev/null; done
  elif command -v iwinfo >/dev/null 2>&1; then
    for device in $(iwinfo 2>/dev/null | awk '$2=="ESSID:"{print $1}'); do iwinfo "$device" assoclist 2>/dev/null; done
  fi
} | awk '{for(i=1;i<=NF;i++){value=tolower($i); gsub(/^[^0-9a-f]*/,"",value); gsub(/[^0-9a-f]*$/,"",value); if(value ~ /^[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]$/) print value}}' | sort -u | wc -l | tr -d ' ')
[ -z "$wifi_clients" ] && wifi_clients=0
printf 'ROUTER_WIFI_CLIENTS=%s\n' "$wifi_clients"
fi"#;

#[tauri::command]
pub async fn inspect_linux_server(request: ScanRequest) -> Result<ScanResult, String> {
    let session = connect(&request).await?;
    #[allow(unused_variables)]
    let command = r#"printf 'SYSTEM='; (grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"' || uname -sr); printf '\nHOSTNAME='; hostname; printf '\nCPU='; (nproc 2>/dev/null || awk '/^processor/{n++} END{print n+0}' /proc/cpuinfo); printf '\nMEMORY='; awk '/MemTotal/{printf "%.1f GB", $2/1024/1024}' /proc/meminfo; printf '\nDISK='; df -h / 2>/dev/null | awk 'NR==2{print $4 " free of " $2}'; printf '\nDOCKER='; if command -v docker >/dev/null 2>&1; then printf 'installed · '; docker ps -q 2>/dev/null | wc -l | tr -d ' '; printf ' running'; else printf 'not installed'; fi"#;
    // OpenWrt derivatives may expose their real product name only here. For
    // example, iStoreOS can still report generic OpenWrt in /etc/os-release.
    let command = r#"printf 'SYSTEM='; if [ -r /etc/openwrt_release ]; then awk -F= '/^DISTRIB_DESCRIPTION=/{gsub(/^["\047]|["\047]$/,"",$2); print $2; exit}' /etc/openwrt_release; elif [ -r /etc/os-release ]; then grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"'; else uname -sr; fi; printf '\nHOSTNAME='; hostname; printf '\nKERNEL='; uname -r 2>/dev/null; printf '\nCPU='; (nproc 2>/dev/null || awk '/^processor/{n++} END{print n+0}' /proc/cpuinfo); printf '\nCPU_MODEL='; awk -F: '/^(model name|Hardware|Processor)[[:space:]]*:/{gsub(/^[[:space:]]+/, "", $2); if ($2 != "") {print $2; exit}}' /proc/cpuinfo 2>/dev/null; printf '\nMEMORY='; awk '/MemTotal/{printf "%.1f GB", $2/1024/1024}' /proc/meminfo; printf '\nDISK='; df -h / 2>/dev/null | awk 'NR==2{print $4 " free of " $2}'; printf '\nDOCKER='; if command -v docker >/dev/null 2>&1; then printf 'installed '; docker ps -q 2>/dev/null | wc -l | tr -d ' '; printf ' running'; else printf 'not installed'; fi"#;
    let nas_probe = r#"printf 'NAS_KIND='; if grep -qiE 'fnos|fnnas|飞牛' /etc/os-release /etc/fnos_release /etc/fnos-version /etc/*release 2>/dev/null || [ -r /usr/trim/etc/version ] || [ -d /usr/local/fnos ] || [ -d /var/lib/fnos ] || hostname 2>/dev/null | grep -qiE 'feiniu|fnos|fnnas' || ps 2>/dev/null | grep -v grep | grep -E 'fnos|fnnas|fnmain' >/dev/null 2>&1; then printf 'fnos'; fi; printf '\nNAS_VERSION='; for nas_version_file in /etc/fnos_release /etc/fnos-version /usr/local/fnos/version /usr/local/fnos/VERSION /usr/trim/etc/version; do if [ -r "$nas_version_file" ]; then tr '\n\r' '  ' < "$nas_version_file"; break; fi; done; printf '\nNAS_PORT='; nas_port=''; for candidate in 5666 8000; do if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{print $4}' | grep -E ":${candidate}$" >/dev/null 2>&1; then nas_port="$candidate"; break; elif command -v netstat >/dev/null 2>&1 && netstat -lnt 2>/dev/null | awk '{print $4}' | grep -E ":${candidate}$" >/dev/null 2>&1; then nas_port="$candidate"; break; fi; done; printf '%s' "$nas_port"; printf '\nSTORAGE_SCAN\n'; df -P -h 2>/dev/null | awk 'NR > 1 && $6 ~ /^\// && $1 !~ /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup)/ {printf "STORAGE=%s\t%s\t%s\t%s\t%s\n", $6, $2, $3, $4, $5}'"#;
    // fnOS exposes its logical pools as /volN mounts backed by Btrfs-on-LVM.
    // `btrfs filesystem show` is often unavailable to the SSH user, so use
    // the permission-safe findmnt/lsblk/df views instead of system/bind mounts.
    let storage_pool_probe = r#"printf 'STORAGE_POOL_SCAN\n'; if command -v findmnt >/dev/null 2>&1; then findmnt -rn -t btrfs -o TARGET,SOURCE 2>/dev/null | awk '$1 ~ /^\/vol[0-9]+$/ && !seen[$1]++ {print $1 "\t" $2}' | while read -r mount_point source; do [ -n "$mount_point" ] && [ -n "$source" ] || continue; volume_number=$(basename "$mount_point" | sed 's/[^0-9]//g'); pool_name="Storage $volume_number"; profile=$(lsblk -s -n -o TYPE "$source" 2>/dev/null | awk '/^raid[0-9]+$/{print toupper($0); exit}'); [ -z "$profile" ] && profile=single; device_count=$(lsblk -s -n -o TYPE "$source" 2>/dev/null | awk '$1=="disk"{count++} END{print count+0}'); [ -z "$device_count" ] || [ "$device_count" -lt 1 ] && device_count=1; fstype=$(findmnt -rn -o FSTYPE -T "$mount_point" 2>/dev/null | head -n 1); [ -z "$fstype" ] && fstype=btrfs; df_total=$(df -P -h "$mount_point" 2>/dev/null | awk 'NR==2 {print $2}'); df_used=$(df -P -h "$mount_point" 2>/dev/null | awk 'NR==2 {print $3}'); df_available=$(df -P -h "$mount_point" 2>/dev/null | awk 'NR==2 {print $4}'); df_percent=$(df -P -h "$mount_point" 2>/dev/null | awk 'NR==2 {print $5}'); [ -n "$df_total" ] && printf 'STORAGE_POOL=%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pool_name" "$mount_point" "$fstype" "$profile" "$device_count" "$df_total" "$df_used" "$df_available" "$df_percent"; done; fi"#;
    let app_probe = r#"printf 'NAS_APP_SCAN\n'; manifest_value() { value=$(awk -F= -v key="$1" '$1 ~ "^[[:space:]]*" key "[[:space:]]*$" {sub(/^[^=]*=/, ""); print; exit}' "$2" 2>/dev/null); printf '%s' "$value" | sed -E 's/^[[:space:]]*[\"\x27]//; s/[\"\x27][[:space:]]*$//' | tr '\r\n\t' '   '; }; for manifest in /var/apps/*/manifest; do [ -r "$manifest" ] || continue; app_dir=$(basename "$(dirname "$manifest")"); app_id=$(manifest_value appname "$manifest"); [ -z "$app_id" ] && app_id="$app_dir"; version=$(manifest_value version "$manifest"); display_name=$(manifest_value display_name "$manifest"); source=$(manifest_value source "$manifest"); port=$(manifest_value service_port "$manifest"); case "$app_id" in all.editor) display_name='万能编辑器';; bunjs) display_name='Bun';; gotty) display_name='gotty'; [ -z "$port" ] && port=12700;; nodejs_v24) display_name='Node.js v24';; qBittorrent) display_name='qBittorrent';; trim.media) display_name='影视'; [ -z "$port" ] && port=8005;; trim.openclaw) display_name='飞牛 OpenClaw';; trim.photos) display_name='相册';; trim.text-editor) display_name='文本编辑器';; esac; [ -z "$display_name" ] || printf '%s' "$display_name" | grep -q '\${' && display_name="$app_id"; status=installed; process_key=$(printf '%s' "$app_id" | sed 's/[._]/-/g'); if ps -eo args 2>/dev/null | grep -F -- "$app_id" | grep -v grep >/dev/null 2>&1 || ps -eo args 2>/dev/null | grep -F -- "$process_key" | grep -v grep >/dev/null 2>&1; then status=running; elif [ -n "$port" ] && ss -lntH 2>/dev/null | awk '{print $4}' | grep -E ":${port}$" >/dev/null 2>&1; then status=running; fi; icon_data=''; icon_file="/var/apps/$app_dir/ICON_256.PNG"; [ -r "$icon_file" ] && icon_data=$(base64 "$icon_file" 2>/dev/null | tr -d '\r\n'); printf 'NAS_APP=%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$app_id" "$display_name" "$version" "$source" "$status" "$port" "$icon_data"; done"#;
    let mut raw = execute(&session, command).await?;
    raw.push('\n');
    raw.push_str(&execute(&session, nas_probe).await.unwrap_or_default());
    raw.push('\n');
    raw.push_str(&execute(&session, storage_pool_probe).await.unwrap_or_default());
    raw.push('\n');
    raw.push_str(&execute(&session, app_probe).await.unwrap_or_default());
    let router_probe = OPENWRT_ROUTER_PROBE;
    raw.push('\n');
    raw.push_str(&execute(&session, router_probe).await.unwrap_or_default());
    let mut result = ScanResult {
        system: "未扫描".into(),
        hostname: "未扫描".into(),
        kernel: String::new(),
        cpu: "未扫描".into(),
        cpu_model: String::new(),
        memory: "未扫描".into(),
        disk: "未扫描".into(),
        docker: "未扫描".into(),
        router: None,
        nas: None,
    };
    for line in raw.lines() {
        if let Some((key, value)) = line.split_once('=') {
            match key {
                "SYSTEM" => result.system = value.trim().to_string(),
                "HOSTNAME" => result.hostname = value.trim().to_string(),
                "KERNEL" => result.kernel = value.trim().to_string(),
                "CPU" => result.cpu = format!("{} 核", value.trim()),
                "CPU_MODEL" => result.cpu_model = value.trim().to_string(),
                "MEMORY" => result.memory = value.trim().to_string(),
                "DISK" => result.disk = value.trim().to_string(),
                "DOCKER" => result.docker = value.trim().to_string(),
                "NAS_KIND" if value.trim().eq_ignore_ascii_case("fnos") => {
                    result.nas = Some(NasScanResult {
                        kind: "fnos".into(),
                        version: "unknown".into(),
                        management_port: "5666".into(),
                        storage: Vec::new(),
                        apps: Vec::new(),
                    });
                }
                "NAS_VERSION" => if let Some(nas) = result.nas.as_mut() {
                    let version = value.trim();
                    if !version.is_empty() { nas.version = version.to_string(); }
                },
                "NAS_PORT" => if let Some(nas) = result.nas.as_mut() {
                    let port = value.trim();
                    if !port.is_empty() { nas.management_port = port.to_string(); }
                },
                "STORAGE" => if let Some(nas) = result.nas.as_mut() {
                    let parts = value.split('\t').map(str::trim).collect::<Vec<_>>();
                    if parts.len() >= 5 && !parts[0].is_empty() {
                        nas.storage.push(StorageScanResult {
                            name: parts[0].to_string(),
                            kind: "filesystem".into(),
                            profile: String::new(),
                            devices: String::new(),
                            mount_point: parts[0].to_string(),
                            total: parts[1].to_string(),
                            used: parts[2].to_string(),
                            available: parts[3].to_string(),
                            percent: parts[4].to_string(),
                        });
                    }
                },
                "STORAGE_POOL" => if let Some(nas) = result.nas.as_mut() {
                    let parts = value.split('\t').map(str::trim).collect::<Vec<_>>();
                    if parts.len() >= 9 && !parts[0].is_empty() {
                        nas.storage.push(StorageScanResult {
                            name: parts[0].to_string(),
                            mount_point: parts[1].to_string(),
                            kind: parts[2].to_string(),
                            profile: parts[3].to_string(),
                            devices: parts[4].to_string(),
                            total: parts[5].to_string(),
                            used: parts[6].to_string(),
                            available: parts[7].to_string(),
                            percent: parts[8].to_string(),
                        });
                    }
                },
                "NAS_APP" => if let Some(nas) = result.nas.as_mut() {
                    let parts = value.split('\t').map(str::trim).collect::<Vec<_>>();
                    if parts.len() >= 6 && !parts[0].is_empty() {
                        let icon_data = parts.get(6).filter(|data| !data.is_empty()).map(|data| {
                            format!("data:image/png;base64,{data}")
                        });
                        nas.apps.push(NasInstalledApp {
                            id: parts[0].to_string(),
                            name: parts[1].to_string(),
                            version: parts[2].to_string(),
                            source: parts[3].to_string(),
                            status: parts[4].to_string(),
                            port: parts[5].parse::<u16>().ok(),
                            icon_data,
                        });
                    }
                },
                "ROUTER" if value.trim() == "yes" => {
                    result.router = Some(RouterScanResult {
                        model: String::new(),
                        firmware: String::new(),
                        kernel: String::new(),
                        wan_ip: String::new(),
                        lan_ip: String::new(),
                        lan_clients: "0".into(),
                        wifi_clients: "0".into(),
                    })
                }
                "ROUTER_MODEL" => if let Some(router) = result.router.as_mut() {
                    let model = value.trim();
                    if !model.is_empty() && !model.to_ascii_lowercase().contains("default string") {
                        router.model = model.to_string();
                    }
                },
                "ROUTER_FIRMWARE" => if let Some(router) = result.router.as_mut() { router.firmware = value.trim().to_string(); },
                "ROUTER_KERNEL" => if let Some(router) = result.router.as_mut() { router.kernel = value.trim().to_string(); },
                "ROUTER_WAN" => if let Some(router) = result.router.as_mut() { router.wan_ip = value.trim().to_string(); },
                "ROUTER_LAN" => if let Some(router) = result.router.as_mut() { router.lan_ip = value.trim().to_string(); },
                "ROUTER_LAN_CLIENTS" => if let Some(router) = result.router.as_mut() { router.lan_clients = value.trim().to_string(); },
                "ROUTER_WIFI_CLIENTS" => if let Some(router) = result.router.as_mut() { router.wifi_clients = value.trim().to_string(); },
                _ => {}
            }
        }
    }
    if let Some(nas) = result.nas.as_mut() {
        if nas.storage.iter().any(|volume| volume.kind == "btrfs") {
            nas.storage.retain(|volume| volume.kind != "filesystem");
        }
    }
    Ok(result)
}

fn docker_service_from_parts(parts: &[&str]) -> Option<DiscoveredService> {
    if parts.len() < 3 {
        return None;
    }
    let port = parts.get(3).and_then(|ports| {
        let mut mappings = ports.split(',').filter_map(|item| {
            let (host, container) = item.trim().split_once("->")?;
            let host_port = host.rsplit(':').next()?.parse::<u16>().ok()?;
            let container_port = container
                .split('/')
                .next()
                .and_then(|value| value.parse::<u16>().ok())?;
            Some((host_port, container_port))
        });
        // When a container publishes several ports, prefer its HTTP(S) target
        // (for example 3300:80) over an auxiliary same-port mapping (8091:8091).
        mappings
            .find(|(_, container_port)| matches!(*container_port, 80 | 443))
            .or_else(|| ports.split(',').filter_map(|item| {
                let (host, _) = item.trim().split_once("->")?;
                Some(host.rsplit(':').next()?.parse::<u16>().ok()?)
            }).next().map(|host_port| (host_port, 0)))
            .map(|(host_port, _)| host_port)
    });
    Some(DiscoveredService {
        id: format!("docker-{}", parts[0]),
        name: parts[0].to_string(),
        kind: "Docker".into(),
        status: parts[1].to_string(),
        detail: parts[2].to_string(),
        port,
        web_path: None,
        web_scheme: port.map(|value| {
            if value == 443 || value == 8443 {
                "https"
            } else {
                "http"
            }
            .into()
        }),
        version: Some(parts[2].to_string()),
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[tauri::command]
pub async fn discover_linux_services(
    request: ScanRequest,
) -> Result<Vec<DiscoveredService>, String> {
    let session = connect(&request).await?;
    fn discover_command() -> &'static str {
        r#"printf 'PANEL\n';
if [ -d /opt/1panel ] || command -v 1pctl >/dev/null 2>&1; then
  one_status=stopped
  ps 2>/dev/null | grep -v grep | grep -E '1panel|1p-daemon' >/dev/null 2>&1 && one_status=running
  one_port=''; one_url=''; one_scheme=http; one_path=''
  if command -v 1pctl >/dev/null 2>&1; then one_url=$(1pctl user-info 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | head -n 1 | tr -d '\r'); fi
  if [ -n "$one_url" ]; then
    one_port=$(printf '%s' "$one_url" | sed -nE 's#^https?://[^/:]+:([0-9]+)(/.*)?$#\1#p')
    one_scheme=$(printf '%s' "$one_url" | sed -nE 's#^(https?)://.*#\1#p')
    one_path=$(printf '%s' "$one_url" | sed -nE 's#^https?://[^/]+(/.*)$#\1#p')
  fi
  if [ -z "$one_port" ] && command -v ss >/dev/null 2>&1; then one_port=$(ss -lntpH 2>/dev/null | grep -E '1panel|1p-daemon' | sed -nE 's/.*:([0-9]+)[[:space:]].*/\1/p' | head -n 1); fi
  if [ -z "$one_port" ] && [ -r /opt/1panel/conf/app.yaml ]; then one_port=$(awk -F: '/^[[:space:]]*port:/{gsub(/[[:space:]]/, "", $2); print $2; exit}' /opt/1panel/conf/app.yaml 2>/dev/null); fi
  if [ -z "$one_path" ] && [ -r /opt/1panel/conf/app.yaml ]; then one_path=$(grep -Ei 'securityEntrance|security-entrance|security_entrance' /opt/1panel/conf/app.yaml 2>/dev/null | head -n 1 | sed -E 's/.*:[[:space:]]*//' | tr -d ' ' | tr -d '"'); fi
  case "$one_path" in /*) ;; "") ;; *) one_path="/$one_path" ;; esac
  [ -z "$one_port" ] && one_port=20520
  one_web=https; printf '1panel\t%s\t%s\t%s\t%s\n' "$one_status" "$one_port" "$one_scheme" "$one_path"
fi
printf 'DOCKER\n'
container_exec() {
  if command -v docker >/dev/null 2>&1; then
    docker "$@" 2>/dev/null && return 0
    if command -v sudo >/dev/null 2>&1; then sudo -n docker "$@" 2>/dev/null && return 0; fi
    if [ -n "$OPSNEST_SUDO_PASSWORD" ] && command -v sudo >/dev/null 2>&1; then printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' docker "$@" 2>/dev/null && return 0; fi
  fi
  if command -v podman >/dev/null 2>&1; then
    podman "$@" 2>/dev/null && return 0
    if command -v sudo >/dev/null 2>&1; then sudo -n podman "$@" 2>/dev/null && return 0; fi
    if [ -n "$OPSNEST_SUDO_PASSWORD" ] && command -v sudo >/dev/null 2>&1; then printf '%s\n' "$OPSNEST_SUDO_PASSWORD" | sudo -S -p '' podman "$@" 2>/dev/null && return 0; fi
  fi
  return 1
}

if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
  container_list=$(container_exec ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null || true)
  if [ -n "$container_list" ]; then printf '%s\n' "$container_list"; fi
fi
printf 'SYSTEMD\n'; for service in nginx apache2 httpd caddy; do if command -v "$service" >/dev/null 2>&1; then status=stopped; systemctl is-active --quiet "$service" 2>/dev/null && status=running; port=$(ss -ltn 2>/dev/null | awk '$4 ~ /:(80|443|8080|8443)$/ {sub(/^.*:/,"",$4); print $4; exit}'); [ -n "$port" ] && printf '%s\t%s\t%s\t%s\n' "$service" "$status" "$port" "$service"; fi; done
printf 'OPENWRT\n'
if [ -r /etc/openwrt_release ] || [ -r /etc/config/system ]; then
  for service in uhttpd dropbear dnsmasq odhcpd rpcd netifd firewall hostapd wpa_supplicant miniupnpd mwan3 sqm adblock banip ddns tailscale wireguard openclash passwall openlist lucky; do
    if [ -x "/etc/init.d/$service" ]; then
      status=installed
      "/etc/init.d/$service" running >/dev/null 2>&1 && status=running
      [ "$status" = installed ] && pidof "$service" >/dev/null 2>&1 && status=running
      name="$service"; category=router; port='-'; scheme=http
      case "$service" in
        uhttpd)
          name='LuCI / uHTTPd'; category=panel
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
        openclash) name='OpenClash';;
        passwall) name='PassWall';;
        openlist) name='OpenList'; category=panel; port=5244;;
        lucky) name='Lucky'; category=panel; port=16601;;
      esac
      printf 'openwrt-%s\t%s\t%s\t%s\t%s\t%s\n' "$service" "$name" "$status" "$port" "$scheme" "$category"
    fi
  done
fi
printf 'FNOS\n'
if grep -qiE 'fnos|fnnas|飞牛' /etc/os-release /etc/fnos_release /etc/fnos-version /etc/*release 2>/dev/null || [ -d /usr/local/fnos ] || [ -d /var/lib/fnos ] || hostname 2>/dev/null | grep -qiE 'feiniu|fnos|fnnas'; then
  fnos_port=''
  for candidate in 5666 8000; do
    if command -v ss >/dev/null 2>&1 && ss -lntH 2>/dev/null | awk '{print $4}' | grep -E ":${candidate}$" >/dev/null 2>&1; then fnos_port="$candidate"; break; fi
  done
  [ -z "$fnos_port" ] && fnos_port=5666
  printf 'fnos\tFeiniu fnOS\trunning\t%s\thttp\tpanel\n' "$fnos_port"
fi"#
    }
    let sudo_password = request
        .password
        .as_deref()
        .map(shell_quote)
        .unwrap_or_else(|| "''".to_string());
    let command = format!("OPSNEST_SUDO_PASSWORD={sudo_password}\n{}", discover_command());
    let raw = execute(&session, &command).await?;
    let mut services = Vec::new();
    let mut section = "";
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "PANEL" {
            section = "panel";
            continue;
        }
        if line == "DOCKER" {
            section = "docker";
            continue;
        }
        if line == "SYSTEMD" {
            section = "systemd";
            continue;
        }
        if line == "OPENWRT" {
            section = "openwrt";
            continue;
        }
        if line == "FNOS" {
            section = "fnos";
            continue;
        }
        if line == "PORT" {
            section = "port";
            continue;
        }
        let parts = line.split('\t').collect::<Vec<_>>();
        match section {
            "panel" if parts.len() >= 4 => {
                if let Ok(port) = parts[2].parse::<u16>() {
                    services.push(DiscoveredService {
                        id: "1panel".into(),
                        name: "1Panel".into(),
                        kind: "Web".into(),
                        status: parts[1].to_string(),
                        detail: "1Panel 管理面板".into(),
                        port: Some(port),
                        web_path: parts.get(4).filter(|value| !value.is_empty()).map(|value| value.to_string()),
                        web_scheme: parts.get(3).filter(|value| **value == "http" || **value == "https").map(|value| value.to_string()).or_else(|| Some("http".into())),
                        version: None,
                    });
                }
            }
            "docker" => {
                if let Some(service) = docker_service_from_parts(&parts) {
                    services.push(service);
                }
            }
            "systemd" => {
                let name = line.split_whitespace().next().unwrap_or(line).to_string();
                let port = line
                    .split_whitespace()
                    .find_map(|part| part.parse::<u16>().ok());
                if let Some(port) = port {
                    services.push(DiscoveredService {
                        id: format!("web-{}", name),
                        name,
                        kind: "Web".into(),
                        status: "running".into(),
                        detail: line.to_string(),
                        port: Some(port),
                        web_path: None,
                        web_scheme: Some(
                            if port == 443 || port == 8443 {
                                "https"
                            } else {
                                "http"
                            }
                            .into(),
                        ),
                        version: None,
                    });
                }
            }
            "openwrt" if parts.len() >= 6 => {
                let port = parts[3].parse::<u16>().ok();
                services.push(DiscoveredService {
                    id: parts[0].to_string(),
                    name: parts[1].to_string(),
                    kind: "Router".into(),
                    status: parts[2].to_string(),
                    detail: "OpenWrt 内置服务".into(),
                    port,
                    web_path: None,
                    web_scheme: port.map(|_| parts[4].to_string()),
                    version: Some(parts[5].to_string()),
                });
            }
            "fnos" if parts.len() >= 6 => {
                let port = parts[3].parse::<u16>().ok();
                services.push(DiscoveredService {
                    id: "fnos".into(),
                    name: parts[1].to_string(),
                    kind: "NAS".into(),
                    status: parts[2].to_string(),
                    detail: "Feiniu fnOS NAS".into(),
                    port,
                    web_path: None,
                    web_scheme: Some(parts[4].to_string()),
                    version: None,
                });
            }
            "port" => {}
            _ => {}
        }
    }
    if !services
        .iter()
        .any(|service: &DiscoveredService| service.id == "1panel")
    {
        let fallback = execute(&session, r#"if [ -d /opt/1panel ] || [ -x /usr/local/bin/1pctl ] || [ -x /usr/bin/1pctl ] || pgrep -f '1panel' >/dev/null 2>&1; then port=$(grep -E '^[[:space:]]*port:' /opt/1panel/conf/app.yaml 2>/dev/null | grep -Eo '[0-9]{2,5}' | head -n 1); [ -z \"$port\" ] && port=$(ss -ltnp 2>/dev/null | grep -i 1panel | grep -Eo ':[0-9]+' | grep -Eo '[0-9]+' | head -n 1); [ -z \"$port\" ] && port=20520; printf '1PANEL_FALLBACK\\t%s\\n' \"$port\"; fi"#).await.unwrap_or_default();
        if let Some(port) = fallback.lines().find_map(|line| {
            line.strip_prefix("1PANEL_FALLBACK\t")
                .and_then(|value| value.trim().parse::<u16>().ok())
        }) {
            services.push(DiscoveredService {
                id: "1panel".into(),
                name: "1Panel".into(),
                kind: "Web".into(),
                status: "运行中".into(),
                detail: "1Panel 管理面板".into(),
                port: Some(port),
                web_path: None,
                web_scheme: Some(
                    if port == 443 || port == 8443 {
                        "https"
                    } else {
                        "http"
                    }
                    .into(),
                ),
                version: None,
            });
        }
    }
    // A number of 1Panel installations do not expose a reliable `1pctl user-info`
    // URL. Probe the installation and its configured/listening port with a clean
    // shell command as a final fallback. Keep this separate from the legacy probe
    // above so older servers remain compatible.
    if !services
        .iter()
        .any(|service: &DiscoveredService| service.id == "1panel")
    {
        let probe = execute(
            &session,
            r#"if [ -d /opt/1panel ] || command -v 1pctl >/dev/null 2>&1 || systemctl list-unit-files 2>/dev/null | grep -q '^1panel'; then
port=$(grep -E '^[[:space:]]*port:' /opt/1panel/conf/app.yaml 2>/dev/null | grep -Eo '[0-9]{2,5}' | head -n 1)
[ -z "$port" ] && port=$(ss -ltn 2>/dev/null | awk '$4 ~ /:[0-9]+$/ {sub(/^.*:/,"",$4); if ($4 >= 1000) {print $4; exit}}')
[ -z "$port" ] && port=20520
printf 'OPSNEST_1PANEL\t%s\n' "$port"
fi"#,
        )
        .await
        .unwrap_or_default();
        if let Some(port) = probe.lines().find_map(|line| {
            line.strip_prefix("OPSNEST_1PANEL\t")
                .and_then(|value| value.trim().parse::<u16>().ok())
        }) {
            services.push(DiscoveredService {
                id: "1panel".into(),
                name: "1Panel".into(),
                kind: "Web".into(),
                status: "运行中".into(),
                detail: "1Panel 管理面板".into(),
                port: Some(port),
                web_path: None,
                web_scheme: Some(if port == 443 || port == 8443 { "https" } else { "http" }.into()),
                version: None,
            });
        }
    }
    Ok(services)
}

#[cfg(test)]
mod tests {
    use super::{docker_service_from_parts, OPENWRT_ROUTER_PROBE};

    #[test]
    fn openwrt_probe_uses_runtime_network_and_client_sources() {
        assert!(OPENWRT_ROUTER_PROBE.contains("network.interface.$1"));
        assert!(OPENWRT_ROUTER_PROBE.contains("/tmp/dhcp.leases"));
        assert!(OPENWRT_ROUTER_PROBE.contains("ip neigh show"));
        assert!(OPENWRT_ROUTER_PROBE.contains("hostapd.*"));
        assert!(OPENWRT_ROUTER_PROBE.contains("station dump"));
        assert!(!OPENWRT_ROUTER_PROBE.contains("ROUTER_WIFI_CLIENTS=0"));
    }

    #[test]
    fn docker_discovery_keeps_containers_without_published_ports() {
        let service = docker_service_from_parts(&["adguard", "Up 3 hours", "adguard/adguardhome"])
            .expect("container should be retained");
        assert_eq!(service.name, "adguard");
        assert_eq!(service.kind, "Docker");
        assert_eq!(service.port, None);
    }

    #[test]
    fn docker_discovery_extracts_first_published_host_port() {
        let service = docker_service_from_parts(&[
            "luci-app",
            "Up 2 days",
            "example/luci",
            "0.0.0.0:8080->80/tcp, :::8080->80/tcp",
        ])
        .expect("container should be retained");
        assert_eq!(service.port, Some(8080));
        assert_eq!(service.web_scheme.as_deref(), Some("http"));
    }

    #[test]
    fn docker_discovery_uses_host_port_for_web_entry() {
        let service = docker_service_from_parts(&[
            "mediahelper",
            "Up 2 hours",
            "mediahelper:latest",
            "0.0.0.0:3300->80/tcp, :::3300->80/tcp, 0.0.0.0:8091->8091/tcp",
        ])
        .expect("container should be retained");
        assert_eq!(service.port, Some(3300));
    }
}
