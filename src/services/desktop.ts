/**
 * Single boundary for browser-to-Tauri calls.
 * Feature modules import from here instead of coupling directly to Tauri APIs.
 */
export { invoke as desktopInvoke } from "@tauri-apps/api/core";
export { listen as listenDesktopEvent } from "@tauri-apps/api/event";
