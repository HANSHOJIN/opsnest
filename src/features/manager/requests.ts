import type { ManagerServerDetails, Server } from "../../domain/types";

/** Resolve an explicit host mention without turning every manager request into a cluster-wide task. */
export function resolveManagerTargetIds(input: string, servers: Server[]): string[] {
  const available = servers.filter((server) => server.status !== "failed");
  if (/所有|全部|每台|各台|集群|all\s+servers|every\s+server|cluster/i.test(input)) return available.map((server) => server.id);
  const normalized = input.toLocaleLowerCase();
  const matches = available.filter((server) => [server.name, server.host, `${server.username}@${server.host}`]
    .filter(Boolean)
    .some((value) => normalized.includes(value.toLocaleLowerCase())));
  return (matches.length ? matches : available).map((server) => server.id);
}

export function isManagerAddServerRequest(input: string) {
  return /(?:添加|新增|新建|保存).*(?:服务器|主机)|(?:add|new)\s+(?:a\s+)?server/i.test(input);
}

export function isManagerDeleteServerRequest(input: string) {
  return /(?:删除|移除|忘记).*(?:服务器|主机)|(?:delete|remove)\s+(?:the\s+)?server/i.test(input);
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
