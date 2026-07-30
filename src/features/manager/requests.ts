import type { ManagerServerDetails } from "../../domain/types";

export function isManagerAddServerRequest(input: string) {
  return /(?:添加|新增|新建|保存).*(?:服务器|主机)|(?:add|new)\s+(?:a\s+)?server/i.test(input);
}

export function isManagerDeleteServerRequest(input: string) {
  return /(?:删除|移除|忘记).*(?:服务器|主机)|(?:delete|remove)\s+(?:the\s+)?server/i.test(input);
}

export function generateTunnelScript(server: { name: string; host: string; port: number; username: string }, relay: { host: string; name: string }, remotePort: number): string {
  const shell = `# ========================================
# ${server.name} → ${relay.name} 反向隧道一键配置
# 在目标内网主机上以 root 执行
# ========================================

TUNNEL_HOST="${relay.host}"
REMOTE_PORT="${remotePort}"

echo "=== 1. 安装 autossh ==="
apt update -qq && apt install -y -qq autossh

echo "=== 2. 生成 SSH 密钥 ==="
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" 2>/dev/null

echo ""
echo "=== 把下面这行公钥添加到 ${relay.name} 的 ~/.ssh/authorized_keys ==="
cat ~/.ssh/id_ed25519.pub
echo ""
read -p "公钥已添加？(y/n) " OK
if [ "$OK" != "y" ]; then echo "请先添加公钥"; exit 1; fi

echo "=== 3. 测试连接 ==="
ssh -o StrictHostKeyChecking=accept-new root@${TUNNEL_HOST} "echo 连接成功"

echo "=== 4. 创建隧道服务 ==="
cat > /etc/systemd/system/reverse-tunnel.service <<UNIT
[Unit]
Description=Reverse tunnel to ${TUNNEL_HOST}:${REMOTE_PORT}
After=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/autossh -M 0 \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  -o "StrictHostKeyChecking=no" \
  -o "ExitOnForwardFailure=yes" \
  -N -R 0.0.0.0:${REMOTE_PORT}:localhost:22 \
  root@${TUNNEL_HOST}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now reverse-tunnel.service

echo ""
echo "✅ 隧道已建立！跳板机 ${TUNNEL_HOST}:${REMOTE_PORT} → ${server.host}:${server.port}"
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
