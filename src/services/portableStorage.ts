import { invoke } from "@tauri-apps/api/core";
import { writeDebugLog } from "./debugLog";

export async function readPortableJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const content = await invoke<string | null>("read_portable_json", { fileName });
    if (!content) return fallback;
    const parsed = JSON.parse(content) as unknown;
    // Older builds accidentally wrote an already-stringified JSON value,
    // leaving activity.json double-encoded. Accept that format while it is
    // being migrated so existing task and AI records remain visible.
    return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as T;
  } catch (error) {
    void writeDebugLog("warn", "portable JSON read failed", { fileName, error: String(error) });
    return fallback;
  }
}

export async function writePortableJson(fileName: string, value: unknown): Promise<void> {
  try {
    await invoke("write_portable_json", {
      fileName,
      content: JSON.stringify(value),
    });
  } catch (error) {
    void writeDebugLog("warn", "portable JSON write failed", { fileName, error: String(error) });
    throw error;
  }
}
