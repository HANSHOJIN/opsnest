import { invoke } from "@tauri-apps/api/core";
import { writeDebugLog } from "./debugLog";

export async function readPortableJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const content = await invoke<string | null>("read_portable_json", { fileName });
    if (!content) return fallback;
    return JSON.parse(content) as T;
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
