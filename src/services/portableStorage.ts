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

export async function readPortableText(fileName: string, fallback = ""): Promise<string> {
  try {
    return (await invoke<string | null>("read_portable_text", { fileName })) ?? fallback;
  } catch (error) {
    void writeDebugLog("warn", "portable text read failed", { fileName, error: String(error) });
    return fallback;
  }
}

export async function writePortableText(fileName: string, content: string): Promise<void> {
  try {
    await invoke("write_portable_text", { fileName, content });
  } catch (error) {
    void writeDebugLog("warn", "portable text write failed", { fileName, error: String(error) });
    throw error;
  }
}

export type WorkspaceInfo = {
  workspaceId: string;
  root: string;
  drafts: string;
  snapshots: string;
  artifacts: string;
};

export async function ensureWorkspace(
  workspaceId: string,
  displayName?: string,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("ensure_workspace", {
    workspaceId,
    displayName: displayName?.trim() || null,
  });
}

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

export async function listWorkspaceFiles(
  workspaceId: string,
  relativePath = "",
): Promise<WorkspaceFileEntry[]> {
  return invoke<WorkspaceFileEntry[]>("list_workspace_directory", {
    workspaceId,
    relativePath: relativePath || null,
  });
}

export async function readWorkspaceText(
  workspaceId: string,
  relativePath: string,
  fallback = "",
): Promise<string> {
  try {
    return (await invoke<string | null>("read_workspace_text", {
      workspaceId,
      relativePath,
    })) ?? fallback;
  } catch (error) {
    void writeDebugLog("warn", "workspace text read failed", {
      workspaceId,
      relativePath,
      error: String(error),
    });
    return fallback;
  }
}

export async function writeWorkspaceText(
  workspaceId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await invoke("write_workspace_text", { workspaceId, relativePath, content });
}

export async function deleteWorkspaceFile(
  workspaceId: string,
  relativePath: string,
): Promise<void> {
  await invoke("delete_workspace_file", { workspaceId, relativePath });
}
