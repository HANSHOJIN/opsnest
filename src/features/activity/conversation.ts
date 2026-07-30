import type { ConversationLog } from "../../domain/types";

export function normalizeConversationLog(log: ConversationLog): ConversationLog {
  if (log.scope !== "terminal") return { ...log, sessionName: log.sessionName ?? "服务器总管" };
  const sessionName = log.sessionName ?? (log.serverName?.startsWith("SSH 终端 - ") ? log.serverName : `SSH 终端 - ${log.serverName ?? "未知服务器"}`);
  return { ...log, sessionName, serverName: sessionName };
}
