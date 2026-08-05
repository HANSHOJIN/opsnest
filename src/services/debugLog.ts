import { invoke } from "@tauri-apps/api/core";

export type DebugLevel = "debug" | "info" | "warn" | "error";

export function writeDebugLog(level: DebugLevel, message: string, details?: unknown) {
  const detailText = details === undefined ? undefined : typeof details === "string" ? details : JSON.stringify(details);
  return invoke("append_debug_log", { level, message, details: detailText }).catch(() => undefined);
}
