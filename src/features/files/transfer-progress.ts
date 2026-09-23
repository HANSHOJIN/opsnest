import { listen } from "@tauri-apps/api/event";

type FileTransferProgress = {
  direction: "download" | "upload";
  transferred: number;
  total: number;
  bytesPerSecond: number;
  resumedFrom: number;
};

function formatRate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "准备中";
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function renderTransferProgress(payload: FileTransferProgress) {
  const root = document.querySelector<HTMLElement>(".file-manager-transfer");
  if (!root) return;

  const progress = payload.total > 0
    ? Math.min(100, Math.max(0, Math.round((payload.transferred / payload.total) * 100)))
    : 100;
  const rate = formatRate(payload.bytesPerSecond);
  const resumed = payload.resumedFrom > 0 ? " · 断点续传" : "";

  const status = root.querySelector<HTMLElement>("strong");
  if (status) status.textContent = `${progress}% · ${rate}${resumed}`;

  const bar = root.querySelector<HTMLElement>(".file-manager-progress > i");
  if (bar) bar.style.width = `${progress}%`;
}

// The existing file manager already owns the transfer card and progress bar.
// Keep progress transport independent from the large App component: the Rust
// backend emits bounded transfer events and this bridge paints the live values
// while React continues to own start/success/error state.
void listen<FileTransferProgress>("file-transfer-progress", (event) => {
  renderTransferProgress(event.payload);
});
