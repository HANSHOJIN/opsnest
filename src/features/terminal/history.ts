import type { ConversationLog, Server, TerminalLine } from "../../domain/types";

export function restoreTerminalLines(
  server: Server,
  conversations: ConversationLog[],
  isLikelyShellCommand: (input: string) => boolean,
): TerminalLine[] {
  const lines: TerminalLine[] = [{ kind: "system", text: `${server.username}@${server.host}:${server.port} · SSH` }];

  conversations
    .filter((item) => item.scope === "terminal" && item.serverId === server.id)
    .forEach((item) => {
      if (!item.content.trim()) return;

      if (item.role === "tool") {
        const sections = item.content.split(/\n\n/);
        const command = sections.shift()?.trim() ?? "";
        if (command.startsWith("$ ")) lines.push({ kind: "command", text: command.slice(2) });
        const output = sections.join("\n\n").trim();
        if (output) lines.push({ kind: "output", text: output });
        return;
      }

      lines.push({
        kind: item.role === "assistant" ? "ai" : item.role === "user" ? (isLikelyShellCommand(item.content) ? "command" : "ai") : "system",
        text: item.content,
      });
    });

  return lines;
}
