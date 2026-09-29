import { invoke } from "@tauri-apps/api/core";

export type DebugLevel = "debug" | "info" | "warn" | "error";

function redactDebugText(value: string) {
  return value
    .replace(
      /(-----BEGIN [^-]+PRIVATE KEY-----)[\s\S]*?(-----END [^-]+PRIVATE KEY-----)/gi,
      "$1[redacted]$2",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|x-api-key|x-opencode-session)\s*["']?\s*[:=]\s*["']?)([^\s,"';}]+)/gi,
      "$1[redacted]",
    )
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"';}]+/gi, "$1[redacted]")
    .replace(/(\b(?:API_KEY|OPENAI_API_KEY|OPENCODE_API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PASSWD)\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

export function writeDebugLog(level: DebugLevel, message: string, details?: unknown) {
  const detailText = details === undefined
    ? undefined
    : redactDebugText(typeof details === "string" ? details : JSON.stringify(details));
  return invoke("append_debug_log", { level, message, details: detailText }).catch(() => undefined);
}
