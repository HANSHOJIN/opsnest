import type { ManagerServerDetails } from "../../domain/types";

export function isManagerAddServerRequest(input: string) {
  return /(?:添加|新增|新建|保存).*(?:服务器|主机)|(?:add|new)\s+(?:a\s+)?server/i.test(input);
}

export function isManagerDeleteServerRequest(input: string) {
  return /(?:删除|移除|忘记).*(?:服务器|主机)|(?:delete|remove)\s+(?:the\s+)?server/i.test(input);
}

export function generateTunnelScript(server: { name: string; host: string; port: number; username: string }, relay: { host: string; name: string; port?: number; username?: string }, remotePort: number): string {
  const sshPort = server.port || 22;
  const relaySshPort = relay.port || 22;
  const tunnelUser = server.username || "root";
  const relayUser = relay.username || "root";
  const shell = `# ========================================
# ${server.name} → ${relay.name} 反向隧道一键配置
# 在目标内网主机上执行
# ========================================

TUNNEL_HOST="${relay.host}"
TUNNEL_PORT="${relaySshPort}"
REMOTE_PORT=${remotePort}
LOCAL_SSH_PORT=${sshPort}
TUNNEL_USER="${tunnelUser}"
RELAY_USER="${relayUser}"

echo "=== 1. 安装 autossh ==="
if command -v apt >/dev/null 2>&1; then
  apt update -qq && apt install -y -qq autossh
elif command -v opkg >/dev/null 2>&1; then
  opkg update && opkg install autossh
elif command -v yum >/dev/null 2>&1; then
  yum install -y autossh
else
  echo "无法识别包管理器，请手动安装 autossh"
fi

echo "=== 2. 生成 SSH 密钥 ==="
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" 2>/dev/null

echo ""
echo "=== 把下面这行公钥添加到 ${relay.name} 的 ~\${RELAY_USER}/.ssh/authorized_keys ==="
cat ~/.ssh/id_ed25519.pub
echo ""
read -p "公钥已添加？(y/n) " OK
if [ "$OK" != "y" ]; then echo "请先添加公钥"; exit 1; fi

echo "=== 3. 测试连接 ==="
ssh -o StrictHostKeyChecking=accept-new -p \${TUNNEL_PORT} \${RELAY_USER}@\${TUNNEL_HOST} "echo 连接成功"

echo "=== 4. 创建隧道服务/脚本 ==="
SERVICE_FILE="/etc/systemd/system/reverse-tunnel.service"
STARTUP_SCRIPT="/usr/local/bin/reverse-tunnel.sh"

# 生成独立的隧道启动脚本（所有环境通用）
cat > \${STARTUP_SCRIPT} << 'SHEOF'
#!/bin/sh
exec /usr/bin/autossh -M 0 \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  -o "StrictHostKeyChecking=no" \
  -o "ExitOnForwardFailure=yes" \
  -N -R 0.0.0.0:"$REMOTE_PORT":localhost:"$LOCAL_SSH_PORT" \
  "$RELAY_USER"@"$TUNNEL_HOST" -p "$TUNNEL_PORT"
SHEOF
chmod +x \${STARTUP_SCRIPT}

if [ -d /etc/systemd/system ]; then
  # systemd — Debian/Ubuntu/飞牛/多数 Linux
  sudo tee \${SERVICE_FILE} > /dev/null <<UNIT
[Unit]
Description=Reverse tunnel to \${TUNNEL_HOST}:\${REMOTE_PORT}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${tunnelUser}
ExecStart=\${STARTUP_SCRIPT}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now reverse-tunnel.service
  echo "✅ systemd 服务已创建并启动"
elif command -v crontab >/dev/null 2>&1; then
  # crontab @reboot 方案（OpenWrt / 精简容器）
  (crontab -l 2>/dev/null | grep -v reverse-tunnel; echo "@reboot \${STARTUP_SCRIPT}") | crontab -
  # 立即启动
  nohup \${STARTUP_SCRIPT} > /var/log/reverse-tunnel.log 2>&1 &
  echo "✅ crontab @reboot 已添加，隧道已启动"
elif [ -f /etc/rc.local ]; then
  # rc.local 方案
  grep -q reverse-tunnel /etc/rc.local || echo "\${STARTUP_SCRIPT} &" >> /etc/rc.local
  nohup \${STARTUP_SCRIPT} > /var/log/reverse-tunnel.log 2>&1 &
  echo "✅ rc.local 已添加，隧道已启动"
else
  # 纯 nohup 保底
  nohup \${STARTUP_SCRIPT} > /var/log/reverse-tunnel.log 2>&1 &
  echo "✅ 隧道已在后台运行"
  echo "⚠️  未检测到 systemd / crontab / rc.local，重启后需手动启动"
fi

echo ""
echo "✅ 隧道已建立！跳板机 \${TUNNEL_HOST}:\${REMOTE_PORT} → ${server.host}:${sshPort}"
echo "   使用跳板机用户: \${RELAY_USER}@\${TUNNEL_HOST} -p \${TUNNEL_PORT}"
echo "   现在可以在 OpsNest 中连接此服务器了。"
`;
  return shell;
}

export function extractManagerServerDetails(input: string): ManagerServerDetails {
  const field = (labels: string) => input.match(new RegExp(`(?:${labels})\\s*[:=：]?\\s*([^\\n\\r,，;；]+)`, "i"))?.[1]?.trim();
  const host = input.match(/(?:服务器地址|主机地址|地址|IP|host)\s*[:=：]?\s*([a-z0-9.-]+\.[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})/i)?.[1]?.trim();
  const portText = field("SSH\\s*端口|端口|port");
  const port = portText && /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
  return {
    name: field("服务器名称|主机名称|名称|名字|name"),
    host,
    port,
    username: field("用户名|用户|user(?:name)?"),
    password: field("密码|口令|password|passwd"),
    privateKeyPath: field("私钥|私钥路径|key|private\\s*key"),
  };
}

export function isServiceShortcutRequest(input: string) {
  return /(?:添加|加入|放到|放入|设置).*(?:快捷入口|首页|服务入口)|(?:扫描|发现|识别).*(?:服务|面板|软件)/i.test(input);
}
