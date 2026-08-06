import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, CircleGauge, Container, Database, Globe, Network, Server, SquareTerminal as TerminalGlyph, X } from "lucide-react";
import ShellLayout, { ShellNavigation, type DiscoveredServiceSummary, type ServerSummary } from "./components/ShellLayout";
import { ModelSettingsPanel } from "./components/ModelSettingsPanel";
import { readPortableJson, writePortableJson } from "./services/portableStorage";
import { writeDebugLog } from "./services/debugLog";
import { iconCandidates, iconDirectory, remoteIconUrl } from "./services/iconCatalog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

type Theme = "system" | "light" | "dark";
type Language = "zh-CN" | "en";
type CloseAction = "tray" | "exit";

type AppearancePreferences = {
  theme: Theme;
  language: Language;
  showMenuBar: boolean;
  translucentSidebar: boolean;
  reduceMotion: boolean;
  uiSize: number;
  closeAction: CloseAction;
  debugLogging: boolean;
};

type ModelPreferences = {
  provider: "custom" | "openai" | "deepseek" | "ollama";
  baseUrl: string;
  apiKey: string;
  model: string;
};

function isPrivateServerHost(host: string) {
  const value = host.trim().replace(/^.*@/, "").replace(/^\[|\]$/g, "").split(":")[0].toLowerCase();
  if (value === "localhost" || value.endsWith(".local") || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function isAlibabaLabel(value: string) {
  const normalized = value.toLowerCase();
  return normalized.includes("alibaba") || normalized.includes("anolis") || value.includes("\u963f\u91cc");
}

function ServiceIcon({ kind, name }: { kind: string; name: string }) {
  const key = `${kind} ${name}`.toLowerCase();
  if (key.includes("custom-web")) return <Globe size={18} strokeWidth={1.8} />;
  const directory = iconDirectory(kind, name);
  const Icon = directory === "systems" ? (key.includes("windows") ? Box : CircleGauge) : key.includes("docker") || key.includes("container") ? Container : key.includes("port") || key.includes("web") || key.includes("nginx") || key.includes("http") ? Globe : key.includes("database") || /mysql|postgres|redis|mongo/.test(key) ? Database : key.includes("network") || key.includes("listen") ? Network : Box;
  const baseKey = key.includes("1panel") || key.includes("1 panel") ? "1panel" : key.includes("docker") || key.includes("container") ? "docker" : key.includes("nginx") ? "nginx" : key.includes("mysql") ? "mysql" : key.includes("postgres") ? "postgres" : key.includes("redis") ? "redis" : key.includes("mongo") ? "mongodb" : key.includes("web") || key.includes("http") ? "web" : directory === "systems" ? (isAlibabaLabel(name) ? "alibaba" : key.includes("ubuntu") ? "ubuntu" : key.includes("debian") ? "debian" : "linux") : "generic";
  const isAlibabaSystem = directory === "systems" && isAlibabaLabel(name);
  const candidates = React.useMemo(() => { const found = iconCandidates(baseKey, name.match(/\d+(?:\.\d+)+/)?.[0]); return directory === "systems" ? [...found.filter((candidate) => candidate !== "generic"), "linux"] : found; }, [baseKey, name, directory]);
  const [remote, setRemote] = React.useState<string | null>(null);
  React.useEffect(() => { let active = true; setRemote(null); void (async () => { const candidatesToTry = isAlibabaSystem ? candidates.filter((candidate) => candidate !== "generic") : candidates; for (const candidate of candidatesToTry) { for (const type of ["svg", "png"] as const) { const packed = `/icons/packed/${directory}/${encodeURIComponent(candidate)}.${type}`; try { if (!isAlibabaSystem) { const localResponse = await fetch(packed); if (localResponse.ok) { if (active) setRemote(packed); return; } } const remoteUrl = remoteIconUrl(directory, candidate, type); const response = await fetch(remoteUrl); if (response.ok) { if (active) setRemote(remoteUrl); return; } } catch { /* continue to next source */ } } } if (active && isAlibabaSystem) setRemote("/icons/packed/systems/alibaba.png"); })(); return () => { active = false; }; }, [directory, candidates.join("|"), isAlibabaSystem]);
  if (isAlibabaSystem || baseKey === "alibaba") return <img className="service-icon-image system-alibaba" src="/icons/packed/systems/alibaba.png?v=3" alt="" aria-hidden="true" width={18} height={18} />;
  return remote ? <img className={`service-icon-image ${directory === "systems" ? `system-${baseKey}` : `service-${baseKey}`}`} src={remote} alt="" aria-hidden="true" width={18} height={18} onError={() => setRemote(null)} /> : <Icon size={18} strokeWidth={1.8} />;
}

function SystemIconBadge({ system }: { system?: string }) {
  const label = system || "linux";
  return <div className="system-icon-badge"><span className="system-icon-badge-image"><ServiceIcon kind="system" name={label} /></span><span>{label}</span></div>;
}

const APPEARANCE_FILE = "appearance.json";
const MODEL_FILE = "model.json";
const DEBUG_FILE = "debug.json";
const SERVERS_FILE = "servers.json";
const ACTIVITY_FILE = "activity.json";
// The manager conversation has its own durable snapshot. Activity records are
// an audit trail, not a reliable conversation store (older builds also wrote
// them in a double-encoded format), so restoring the chat must not depend on
// title/category matching.
const MANAGER_CHAT_FILE = "manager-chat.json";
type ActivityRecord = { id: string; category: "ai" | "task" | "system"; title: string; detail: string; timestamp: string };
type ManagerChatMessage = { role: "user" | "assistant"; text: string };

function sanitizeSensitiveText(value: string) {
  return value
    .replace(/(密码|口令|password|passwd)\s*(是|为|:|：)?\s*[^\s，。；;、]+/gi, "$1已由前端安全输入")
    .replace(/(ssh\s*)?(password|passwd)\s*=\s*[^\s,;]+/gi, "$1$2=[redacted]");
}

let activityWriteQueue: Promise<void> = Promise.resolve();
let managerChatWriteQueue: Promise<void> = Promise.resolve();
function appendActivity(record: Omit<ActivityRecord, "id" | "timestamp">) {
  const write = activityWriteQueue.then(async () => {
    const existing = await readPortableJson<ActivityRecord[]>(ACTIVITY_FILE, []);
    const items = Array.isArray(existing) ? existing : [];
    items.unshift({ ...record, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timestamp: new Date().toISOString() });
    await writePortableJson(ACTIVITY_FILE, items.slice(0, 500));
  });
  activityWriteQueue = write.catch(() => undefined);
  return write;
}
function persistManagerChat(messages: ManagerChatMessage[]) {
  const snapshot = messages.slice(-500);
  managerChatWriteQueue = managerChatWriteQueue
    .catch(() => undefined)
    .then(() => writePortableJson(MANAGER_CHAT_FILE, snapshot))
    .catch(() => undefined);
  return managerChatWriteQueue;
}
const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "system",
  language: "zh-CN",
  showMenuBar: true,
  translucentSidebar: false,
  reduceMotion: false,
  uiSize: 14,
  closeAction: "tray",
  debugLogging: false,
};
const DEFAULT_MODEL: ModelPreferences = { provider: "custom", baseUrl: "", apiKey: "", model: "" };

function serverManagerSystem(server: ServerSummary) {
  return [
    "你是 OpsNest 服务器总管，负责帮助用户理解、诊断和管理服务器。",
    `当前服务器：${server.name}，地址：${server.host}:${server.port}。`,
    `当前连接状态：${server.connected ? "已连接" : "未连接"}。`,
    `系统：${server.system || "尚未扫描"}；CPU：${server.cpu || "尚未扫描"}；内存：${server.memory || "尚未扫描"}；磁盘：${server.disk || "尚未扫描"}；Docker：${server.docker || "尚未扫描"}。`,
    "所有用户输入都交给你结合上下文判断，不要依据固定关键词或预设的寒暄词做本地分流。普通聊天、确认、感谢、追问和对结果的讨论都应自然回答；只有用户明确要求检查、读取、修改或执行服务器操作时，才考虑调用工具。",
    "没有真实工具结果时，不要声称已经执行、修改或验证了任何操作。需要修改配置时先说明目标文件、拟修改内容和风险，并等待用户确认。"
  ].join("\n");
}

function normalizeAppearance(parsed: Partial<AppearancePreferences>): AppearancePreferences {
  return {
    theme: parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system" ? parsed.theme : DEFAULT_APPEARANCE.theme,
    language: parsed.language === "en" ? "en" : DEFAULT_APPEARANCE.language,
    showMenuBar: parsed.showMenuBar !== false,
    translucentSidebar: parsed.translucentSidebar === true,
    reduceMotion: parsed.reduceMotion === true,
    uiSize: parsed.uiSize === 13 || parsed.uiSize === 15 ? parsed.uiSize : DEFAULT_APPEARANCE.uiSize,
    closeAction: parsed.closeAction === "exit" ? "exit" : DEFAULT_APPEARANCE.closeAction,
    debugLogging: parsed.debugLogging === true,
  };
}

function EmptySlot({ label }: { label: string }) {
  return <div className="empty-slot" aria-label={label} />;
}

type LocalFileEntry = { name: string; path: string; isDir: boolean; size: number };
type RemoteFileEntry = { name: string; path: string; isDir: boolean; size: number };

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function FileManagerPanel({ server, servers, openSignal = 0, onEmpty }: { server: ServerSummary; servers: ServerSummary[]; openSignal?: number; onEmpty?: () => void }) {
  const [remotePath, setRemotePath] = React.useState("/root");
  const [localPath, setLocalPath] = React.useState("");
  const [remoteFiles, setRemoteFiles] = React.useState<RemoteFileEntry[]>([]);
  const [localFiles, setLocalFiles] = React.useState<LocalFileEntry[]>([]);
  const [activeServerId, setActiveServerId] = React.useState(server.id);
  const [openServerIds, setOpenServerIds] = React.useState(() => [server.id]);
  const [showAddMenu, setShowAddMenu] = React.useState(false);
  const [selectedRemote, setSelectedRemote] = React.useState<RemoteFileEntry | null>(null);
  const [selectedLocal, setSelectedLocal] = React.useState<LocalFileEntry | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [transfer, setTransfer] = React.useState<{ label: string; progress: number; rate: string } | null>(null);
  const activeServer = servers.find((item) => item.id === activeServerId) || server;
  React.useEffect(() => { setOpenServerIds((current) => current.filter((id) => servers.some((item) => item.id === id))); }, [servers]);
  React.useEffect(() => { if (openSignal > 0) { setOpenServerIds([server.id]); setActiveServerId(server.id); setRemotePath("/root"); } }, [openSignal, server.id]);
  React.useEffect(() => { if (openServerIds.length === 0) { onEmpty?.(); window.dispatchEvent(new Event("opsnest-close-files")); } }, [openServerIds.length, onEmpty]);
  const closeServerTab = (id: string) => {
    setOpenServerIds((current) => {
      const next = current.filter((item) => item !== id);
      if (id === activeServerId) {
        const fallback = next[0] ?? "";
        setActiveServerId(fallback);
        if (!fallback) window.dispatchEvent(new Event("opsnest-close-files"));
      }
      return next;
    });
  };
  React.useEffect(() => {
    const tabBar = document.querySelector<HTMLElement>(".file-manager-tabs");
    if (!tabBar) return;
    tabBar.closest<HTMLElement>(".file-manager-panel")?.classList.toggle("is-empty", openServerIds.length === 0);
    const buttons = Array.from(tabBar.querySelectorAll<HTMLButtonElement>("button:not(.file-manager-add)"));
    const cleanups: Array<() => void> = [];
    servers.forEach((item, index) => {
      const button = buttons[index];
      const close = button?.querySelector<HTMLElement>("span:last-child");
      if (!button || !close) return;
      button.hidden = !openServerIds.includes(item.id);
      close.classList.add("file-manager-tab-close");
      const handler = (event: Event) => { event.stopPropagation(); closeServerTab(item.id); };
      close.addEventListener("click", handler);
      cleanups.push(() => close.removeEventListener("click", handler));
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [servers, openServerIds, activeServerId]);
  React.useEffect(() => {
    const tabBar = document.querySelector<HTMLElement>(".file-manager-tabs");
    const add = tabBar?.querySelector<HTMLButtonElement>(".file-manager-add");
    if (!tabBar || !add) return;
    const toggle = (event: Event) => { event.stopPropagation(); setShowAddMenu((value) => !value); };
    add.addEventListener("click", toggle, true);
    if (showAddMenu) {
      const menu = document.createElement("div"); menu.className = "file-manager-add-menu";
      servers.filter((item) => !openServerIds.includes(item.id)).forEach((item) => { const option = document.createElement("button"); option.type = "button"; option.textContent = item.name; option.onclick = () => { setOpenServerIds((current) => [...current, item.id]); setActiveServerId(item.id); setShowAddMenu(false); }; menu.appendChild(option); });
      if (!menu.childElementCount) { const empty = document.createElement("span"); empty.textContent = "没有可打开的服务器"; menu.appendChild(empty); }
      tabBar.appendChild(menu);
    }
    return () => { add.removeEventListener("click", toggle, true); tabBar.querySelector(".file-manager-add-menu")?.remove(); };
  }, [showAddMenu, servers, openServerIds]);

  const openSession = React.useCallback(async () => {
    const at = activeServer.host.indexOf("@");
    const username = at > 0 ? activeServer.host.slice(0, at) : "root";
    const host = at > 0 ? activeServer.host.slice(at + 1) : activeServer.host;
    const password = activeServer.password ?? await invoke<string | null>("load_server_credential", { serverId: activeServer.id }).catch(() => null);
    return invoke<{ sessionId: string }>("open_ssh_session", { request: { host, port: activeServer.port, username, authMethod: activeServer.authMethod ?? "password", password, privateKeyPath: null, passphrase: null } });
  }, [activeServer]);

  const loadRemote = React.useCallback(async () => {
    setBusy(true);
    let sessionId = "";
    try {
      const opened = await openSession(); sessionId = opened.sessionId;
      const raw = await invoke<string>("execute_ssh_command", { sessionId, command: `find ${shellQuote(remotePath)} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\n' 2>/dev/null | sort`, approved: true });
      const entries = raw.split(/\r?\n/).filter(Boolean).map((line) => { const [name, kind, size] = line.split("\t"); return { name, path: `${remotePath.replace(/\/$/, "")}/${name}`, isDir: kind === "d", size: Number(size) || 0 }; });
      setRemoteFiles(entries); setSelectedRemote(null);
    } catch (error) { setRemoteFiles([]); } finally { if (sessionId) await invoke("close_ssh_session", { sessionId }).catch(() => undefined); setBusy(false); }
  }, [openSession, remotePath]);

  const loadLocal = React.useCallback(async () => {
    try { const entries = await invoke<LocalFileEntry[]>("list_local_directory", { path: localPath || null }); setLocalFiles(entries); if (!localPath && entries[0]?.path) setLocalPath(entries[0].path.slice(0, Math.max(0, entries[0].path.lastIndexOf("\\")))); setSelectedLocal(null); } catch { setLocalFiles([]); }
  }, [localPath]);

  React.useEffect(() => { if (openServerIds.length > 0) void loadRemote(); }, [loadRemote, openServerIds.length]);
  React.useEffect(() => { if (openServerIds.length > 0) void loadLocal(); }, [loadLocal, openServerIds.length]);

  const transferRemoteToLocal = async () => {
    if (!selectedRemote || selectedRemote.isDir || busy) return;
    setBusy(true); setTransfer({ label: `下载 ${selectedRemote.name}`, progress: 0, rate: "准备中" });
    let sessionId = "";
    try {
      const opened = await openSession(); sessionId = opened.sessionId;
      const started = performance.now();
      const encoded = await invoke<string>("execute_ssh_command", { sessionId, command: `base64 -w0 -- ${shellQuote(selectedRemote.path)}`, approved: true });
      setTransfer({ label: `下载 ${selectedRemote.name}`, progress: 75, rate: `${Math.max(1, Math.round(encoded.length / Math.max(1, (performance.now() - started) / 1000) / 1024))} KB/s` });
      const target = `${localPath || "."}\\${selectedRemote.name}`;
      await invoke("write_local_file_base64", { path: target, content: encoded.replace(/\s/g, "") });
      setTransfer({ label: `下载 ${selectedRemote.name}`, progress: 100, rate: "完成" });
      await loadLocal();
    } catch (error) { setTransfer({ label: `传输失败：${String(error)}`, progress: 0, rate: "" }); } finally { if (sessionId) await invoke("close_ssh_session", { sessionId }).catch(() => undefined); setBusy(false); window.setTimeout(() => setTransfer(null), 1400); }
  };

  const transferLocalToRemote = async () => {
    if (!selectedLocal || selectedLocal.isDir || busy) return;
    setBusy(true); setTransfer({ label: `上传 ${selectedLocal.name}`, progress: 0, rate: "准备中" });
    let sessionId = "";
    try {
      const opened = await openSession(); sessionId = opened.sessionId;
      const encoded = await invoke<string>("read_local_file_base64", { path: selectedLocal.path });
      const target = `${remotePath.replace(/\/$/, "")}/${selectedLocal.name}`;
      const chunkSize = 48000; const started = performance.now();
      await invoke("execute_ssh_command", { sessionId, command: `: > ${shellQuote(target)}`, approved: true });
      for (let offset = 0; offset < encoded.length; offset += chunkSize) {
        const chunk = encoded.slice(offset, offset + chunkSize);
        await invoke("execute_ssh_command", { sessionId, command: `printf '%s' '${chunk}' | base64 -d >> ${shellQuote(target)}`, approved: true });
        const progress = Math.min(100, Math.round(((offset + chunk.length) / encoded.length) * 100));
        const rate = `${Math.max(1, Math.round((offset + chunk.length) / Math.max(1, (performance.now() - started) / 1000) / 1024))} KB/s`;
        setTransfer({ label: `上传 ${selectedLocal.name}`, progress, rate });
      }
      await loadRemote();
    } catch (error) { setTransfer({ label: `传输失败：${String(error)}`, progress: 0, rate: "" }); } finally { if (sessionId) await invoke("close_ssh_session", { sessionId }).catch(() => undefined); setBusy(false); window.setTimeout(() => setTransfer(null), 1400); }
  };

  const folder = (entry: { isDir: boolean; path: string }, remote: boolean) => { if (!entry.isDir) return; if (remote) setRemotePath(entry.path); else setLocalPath(entry.path); };
  const handleRemoteDrop = (event: React.DragEvent) => { event.preventDefault(); if (selectedLocal) void transferLocalToRemote(); };
  const handleLocalDrop = (event: React.DragEvent) => { event.preventDefault(); if (selectedRemote) void transferRemoteToLocal(); };
  if (openServerIds.length === 0) return <div className="file-manager-panel"><div className="file-manager-tabs">{servers.map((item) => <button key={item.id} hidden type="button">{item.name}<span>×</span></button>)}<button type="button" className="file-manager-add" aria-label="添加服务器标签">＋</button></div></div>;
  return <div className="file-manager-panel"><div className="file-manager-tabs">{servers.map((item) => <button key={item.id} className={item.id === activeServer.id ? "is-active" : ""} type="button" onClick={() => { setActiveServerId(item.id); setRemotePath("/root"); }}>{item.name}<span>×</span></button>)}<button type="button" className="file-manager-add" aria-label="添加服务器标签">＋</button></div><div className="file-manager-columns"><section className="file-manager-pane" onDragOver={(event) => event.preventDefault()} onDrop={handleRemoteDrop}><div className="file-manager-pane-heading"><strong>服务器</strong><button type="button" onClick={() => void loadRemote()} disabled={busy}>刷新</button></div><div className="file-manager-path">{remotePath}</div><div className="file-manager-list">{remoteFiles.map((entry) => <button draggable={!entry.isDir} key={entry.path} className={selectedRemote?.path === entry.path ? "is-selected" : ""} type="button" onClick={() => setSelectedRemote(entry)} onDragStart={() => setSelectedRemote(entry)} onDoubleClick={() => folder(entry, true)}><span>{entry.isDir ? "▰" : "▱"}</span>{entry.name}<small>{entry.isDir ? "文件夹" : `${entry.size} B`}</small></button>)}</div></section><section className="file-manager-pane" onDragOver={(event) => event.preventDefault()} onDrop={handleLocalDrop}><div className="file-manager-pane-heading"><strong>本地电脑</strong><button type="button" onClick={() => void loadLocal()} disabled={busy}>刷新</button></div><div className="file-manager-path">{localPath || "当前目录"}</div><div className="file-manager-list">{localFiles.map((entry) => <button draggable={!entry.isDir} key={entry.path} className={selectedLocal?.path === entry.path ? "is-selected" : ""} type="button" onClick={() => setSelectedLocal(entry)} onDragStart={() => setSelectedLocal(entry)} onDoubleClick={() => folder(entry, false)}><span>{entry.isDir ? "▰" : "▱"}</span>{entry.name}<small>{entry.isDir ? "文件夹" : `${entry.size} B`}</small></button>)}</div></section></div><div className="file-manager-actions"><button className="secondary" type="button" onClick={() => void transferRemoteToLocal()} disabled={!selectedRemote || selectedRemote.isDir || busy}>下载到本地</button><button className="primary" type="button" onClick={() => void transferLocalToRemote()} disabled={!selectedLocal || selectedLocal.isDir || busy}>上传到服务器</button></div>{transfer && <div className="file-manager-transfer"><div><span>{transfer.label}</span><strong>{transfer.progress}% · {transfer.rate}</strong></div><div className="file-manager-progress"><i style={{ width: `${transfer.progress}%` }} /></div></div>}</div>;
}

function FilesPlaceholder({ language }: { language: Language }) {
  const isEnglish = language === "en";
  return (
    <div className="files-placeholder" aria-label={isEnglish ? "Files area" : "文件区域"}>
      <span>{isEnglish ? "No files" : "暂无文件"}</span>
    </div>
  );
}

function HomePage({ language, onSelect, onConfigureModel, onOpenManagerBottom, onOpenTerminal, onOpenFiles, servers, aiConfigured }: { language: Language; onSelect: (id: string) => void; onConfigureModel: () => void; onOpenManagerBottom: () => void; onOpenTerminal: (id: string) => void; onOpenFiles: (id: string) => void; servers: ServerSummary[]; aiConfigured: boolean }) {
  const isEnglish = language === "en";
  const setupComplete = servers.length > 0 && aiConfigured;
  React.useEffect(() => {
    const cleanups: Array<() => void> = [];
    document.querySelectorAll<HTMLElement>(".home-server-card").forEach((card, index) => {
      const server = servers[index]; const actions = card.querySelector<HTMLElement>(".home-server-card-actions"); const detail = actions?.querySelector<HTMLButtonElement>(".text-button");
      if (!server || !actions || !detail) return;
      const top = card.querySelector<HTMLElement>(".home-server-card-top");
      const status = top?.querySelector<HTMLElement>("em");
      const network = document.createElement("em");
      network.className = "network-badge";
      network.textContent = isPrivateServerHost(server.host) ? (isEnglish ? "LAN" : "内网") : (isEnglish ? "WAN" : "外网");
      if (status) status.insertAdjacentElement("afterend", network);
      cleanups.push(() => network.remove());
      actions.querySelectorAll(".home-server-edit-action").forEach((item) => item.remove());
      detail.textContent = isEnglish ? "Open terminal" : "打开终端"; detail.classList.add("open-terminal-action"); detail.onclick = () => onOpenTerminal(server.id);
      const files = document.createElement("button"); files.type = "button"; files.className = "text-button home-server-files-action"; files.textContent = isEnglish ? "Files" : "文件管理"; files.addEventListener("click", () => onOpenFiles(server.id)); actions.insertBefore(files, detail); cleanups.push(() => files.remove());
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "text-button home-server-edit-action"; edit.textContent = isEnglish ? "Edit" : "编辑"; edit.addEventListener("click", () => onSelect(`__edit:${server.id}`)); actions.appendChild(edit); cleanups.push(() => edit.remove());
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [servers, isEnglish, onSelect]);
  return (
    <div className={`opsnest-home ${setupComplete ? "setup-complete" : ""}`}>
      <div className="home-heading"><div><div className="home-eyebrow">OpsNest</div><h1>{isEnglish ? "Welcome to OpsNest" : "欢迎使用 OpsNest"}</h1><p>{isEnglish ? "Manage servers, AI models, and daily operations from one place." : "从一个地方管理服务器、AI 模型和日常任务。"}</p></div><span className="home-status">● {isEnglish ? "Ready to configure" : "等待配置"}</span></div>
      {!setupComplete && <section className="home-guide"><div><span className="home-section-label">{isEnglish ? "Getting started" : "新手指引"}</span><h2>{isEnglish ? "Set up your workspace" : "先完成基础配置"}</h2><p>{isEnglish ? "Add a server and connect an AI model to unlock the full OpsNest workflow." : "添加服务器并连接 AI 模型，开始使用完整的 OpsNest 工作流。"}</p></div><div className="home-guide-actions"><button className="primary" type="button" onClick={() => onSelect("server-add")}>{isEnglish ? "Add your first server" : "添加第一台服务器"}</button><button className="primary" type="button" onClick={onConfigureModel}>{isEnglish ? "Configure AI model" : "配置 AI 模型"}</button></div></section>}
      <div className="home-section-heading"><h2>{isEnglish ? "Server overview" : "服务器总览"}</h2><button className="home-link open-manager-action" type="button" onClick={onOpenManagerBottom}>{isEnglish ? "Open manager" : "打开服务器总管"}</button></div>
      {servers.length === 0 ? <section className="home-empty-overview"><div className="home-empty-icon">⌁</div><strong>{isEnglish ? "No servers yet" : "还没有服务器"}</strong><span>{isEnglish ? "Your server cards will appear here after you add a server." : "添加服务器后，所有服务器卡片会汇集显示在这里。"}</span></section> : <section className="home-server-grid">{servers.map((server) => <article className="home-server-card" key={server.id}><div className="home-server-card-top"><div className="home-server-identity"><span className="home-server-icon"><ServiceIcon kind="system" name={server.system || "linux"} /></span><div><strong>{server.name}</strong><span>{server.host}:{server.port}</span></div></div><em className={server.connected ? "is-connected" : ""}>● {server.connected ? (isEnglish ? "Connected" : "已连接") : (isEnglish ? "Not connected" : "未连接")}</em></div><div className="home-server-system"><span>−</span>{server.system || (isEnglish ? "System information not scanned" : "尚未完成系统扫描")}</div><div className="home-server-stats"><div><span>CPU</span><strong>{server.cpu || "—"}</strong></div><div><span>{isEnglish ? "Memory" : "内存"}</span><strong>{server.memory || "—"}</strong></div><div><span>{isEnglish ? "System disk" : "系统盘"}</span><strong>{server.disk || "—"}</strong></div><div><span>Docker</span><strong>{server.docker ? (isEnglish ? server.docker.replace(/\bnot\s+installed\b/gi, "Not installed") : server.docker.replace(/\bnot\s+installed\b/gi, "未安装").replace(/\binstalled\b/gi, "已安装")) : "—"}</strong></div></div><div className="home-server-card-actions"><button className="primary" type="button" onClick={() => onSelect(`server-${server.id}`)}>{isEnglish ? "Open server" : "进入服务器"}</button><button className="text-button" type="button" onClick={() => onSelect(`server-${server.id}`)}>{isEnglish ? "Details" : "详情"}</button></div></article>)}</section>}
    </div>
  );
}

function LegacyServerManagerPage({ language, servers, onSelect, model = DEFAULT_MODEL }: { language: Language; servers: ServerSummary[]; onSelect: (id: string) => void; model?: ModelPreferences }) {
  const isEnglish = language === "en";
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [busy, setBusy] = React.useState(false);
  const [activeModel, setActiveModel] = React.useState<ModelPreferences>(model);
  const server = servers[0];
  const recordedMessages = React.useRef(0);
  React.useEffect(() => {
    if (!server) return;
    void readPortableJson<ActivityRecord[]>(ACTIVITY_FILE, []).then((saved) => {
      const restored = (Array.isArray(saved) ? saved : [])
        .filter((record) => record.category === "ai" && record.title === `服务器总管 · ${server.name}`)
        .reverse()
        .map((record) => {
          const separator = record.detail.indexOf(": ");
          const role = record.detail.startsWith("AI: ") ? "assistant" : "user";
          return { role: role as "user" | "assistant", text: separator >= 0 ? record.detail.slice(separator + 2) : record.detail };
        });
      recordedMessages.current = restored.length;
      setMessages(restored);
    });
  }, [server?.id]);
  React.useEffect(() => { void readPortableJson<Partial<ModelPreferences>>(MODEL_FILE, {}).then((saved) => setActiveModel({ ...DEFAULT_MODEL, ...saved })); }, []);
  React.useEffect(() => {
    if (messages.length <= recordedMessages.current) return;
    const latest = messages[messages.length - 1];
    recordedMessages.current = messages.length;
    if (latest && server) void appendActivity({ category: "ai", title: `服务器总管 · ${server.name}`, detail: `${latest.role === "user" ? "用户" : "AI"}: ${latest.text}` }).catch(() => undefined);
  }, [messages, server]);
  const send = async () => { const prompt = input.trim(); if (!prompt || busy || !server || !activeModel.baseUrl.trim() || !activeModel.model.trim()) return; setInput(""); setMessages((items) => [...items, { role: "user", text: prompt }]); setBusy(true); try { const response = await invoke<string>("chat_completion", { request: { baseUrl: activeModel.baseUrl, apiKey: activeModel.apiKey, model: activeModel.model, system: `你是 OpsNest 服务器总管。当前服务器：${server.name}，地址：${server.host}:${server.port}。只回答服务器管理、诊断和操作建议，不要声称已经执行命令。`, prompt } }); setMessages((items) => [...items, { role: "assistant", text: response }]); } catch (error) { setMessages((items) => [...items, { role: "assistant", text: `AI 请求失败：${String(error)}` }]); } finally { setBusy(false); } };
  return <div className="manager-chat-page"><div className="manager-chat-toolbar"><strong>服务器总管</strong><span>···</span></div><div className="manager-chat-body">{messages.length === 0 ? <div className="manager-chat-empty"><h1>{server ? "我们处理什么服务器问题？" : "先添加一台服务器"}</h1><p>{server ? "询问状态、资源、服务或故障诊断建议。" : "添加服务器后，服务器总管会在这里开始对话。"}</p>{server && <button className="secondary" type="button" onClick={() => onSelect(`server-${server.id}`)}>查看服务器主页</button>}</div> : <div className="manager-chat-messages">{messages.map((message, index) => <div className={`manager-chat-message ${message.role}`} key={`${message.role}-${index}`}>{message.text}</div>)}{busy && <div className="manager-chat-thinking">正在分析…</div>}</div>}</div><div className="manager-chat-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey) { event.preventDefault(); void send(); } }} placeholder={server ? "询问这台服务器…" : "请先添加服务器"} rows={2} disabled={!server || busy} /><button className="primary" type="button" onClick={() => void send()} disabled={!server || busy || !input.trim()}>发送</button></div></div>;
}

function ToolServerManagerPage({ language, servers, onSelect, model = DEFAULT_MODEL }: { language: Language; servers: ServerSummary[]; onSelect: (id: string) => void; model?: ModelPreferences }) {
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<Array<{ role: "user" | "assistant" | "tool"; text: string; toolCallId?: string }>>([]);
  const [busy, setBusy] = React.useState(false);
  const [activeModel, setActiveModel] = React.useState<ModelPreferences>(model);
  const server = servers[0];
  React.useEffect(() => { void readPortableJson<Partial<ModelPreferences>>(MODEL_FILE, {}).then((saved) => setActiveModel({ ...DEFAULT_MODEL, ...saved })); }, []);
  React.useEffect(() => {
    if (!server) return;
    void readPortableJson<ActivityRecord[]>(ACTIVITY_FILE, []).then((saved) => {
      const restored = (Array.isArray(saved) ? saved : [])
        .filter((record) => record.category === "ai" && record.title === `服务器总管 · ${server.name}`)
        .reverse()
        .map((record) => ({ role: record.detail.startsWith("用户: ") ? "user" as const : "assistant" as const, text: record.detail.replace(/^(用户|AI):\s*/, "") }));
      setMessages(restored);
    });
  }, [server?.id]);
  const send = async () => {
    const prompt = input.trim();
    if (!prompt || busy || !server || !activeModel.baseUrl.trim() || !activeModel.model.trim()) return;
    setInput(""); setBusy(true); const next = [...messages, { role: "user" as const, text: prompt }]; setMessages(next); void appendActivity({ category: "ai", title: `服务器总管 · ${server.name}`, detail: `用户: ${prompt}` }).catch(() => undefined);
    const apiMessages: Array<Record<string, unknown>> = [{ role: "system", content: `你是 OpsNest 服务器总管。当前服务器：${server.name}，地址：${server.host}:${server.port}。你可以读取或修改 OpsNest 白名单配置文件。修改前必须说明文件和内容并等待用户确认。` }, ...next.map((item) => ({ role: item.role, content: item.text }))];
    const tools = [{ type: "function", function: { name: "read_opsnest_config", description: "读取 OpsNest 白名单内的 JSON 配置文件。", parameters: { type: "object", properties: { file_name: { type: "string", enum: ["appearance.json", "model.json", "servers.json", "debug.json", "layout.json"] } }, required: ["file_name"] } } }, { type: "function", function: { name: "write_opsnest_config", description: "修改 OpsNest 白名单内的 JSON 配置文件。写入前必须获得用户确认。", parameters: { type: "object", properties: { file_name: { type: "string" }, content: { type: "string" } }, required: ["file_name", "content"] } } }];
     const configTools = [
       { type: "function", function: { name: "read_opsnest_config", description: "Read an allowed OpsNest JSON configuration file.", parameters: { type: "object", properties: { file_name: { type: "string", enum: ["appearance.json", "model.json", "servers.json", "debug.json", "layout.json"] } }, required: ["file_name"] } } },
       { type: "function", function: { name: "write_opsnest_config", description: "Write an allowed OpsNest JSON configuration file after explicit approval.", parameters: { type: "object", properties: { file_name: { type: "string" }, content: { type: "string" } }, required: ["file_name", "content"] } } },
     ];
     const allTools = [...tools, ...configTools];
     try {
      for (let round = 0; round < 4; round += 1) {
        const raw = await invoke<string>("chat_completion_with_tools", { request: { baseUrl: activeModel.baseUrl, apiKey: activeModel.apiKey, model: activeModel.model, messages: apiMessages, tools: allTools, toolChoice: "auto" } });
        const payload = JSON.parse(raw) as { choices?: Array<{ message?: { role?: string; content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
        const message = payload.choices?.[0]?.message;
        if (!message) throw new Error("AI 响应缺少消息");
        if (!message.tool_calls?.length) { const answer = message.content?.trim() || "AI 未返回文字内容。"; setMessages((items) => [...items, { role: "assistant", text: answer }]); void appendActivity({ category: "ai", title: `服务器总管 · ${server.name}`, detail: `AI: ${answer}` }).catch(() => undefined); break; }
        apiMessages.push(message as unknown as Record<string, unknown>);
        for (const call of message.tool_calls) {
          const name = call.function?.name || ""; const args = JSON.parse(call.function?.arguments || "{}"); let result = "";
          if (name === "read_opsnest_config") { result = (await invoke<string | null>("read_opsnest_config", { fileName: args.file_name })) || "配置文件不存在。"; }
          else if (name === "write_opsnest_config") { const approved = window.confirm(`AI 请求修改配置文件：${args.file_name}\n\n确认写入吗？写入前会自动备份。`); result = approved ? await invoke<string>("write_opsnest_config", { fileName: args.file_name, content: args.content, approved: true }).then(() => "配置已写入并完成备份。") : "用户拒绝了配置修改。"; }
          else result = "未允许的工具。";
          apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: result });
        }
      }
    } catch (error) { const text = `AI 工具调用失败：${String(error)}`; setMessages((items) => [...items, { role: "assistant", text }]); }
    finally { setBusy(false); }
  };
  return <div className="manager-chat-page"><div className="manager-chat-body">{messages.length === 0 ? <div className="manager-chat-empty"><h1>{server ? "我们处理什么服务器问题？" : "先添加一台服务器"}</h1><p>{server ? "可以询问服务器，也可以让 AI 读取或修改 OpsNest 配置。" : "添加服务器后，服务器总管会在这里开始对话。"}</p>{server && <button className="secondary" type="button" onClick={() => onSelect(`server-${server.id}`)}>查看服务器主页</button>}</div> : <div className="manager-chat-messages">{messages.filter((item) => item.role !== "tool").map((message, index) => <div className={`manager-chat-message ${message.role}`} key={`${message.role}-${index}`}>{message.text}</div>)}{busy && <div className="manager-chat-thinking">正在分析并调用工具…</div>}</div>}</div><div className="manager-chat-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey) { event.preventDefault(); void send(); } }} placeholder={server ? "询问服务器或配置…" : "请先添加服务器"} rows={2} disabled={!server || busy} /><button className="primary" type="button" onClick={() => void send()} disabled={!server || busy || !input.trim()}>发送</button></div></div>;
}

const UnusedToolServerManagerPage = ToolServerManagerPage;

function ManagerAvatar() {
  return <img className="manager-avatar" src="/avatars/opsnest-manager-owl.png" alt="服务器总管" />;
}

function ServerManagerPage({ language, servers, onSelect, onConfigureModel, onServerAdded, debugLogging = false, model = DEFAULT_MODEL }: { language: Language; servers: ServerSummary[]; onSelect: (id: string) => void; onConfigureModel: () => void; onServerAdded: (server: ServerSummary) => Promise<void> | void; debugLogging?: boolean; model?: ModelPreferences }) {
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<ManagerChatMessage[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [thinkingStatus, setThinkingStatus] = React.useState("正在思考…");
  const [activeModel, setActiveModel] = React.useState<ModelPreferences>(model);
  const [serverDraft, setServerDraft] = React.useState<{ name: string; host: string; port: number; username: string; authMethod: "password" | "key" } | null>(null);
  const [draftPassword, setDraftPassword] = React.useState("");
  const [draftStatus, setDraftStatus] = React.useState<string | null>(null);
  const [draftTesting, setDraftTesting] = React.useState(false);
  const [draftTested, setDraftTested] = React.useState(false);
  const [draftSaving, setDraftSaving] = React.useState(false);
  const [securityNotice, setSecurityNotice] = React.useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = React.useState<{ kind: "command" | "config"; title: string; detail: string; resolve: (approved: boolean) => void } | null>(null);
  const managerChatHydrated = React.useRef(false);
  const server = servers[0];
  React.useEffect(() => { void readPortableJson<Partial<ModelPreferences>>(MODEL_FILE, {}).then((saved) => setActiveModel({ ...DEFAULT_MODEL, ...saved })); }, []);
  React.useEffect(() => {
    void readPortableJson<ManagerChatMessage[] | null>(MANAGER_CHAT_FILE, null).then(async (savedChat) => {
      if (Array.isArray(savedChat)) {
        setMessages(savedChat.filter((item) => (item?.role === "user" || item?.role === "assistant") && typeof item.text === "string"));
        managerChatHydrated.current = true;
        return;
      }
      // One-time fallback for conversations recorded by pre-snapshot builds.
      const saved = await readPortableJson<ActivityRecord[]>(ACTIVITY_FILE, []);
      const records = Array.isArray(saved) ? saved : [];
      const scrubbed = records.map((record) => ({ ...record, detail: sanitizeSensitiveText(record.detail) }));
      if (scrubbed.some((record, index) => record.detail !== records[index]?.detail)) void writePortableJson(ACTIVITY_FILE, scrubbed).catch(() => undefined);
      const restored = scrubbed.filter((record) => record.category === "ai" && (record.title === "服务器总管" || record.title.startsWith("服务器总管 · "))).reverse().map((record) => ({ role: record.detail.startsWith("用户: ") ? "user" as const : "assistant" as const, text: record.detail.replace(/^(用户|AI):\s*/, "") }));
      setMessages(restored);
      managerChatHydrated.current = true;
      if (restored.length) void persistManagerChat(restored);
    });
  }, []);
  React.useEffect(() => {
    if (managerChatHydrated.current) void persistManagerChat(messages);
  }, [messages]);
  const aiConfigured = Boolean(activeModel.baseUrl.trim() && activeModel.model.trim());
  const requestApproval = (approval: Omit<NonNullable<typeof pendingApproval>, "resolve">) => new Promise<boolean>((resolve) => setPendingApproval({ ...approval, resolve }));
  const finishApproval = (approved: boolean) => { const pending = pendingApproval; setPendingApproval(null); pending?.resolve(approved); };
  const send = async () => {
    const rawPrompt = input.trim();
    const prompt = sanitizeSensitiveText(rawPrompt);
    if (!prompt || busy || !activeModel.baseUrl.trim() || !activeModel.model.trim()) return;
    if (rawPrompt !== prompt) setSecurityNotice("检测到疑似明文密码，已自动阻止其发送给模型。下次请使用下方专用密码输入区；密码泄露给模型，尤其是第三方中转接口，存在严重安全风险。");
    setInput(""); setBusy(true); setThinkingStatus("正在思考…");
    const next = [...messages, { role: "user" as const, text: prompt }]; setMessages(next);
    void appendActivity({ category: "ai", title: `服务器总管${server ? ` · ${server.name}` : ""}`, detail: `用户: ${prompt}` }).catch(() => undefined);
    const apiMessages: Array<Record<string, unknown>> = [{ role: "system", content: `你是 OpsNest 服务器总管，负责帮助用户管理服务器和 OpsNest。${servers.length ? "你可以检查和管理已保存的服务器。执行服务器命令前必须调用 request_server_command，并等待用户确认。" : "当前还没有保存的服务器。请主动收集服务器名称、地址、端口和用户名；信息齐全后调用 prepare_server_addition，让前端安全完成密码输入、连接测试和保存。当前添加流程使用 SSH 密码认证。"} 密码永远由前端安全输入，不要索取、复述或写入聊天、日志、模型上下文或 JSON。若用户在对话中直接写出疑似明文密码，必须提醒：“下次您不需要在对话中直接写上密码，OpsNest 会提供专用的密码输入界面；明文密码泄露给模型，特别是第三方中转类模型接口，会有严重安全风险。” 同时继续使用脱敏后的内容，不要引用或重复密码。只有连接测试成功且用户确认后，才能说服务器已添加。普通聊天、感谢和确认直接自然回答，不要用固定关键词分类。服务器列表：${servers.map((item) => `${item.id}=${item.name} (${item.host}:${item.port})`).join("；") || "（暂无）"}` }, ...next.map((item) => ({ role: item.role, content: item.text }))];
    const tools: Array<Record<string, unknown>> = [{ type: "function", function: { name: "prepare_server_addition", description: "当用户提供了添加服务器所需的非敏感信息后，准备服务器草稿。当前使用密码认证，绝不包含密码。", parameters: { type: "object", properties: { name: { type: "string" }, host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 }, username: { type: "string" }, auth_method: { type: "string", enum: ["password"] } }, required: ["name", "host", "port", "username", "auth_method"] } } }];
    if (servers.length) tools.push({ type: "function", function: { name: "request_server_command", description: "为服务器规划一个需要用户确认的命令，并可附带执行后的验证命令。", parameters: { type: "object", properties: { server_id: { type: "string", enum: servers.map((item) => item.id) }, command: { type: "string" }, explain: { type: "string" }, verify_command: { type: "string" }, risk: { type: "string", enum: ["low", "medium", "high"] } }, required: ["server_id", "command", "explain", "risk"] } } });
    try {
      const configTools = [
        { type: "function", function: { name: "read_opsnest_config", description: "Read an allowed OpsNest JSON configuration file.", parameters: { type: "object", properties: { file_name: { type: "string", enum: ["appearance.json", "model.json", "servers.json", "debug.json", "layout.json"] } }, required: ["file_name"] } } },
        { type: "function", function: { name: "write_opsnest_config", description: "Write an allowed OpsNest JSON configuration file after explicit approval.", parameters: { type: "object", properties: { file_name: { type: "string" }, content: { type: "string" } }, required: ["file_name", "content"] } } },
      ];
      const allTools = [...tools, ...configTools];
      for (let round = 0; round < 6; round += 1) {
        const requestStarted = performance.now();
        if (debugLogging) void writeDebugLog("debug", "server manager model request started", { round: round + 1, model: activeModel.model, provider: activeModel.provider, hasServer: Boolean(server), serverCount: servers.length });
        const raw = await invoke<string>("chat_completion_with_tools", { request: { baseUrl: activeModel.baseUrl, apiKey: activeModel.apiKey, model: activeModel.model, messages: apiMessages, tools: allTools, toolChoice: "auto" } });
        const payload = JSON.parse(raw) as { choices?: Array<{ message?: { role?: string; content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
        const message = payload.choices?.[0]?.message; if (!message) throw new Error("AI 响应缺少消息");
        if (debugLogging) void writeDebugLog("debug", "server manager model response received", { round: round + 1, elapsedMs: Math.round(performance.now() - requestStarted), hasContent: Boolean(message.content?.trim()), toolCalls: message.tool_calls?.map((call) => call.function?.name || "unknown") || [] });
        if (!message.tool_calls?.length) { const answer = message.content?.trim() || "AI 未返回文字内容。"; setMessages((items) => [...items, { role: "assistant", text: answer }]); void appendActivity({ category: "ai", title: `服务器总管${server ? ` · ${server.name}` : ""}`, detail: `AI: ${answer}` }).catch(() => undefined); break; }
        setThinkingStatus("正在调用工具…");
        apiMessages.push(message as unknown as Record<string, unknown>);
        for (const call of message.tool_calls) {
          const name = call.function?.name || ""; const args = JSON.parse(call.function?.arguments || "{}");
          if (name === "prepare_server_addition") {
            const port = Number(args.port);
            if (!String(args.name || "").trim() || !String(args.host || "").trim() || !String(args.username || "").trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
              apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: "服务器信息不完整或端口无效，请继续向用户询问缺少的非敏感信息。" });
              continue;
            }
            const draft = { name: String(args.name).trim(), host: String(args.host).trim(), port, username: String(args.username).trim(), authMethod: args.auth_method === "key" ? "key" as const : "password" as const };
            setServerDraft(draft); setDraftPassword(""); setDraftTested(false); setDraftStatus("请在下方输入密码后测试连接。密码不会发送给 AI。");
            apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: "已准备服务器信息。请让用户在前端安全输入密码并测试连接；不要声称服务器已经保存。" });
            continue;
          }
          if (name === "read_opsnest_config") { const result = (await invoke<string | null>("read_opsnest_config", { fileName: String(args.file_name || "") })) || "Configuration file does not exist."; apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: result }); continue; }
          if (name === "write_opsnest_config") { const approved = await requestApproval({ kind: "config", title: "AI 请求修改 OpsNest 配置", detail: `文件：${String(args.file_name || "")}\n写入前会自动备份。` }); const result = approved ? await invoke<string>("write_opsnest_config", { fileName: String(args.file_name || ""), content: String(args.content || ""), approved: true }).then(() => "配置已写入并完成备份。") : "用户拒绝了配置修改。"; apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: result }); continue; }
          if (name !== "request_server_command") { apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: "Tool not allowed." }); continue; }
          const target = servers.find((item) => item.id === args.server_id) || server;
          if (!target) { apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: "当前没有可操作的服务器。" }); continue; }
          const command = String(args.command || "").trim();
          if (!command) { apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: "命令为空，无法执行。" }); continue; }
          const approved = isRiskyShellCommand(command) ? await requestApproval({ kind: "command", title: `AI 请求在“${target.name}”上执行命令`, detail: `$ ${command}\n\n${String(args.explain || "")}` }) : true;
          if (!approved) { apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: "用户拒绝执行。" }); continue; }
          const at = target.host.indexOf("@"); const username = at > 0 ? target.host.slice(0, at) : "root"; const host = at > 0 ? target.host.slice(at + 1) : target.host;
          const request = { host, port: target.port, username, authMethod: target.authMethod ?? "password", password: target.password ?? null, privateKeyPath: null, passphrase: null };
          let result = ""; let sessionId = "";
          try {
            const opened = await invoke<{ sessionId: string }>("open_ssh_session", { request }); sessionId = opened.sessionId;
            result = await invoke<string>("execute_ssh_command", { sessionId, command, approved: true });
            if (args.verify_command) { const verification = await invoke<string>("execute_ssh_command", { sessionId, command: String(args.verify_command), approved: true }); result += `\n\n[验证]\n${verification}`; }
          } catch (error) { result = `Command failed: ${String(error)}`; }
          finally { if (sessionId) await invoke("close_ssh_session", { sessionId }).catch(() => undefined); }
          void appendActivity({ category: "task", title: `服务器总管 · ${target.name}`, detail: `$ ${command}\n${result}` }).catch(() => undefined);
          apiMessages.push({ role: "tool", tool_call_id: call.id || "opsnest-tool", content: result || "命令已执行但没有输出。" });
        }
      }
    } catch (error) { const text = `服务器命令执行失败：${String(error)}`; setMessages((items) => [...items, { role: "assistant", text }]); void appendActivity({ category: "task", title: `服务器总管${server ? ` · ${server.name}` : ""}`, detail: text }).catch(() => undefined); }
    finally { setBusy(false); setThinkingStatus("正在思考…"); }
  };
  const testDraft = async () => {
    if (!serverDraft || !draftPassword || draftTesting) return;
    setDraftTesting(true); setDraftStatus("正在测试 SSH 连接…"); setDraftTested(false);
    let sessionId = "";
    try {
      const opened = await invoke<{ sessionId: string }>("open_ssh_session", { request: { host: serverDraft.host, port: serverDraft.port, username: serverDraft.username, authMethod: serverDraft.authMethod, password: serverDraft.authMethod === "password" ? draftPassword : null, privateKeyPath: null, passphrase: null } });
      sessionId = opened.sessionId; setDraftTested(true); setDraftStatus("连接成功。确认后将保存服务器，密码只保存到系统凭据管理器。");
    } catch (error) { setDraftStatus(`连接失败：${String(error)}`); }
    finally { if (sessionId) await invoke("close_ssh_session", { sessionId }).catch(() => undefined); setDraftTesting(false); }
  };
  const saveDraft = async () => {
    if (!serverDraft || !draftTested || draftSaving) return;
    setDraftSaving(true); setDraftStatus("正在保存服务器…");
    try {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await onServerAdded({ id, name: serverDraft.name, host: `${serverDraft.username}@${serverDraft.host}`, port: serverDraft.port, authMethod: serverDraft.authMethod, password: serverDraft.authMethod === "password" ? draftPassword : undefined, connected: true });
      const completionMessage = `服务器“${serverDraft.name}”添加完成了。\n\n我们处理什么服务器问题？您可以询问服务器，也可以让 AI 检查或管理已保存的服务器。`;
      setMessages((items) => [...items, { role: "assistant", text: completionMessage }]);
      void appendActivity({ category: "ai", title: `服务器总管 · ${serverDraft.name}`, detail: `AI: ${completionMessage}` }).catch(() => undefined);
      setServerDraft(null); setDraftPassword(""); setDraftStatus(null); setDraftTested(false);
    } catch (error) { setDraftStatus(`保存失败：${String(error)}`); }
    finally { setDraftSaving(false); }
  };
  return <div className="manager-chat-page"><div className="manager-chat-body">{securityNotice && <div className="manager-security-notice" role="alert"><span>{securityNotice}</span><button type="button" onClick={() => setSecurityNotice(null)}>×</button></div>}{messages.length === 0 ? <div className="manager-chat-empty"><h1>{!aiConfigured ? "请先添加一个 AI 模型" : server ? "我们处理什么服务器问题？" : "服务器总管已就绪"}</h1><p>{!aiConfigured ? "请添加一个 AI 模型，我才能帮您管理您的服务器。" : server ? "可以询问服务器，也可以让 AI 检查或管理已保存的服务器。" : "当前还没有服务器，可以直接告诉我你要添加的服务器信息。"}</p>{!aiConfigured ? <button className="secondary" type="button" onClick={onConfigureModel}>配置 AI 模型</button> : server && <button className="secondary" type="button" onClick={() => onSelect(`server-${server.id}`)}>查看服务器主页</button>}</div> : <div className="manager-chat-messages">{messages.map((message, index) => <div className={`manager-chat-message ${message.role}`} key={`${message.role}-${index}`}>{message.role === "assistant" && <ManagerAvatar />}<div>{message.text}</div></div>)}{pendingApproval && <div className="manager-chat-approval"><strong>{pendingApproval.title}</strong><pre>{pendingApproval.detail}</pre><div><button className="secondary" type="button" onClick={() => finishApproval(false)}>取消</button><button className="primary" type="button" onClick={() => finishApproval(true)}>确认执行</button></div></div>}{busy && <div className="manager-chat-thinking">{thinkingStatus}</div>}</div>}</div>{serverDraft && <section className="manager-server-draft"><strong>添加服务器：{serverDraft.name}</strong><span>{serverDraft.username}@{serverDraft.host}:{serverDraft.port}</span><input type="password" value={draftPassword} onChange={(event) => { setDraftPassword(event.target.value); setDraftTested(false); }} placeholder="SSH 密码（不会发送给 AI）" disabled={draftTesting || draftTested || draftSaving} /><div className="manager-server-draft-actions"><button className="secondary" type="button" onClick={() => void testDraft()} disabled={!draftPassword || draftTesting || draftTested || draftSaving}>{draftTesting ? "测试中…" : "测试连接"}</button><button className="primary" type="button" onClick={() => void saveDraft()} disabled={!draftTested || draftSaving}>{draftSaving ? "保存中…" : "确认保存"}</button></div>{draftStatus && <p>{draftStatus}</p>}</section>}<div className="manager-chat-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey) { event.preventDefault(); void send(); } }} placeholder={!aiConfigured ? "请先配置 AI 模型" : server ? "询问服务器或配置…" : "告诉我你要添加的服务器…"} rows={2} disabled={!aiConfigured || busy || Boolean(serverDraft && !draftTested)} /><button className="primary" type="button" onClick={() => void send()} disabled={!aiConfigured || busy || !input.trim() || Boolean(serverDraft && !draftTested)}>发送</button></div></div>;
}

function FeaturePage({ title, description }: { title: string; description: string }) {
  if (!title.trim()) return <div className="feature-page feature-page-empty" aria-hidden="true" />;
  return <div className="feature-page"><div className="settings-eyebrow">OpsNest</div><h1>{title}</h1><div className="feature-empty"><strong>{title}</strong><span>{description}</span></div></div>;
}

function TaskHistoryPage() {
  return <TaskHistoryView />;
  return <div className="feature-page"><div className="settings-eyebrow">OpsNest</div><h1>日志与任务</h1><p className="feature-intro">分类查看操作记录、软件运行日志和 AI 对话。</p><div className="history-tabs"><button className="is-active" type="button">任务记录 <span>0</span></button><button type="button">软件运行日志 <span>0</span></button><button type="button">AI 对话日志 <span>0</span></button></div><div className="feature-empty"><strong>暂无记录</strong><span>完成服务器操作或 AI 对话后，记录会显示在这里。</span></div></div>;
}

function TaskHistoryView() {
  const [records, setRecords] = React.useState<ActivityRecord[]>([]);
  const [debugLog, setDebugLog] = React.useState("");
  const [tab, setTab] = React.useState<"task" | "runtime" | "ai">("task");
  const [loading, setLoading] = React.useState(false);
  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const saved = await readPortableJson<ActivityRecord[]>(ACTIVITY_FILE, []);
      setRecords(Array.isArray(saved) ? saved : []);
      const log = await invoke<string>("read_debug_log");
      setDebugLog(log || "");
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const tasks = records.filter((record) => record.category === "task");
  const conversations = records.filter((record) => record.category === "ai");
  const runtimeLines = debugLog.split(/\r?\n/).filter((line) => line.trim());
  const clearCurrent = async () => {
    if (!window.confirm(tab === "runtime" ? "清空软件运行日志？" : "清空当前记录？")) return;
    if (tab === "runtime") await invoke("clear_debug_log");
    else await writePortableJson(ACTIVITY_FILE, records.filter((record) => tab === "task" ? record.category !== "task" : record.category !== "ai"));
    await load();
  };
  const currentRecords = tab === "task" ? tasks : conversations;
  return <div className="feature-page history-page"><div className="history-page-header"><div><div className="settings-eyebrow">OpsNest</div><h1>日志与任务</h1><p className="feature-intro">分开查看操作记录、软件运行日志和 AI 对话。</p></div><div className="history-actions"><button className="secondary" type="button" onClick={() => void load()} disabled={loading}>刷新</button><button className="secondary" type="button" onClick={() => void clearCurrent()}>清空当前记录</button></div></div><div className="history-tabs"><button className={tab === "task" ? "is-active" : ""} type="button" onClick={() => setTab("task")}>任务记录 <span>{tasks.length}</span></button><button className={tab === "runtime" ? "is-active" : ""} type="button" onClick={() => setTab("runtime")}>软件运行日志 <span>{runtimeLines.length}</span></button><button className={tab === "ai" ? "is-active" : ""} type="button" onClick={() => setTab("ai")}>AI 对话日志 <span>{conversations.length}</span></button></div>{tab === "runtime" ? (runtimeLines.length ? <div className="history-list">{runtimeLines.map((line, index) => <article className="history-entry history-entry-runtime" key={`${index}-${line}`}><p>{line}</p></article>)}</div> : <div className="feature-empty"><strong>暂无运行日志</strong><span>开启调试日志后，软件运行状态会记录在 data/opsnest-debug.log。</span></div>) : currentRecords.length ? <div className="history-list">{currentRecords.map((record) => <article className={`history-entry history-entry-${record.category}`} key={record.id}><div className="history-entry-heading"><strong>{record.title}</strong><time>{new Date(record.timestamp).toLocaleString()}</time></div><p>{record.detail}</p></article>)}</div> : <div className="feature-empty"><strong>暂无记录</strong><span>{tab === "ai" ? "完成服务器总管或 AI-SSH 对话后，记录会显示在这里。" : "完成服务器操作后，记录会显示在这里。"}</span></div>}</div>;
}

function ServerForm({ language, onSaved, initialServer }: { language: Language; onSaved: (server: ServerSummary) => void; initialServer?: ServerSummary }) {
  const isEnglish = language === "en";
  const isEditing = Boolean(initialServer);
  React.useEffect(() => {
    const page = document.querySelector<HTMLElement>(".server-form-page");
    const eyebrow = page?.querySelector<HTMLElement>(".settings-page-header .settings-eyebrow");
    const heading = page?.querySelector<HTMLElement>(".settings-page-header h1");
    if (eyebrow) eyebrow.textContent = isEditing ? (isEnglish ? "Server settings" : "服务器设置") : (isEnglish ? "Workspace setup" : "工作区设置");
    if (heading) heading.textContent = isEditing ? (isEnglish ? "Edit server" : "编辑服务器") : (isEnglish ? "Add a server" : "添加服务器");
  }, [isEditing, isEnglish]);
  const initialAt = initialServer?.host.indexOf("@") ?? -1;
  const [name, setName] = React.useState(initialServer?.name ?? "");
  const [host, setHost] = React.useState(initialAt > 0 ? initialServer!.host.slice(initialAt + 1) : initialServer?.host ?? "");
  const [port, setPort] = React.useState(String(initialServer?.port ?? 22));
  const [username, setUsername] = React.useState(initialAt > 0 ? initialServer!.host.slice(0, initialAt) : "root");
  const [password, setPassword] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const save = () => {
    if (!name.trim() || !host.trim()) { setMessage(isEnglish ? "Enter a server name and host." : "请填写服务器名称和地址。" ); return; }
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) { setMessage(isEnglish ? "Enter a valid port." : "请输入有效的端口。" ); return; }
    onSaved({ ...(initialServer ?? { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }), name: name.trim(), host: `${username.trim() || "root"}@${host.trim()}`, port: parsedPort, password: password || initialServer?.password, authMethod: password ? "password" : (initialServer?.authMethod ?? "password"), connected: false, cpu: undefined, memory: undefined, disk: undefined, docker: undefined });
  };
  return <div className="settings-page server-form-page"><div className="settings-page-header"><div><div className="settings-eyebrow">{isEnglish ? "Workspace setup" : "工作区设置"}</div><h1>{isEnglish ? "Add a server" : "添加服务器"}</h1></div></div><section className="settings-section settings-card server-form-card"><div className="settings-card-title"><strong>{isEnglish ? "Connection details" : "连接信息"}</strong><span>SSH</span></div><label className="model-field"><span>{isEnglish ? "Display name" : "显示名称"}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={isEnglish ? "e.g. Production" : "例如：生产服务器"} /></label><label className="model-field"><span>{isEnglish ? "Host or IP address" : "主机地址或 IP"}</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.10" /></label><div className="server-form-grid"><label className="model-field"><span>{isEnglish ? "Username" : "用户名"}</span><input value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className="model-field"><span>{isEnglish ? "SSH port" : "SSH 端口"}</span><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" /></label></div><label className="model-field"><span>{isEnglish ? "Password" : "密码"}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isEnglish ? "Used for the initial connection" : "用于首次连接"} /></label><p className="form-note">{isEnglish ? "The password is not written to the portable JSON file." : "密码不会写入便携版 JSON 存档。"}</p>{message && <p className="model-test-message is-error">{message}</p>}<div className="model-actions"><button className="secondary" type="button" onClick={() => setMessage(null)}>{isEnglish ? "Clear" : "清空"}</button><button className="primary" type="button" onClick={save}>{isEnglish ? "Save server" : "保存服务器"}</button></div></section></div>;
}

function LinuxServerHomeContent({ language, server, model, onScan, onOpenTerminal, onOpenFiles }: { language: Language; server: ServerSummary; model: ModelPreferences; onScan: () => void; onOpenTerminal: () => void; onOpenFiles: () => void }) {
  const isEnglish = language === "en";
  const value = (item?: string) => {
    const text = item || (isEnglish ? "Not scanned" : "未扫描");
    if (isEnglish) return text.replace(/\bnot\s+installed\b/gi, "Not installed");
    return text.replace(/\bnot\s+installed\b/gi, "未安装").replace(/\binstalled\b/gi, "已安装");
  };
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [thinking, setThinking] = React.useState(false);
  const Server = (_props: { size?: number }) => isAlibabaLabel(`${server.name} ${server.system || ""}`) ? <img className="service-icon-image system-alibaba" src="/icons/packed/systems/alibaba.png?v=3" alt="" aria-hidden="true" width={22} height={22} /> : <ServiceIcon kind="system" name={`${server.name} ${server.system || "linux"}`} />;
  const recordedHomeMessages = React.useRef(0);
  React.useEffect(() => {
    const banner = document.querySelector<HTMLElement>(".server-profile-banner");
    const primary = banner?.querySelector<HTMLButtonElement>("button:not(.server-profile-files-action)");
    if (!banner || !primary) return;
    const openTerminal = (event: Event) => { if (!server.connected) return; event.preventDefault(); event.stopPropagation(); onOpenTerminal(); };
    if (server.connected) primary.addEventListener("click", openTerminal, true);
    primary.classList.remove("primary"); primary.classList.add("secondary");
    const files = banner.querySelector<HTMLButtonElement>(".server-profile-files-action") ?? document.createElement("button");
    if (!files.parentElement) { files.type = "button"; files.className = "secondary server-profile-files-action"; files.textContent = isEnglish ? "Files" : "文件管理"; banner.appendChild(files); }
    files.onclick = () => onOpenFiles();
    return () => { if (server.connected) primary.removeEventListener("click", openTerminal, true); if (files.parentElement && files.classList.contains("server-profile-files-action")) files.remove(); };
  }, [server.id, server.connected, isEnglish, onOpenTerminal, onOpenFiles]);
  React.useEffect(() => {
    if (messages.length <= recordedHomeMessages.current) return;
    const latest = messages[messages.length - 1];
    recordedHomeMessages.current = messages.length;
    void appendActivity({ category: "ai", title: `服务器主页 · ${server.name}`, detail: `${latest.role === "user" ? "用户" : "AI"}: ${latest.text}` }).catch(() => undefined);
  }, [messages, server.name]);
  const submit = async () => { const prompt = input.trim(); if (!prompt || thinking) return; setInput(""); setMessages((items) => [...items, { role: "user", text: prompt }]); setThinking(true); try { const response = await invoke<string>("chat_completion", { request: { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model, system: `你是 OpsNest 的服务器总管。当前服务器：${server.name}，地址：${server.host}:${server.port}，系统：${value(server.system)}，CPU：${value(server.cpu)}，内存：${value(server.memory)}，磁盘：${value(server.disk)}，Docker：${value(server.docker)}。只给出诊断、解释和建议，不要声称已经执行任何命令。`, prompt } }); setMessages((items) => [...items, { role: "assistant", text: response }]); } catch (error) { setMessages((items) => [...items, { role: "assistant", text: `AI 请求失败：${String(error)}` }]); } finally { setThinking(false); } };
  return <div className="server-home-page"><header className="server-home-header"><div><div className="settings-eyebrow">{isEnglish ? "Linux server" : "Linux 服务器"}</div><h1>{server.name}</h1><p>{server.host}:{server.port}</p></div><span className={`home-status ${server.connected ? "is-connected" : ""}`}>● {server.connected ? (isEnglish ? "Connected" : "已连接") : (isEnglish ? "Not connected" : "未连接")}</span></header><section className="server-profile-banner"><div className="server-profile-icon"><Server size={22} /></div><div><strong>{isEnglish ? "General Linux server" : "通用 Linux 服务器"}</strong><span>{value(server.system || "Debian GNU/Linux")}</span></div><button className="primary" type="button" onClick={onScan}>{server.connected ? (isEnglish ? "Open terminal" : "打开终端") : (isEnglish ? "Scan server" : "扫描服务器")}</button></section><section className="server-home-section"><div className="server-home-section-heading"><div><span className="home-section-label">{isEnglish ? "Overview" : "服务器概览"}</span><h2>{isEnglish ? "System resources" : "系统资源"}</h2></div><button className="text-button" type="button" onClick={onScan}>{isEnglish ? "Scan again" : "重新扫描"}</button></div><div className="server-metric-grid"><div><span>CPU</span><strong>{value(server.cpu)}</strong></div><div><span>{isEnglish ? "Memory" : "内存"}</span><strong>{value(server.memory)}</strong></div><div><span>{isEnglish ? "System disk" : "系统盘"}</span><strong>{value(server.disk)}</strong></div><div><span>Docker</span><strong>{value(server.docker)}</strong></div></div></section><section className="server-home-section server-services-section"><div className="server-home-section-heading"><div><span className="home-section-label">{isEnglish ? "Services" : "服务"}</span><h2>{isEnglish ? "Common entry points" : "常用入口"}</h2></div></div><div className="server-service-empty"><strong>{isEnglish ? "Service discovery is not available yet" : "服务发现尚未完成"}</strong><span>{isEnglish ? "Connect and scan this Linux server to discover Docker, systemd, and web services." : "连接并扫描服务器后，这里会显示 Docker、systemd 和 Web 服务。"}</span></div></section><section className="server-home-section server-chat-section"><div className="server-home-section-heading"><div><span className="home-section-label">{isEnglish ? "Server manager" : "服务器总管"}</span><h2>{isEnglish ? "Ask about this server" : "询问这台服务器"}</h2></div></div><div className="server-chat-messages">{messages.length === 0 && <span>{isEnglish ? "Ask for an explanation or a read-only diagnosis." : "可以询问服务器状态，或请求只读诊断建议。"}</span>}{messages.map((message, index) => <p className={`server-chat-message ${message.role}`} key={`${message.role}-${index}`}><b>{message.role === "user" ? "你" : "AI"}</b>{message.text}</p>)}{thinking && <p className="server-chat-message assistant"><b>AI</b>正在分析…</p>}</div><div className="server-chat-input"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey) { event.preventDefault(); void submit(); } }} placeholder={isEnglish ? "Ask about this server…" : "询问这台服务器…"} rows={2} /><button className="primary" type="button" disabled={thinking || !input.trim()} onClick={() => void submit()}>发送</button></div></section></div>;
}

function AppearanceSettings({
  value,
  onChange,
}: {
  value: AppearancePreferences;
  onChange: (next: AppearancePreferences) => void;
}) {
  const isEnglish = value.language === "en";
  const update = <K extends keyof AppearancePreferences>(key: K, next: AppearancePreferences[K]) => {
    onChange({ ...value, [key]: next });
  };

  const themes: Array<[Theme, string]> = isEnglish
    ? [["system", "System"], ["light", "Light"], ["dark", "Dark"]]
    : [["system", "系统"], ["light", "浅色"], ["dark", "深色"]];

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <div>
          <div className="settings-eyebrow">{isEnglish ? "Settings" : "设置"}</div>
          <h1>{isEnglish ? "Appearance" : "外观"}</h1>
        </div>
      </div>

      <section className="settings-section">
        <h2>{isEnglish ? "Theme" : "主题"}</h2>
        <div className="theme-grid">
          {themes.map(([theme, label]) => (
            <button key={theme} className={`theme-card ${value.theme === theme ? "is-selected" : ""}`} onClick={() => update("theme", theme)}>
              <span className={`theme-preview theme-${theme}`}><i /><b /><em /></span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section settings-card">
        <div className="settings-card-title"><strong>{isEnglish ? "Interface" : "界面"}</strong><span>OpsNest Style</span></div>
        <SettingRow
          label={isEnglish ? "Language" : "语言"}
          description={isEnglish ? "Choose the display language" : "选择界面显示语言"}
        >
          <select aria-label={isEnglish ? "Language" : "语言"} value={value.language} onChange={(event) => update("language", event.target.value as Language)}>
            <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </SettingRow>
        <SettingRow
          label={isEnglish ? "Close button action" : "关闭按钮动作"}
          description={isEnglish ? "Choose whether closing hides the app in the tray or exits" : "选择关闭窗口时隐藏到系统托盘或直接退出"}
        >
          <select aria-label={isEnglish ? "Close button action" : "关闭按钮动作"} value={value.closeAction} onChange={(event) => update("closeAction", event.target.value as CloseAction)}>
            <option value="tray">{isEnglish ? "Minimize to tray" : "最小化到托盘"}</option>
            <option value="exit">{isEnglish ? "Exit application" : "直接退出"}</option>
          </select>
        </SettingRow>
        {false && <SettingRow
          label={isEnglish ? "Show menu bar" : "显示菜单栏"}
          description={isEnglish ? "Show the placeholder menus at the top" : "显示顶部的占位菜单"}
        >
          <Toggle checked={value.showMenuBar} onChange={(next) => update("showMenuBar", next)} label={isEnglish ? "Show menu bar" : "显示菜单栏"} />
        </SettingRow>}
        <SettingRow
          label={isEnglish ? "Translucent sidebar" : "半透明侧边栏"}
          description={isEnglish ? "Blend the sidebar softly with the window background" : "让左侧栏与窗口背景产生轻微的透明融合效果"}
        >
          <Toggle checked={value.translucentSidebar} onChange={(next) => update("translucentSidebar", next)} label={isEnglish ? "Translucent sidebar" : "半透明侧边栏"} />
        </SettingRow>
        <SettingRow
          label={isEnglish ? "Reduce motion" : "减少动态效果"}
          description={isEnglish ? "Reduce panel opening, closing, and switching animations" : "减少面板展开、收起和切换时的动画"}
        >
          <Toggle checked={value.reduceMotion} onChange={(next) => update("reduceMotion", next)} label={isEnglish ? "Reduce motion" : "减少动态效果"} />
        </SettingRow>
        <SettingRow
          label={isEnglish ? "Interface font size" : "界面字号"}
          description={isEnglish ? "Adjust the base size of menus and interface text" : "调整菜单与界面文字的基础字号"}
        >
          <select aria-label={isEnglish ? "Interface font size" : "界面字号"} value={value.uiSize} onChange={(event) => update("uiSize", Number(event.target.value))}>
            <option value={13}>13 px</option>
            <option value={14}>14 px</option>
            <option value={15}>15 px</option>
          </select>
        </SettingRow>
        <SettingRow
          label={isEnglish ? "Debug logging" : "调试日志"}
          description={isEnglish ? "Write detailed runtime information to data/opsnest-debug.log" : "记录详细运行信息到 data/opsnest-debug.log"}
        >
          <Toggle checked={value.debugLogging} onChange={(next) => update("debugLogging", next)} label={isEnglish ? "Debug logging" : "调试日志"} />
        </SettingRow>
      </section>
    </div>
  );
}

function ModelSettings({ value, onChange }: { value: ModelPreferences; onChange: (next: ModelPreferences) => void }) {
  const update = <K extends keyof ModelPreferences>(key: K, next: ModelPreferences[K]) => onChange({ ...value, [key]: next });
  const [testing, setTesting] = React.useState(false);
  const [testMessage, setTestMessage] = React.useState<string | null>(null);
  const testConnection = async () => {
    setTesting(true);
    setTestMessage(null);
    try {
      const result = await invoke<string>("test_model_connection", { baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.model });
      setTestMessage(result);
    } catch (error) {
      setTestMessage(String(error));
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="settings-page">
      <div className="settings-page-header"><div><div className="settings-eyebrow">设置</div><h1>AI 模型</h1></div></div>
      <section className="settings-section settings-card model-settings-card">
        <div className="settings-card-title"><strong>添加一个 AI 模型</strong></div>
        <p className="settings-intro">模型只负责理解你的描述和服务器状态，SSH 操作仍由本地安全流程控制。</p>
        <label className="model-field"><span>模型服务</span><select value={value.provider} onChange={(event) => update("provider", event.target.value as ModelPreferences["provider"])}><option value="custom">Custom endpoint</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="ollama">Ollama</option></select></label>
        <label className="model-field"><span>API 地址</span><input value={value.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label className="model-field"><span>API Key</span><input type="password" value={value.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder="输入 API Key" /></label>
        <label className="model-field"><span>模型名称（暂不支持添加多个模型）</span><input value={value.model} onChange={(event) => update("model", event.target.value)} placeholder="例如：gpt-4o-mini" /></label>
        <div className="model-actions"><button className="secondary" type="button" onClick={() => undefined}>测试连接</button><button className="primary" type="button" onClick={() => undefined}>保存模型</button></div>
      </section>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)} aria-label={label} aria-pressed={checked}><span /></button>;
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><small>{description}</small></div>{children}</div>;
}

function DockerServiceCard({ server }: { server: ServerSummary }) {
  const containers = (server.services ?? []).filter((service) => service.kind.toLowerCase() === "docker");
  const dockerState = server.docker || "尚未扫描";
  const dockerUnavailable = /(?:not\s+installed|未安装)/i.test(dockerState);
  if (dockerUnavailable) return null;
  return <section className="docker-service-card" aria-label="Docker">
    <div className="docker-service-heading">
      <div className="docker-service-title"><span className="docker-service-icon"><Container size={20} /></span><div><span className="home-section-label">容器</span><h2>Docker</h2></div></div>
      <span className={`docker-service-status ${dockerState.includes("未安装") ? "is-off" : ""}`}>{dockerState.replace(/\bnot\s+installed\b/gi, "未安装").replace(/\binstalled\b/gi, "已安装")}</span>
    </div>
    {containers.length > 0 ? <div className="docker-container-list">{containers.map((container) => <div className="docker-container-row" key={container.id}><Container size={15} /><div><strong>{container.name}</strong><span>{container.status}{container.version ? ` · ${container.version}` : ""}</span></div></div>)}</div> : <div className="docker-service-empty"><strong>暂无运行中的容器</strong><span>扫描 Docker 后，运行中的容器会显示在这里。</span></div>}
  </section>;
}

function LinuxServerHome({ language, server, model, onScan, onOpenTerminal, onOpenFiles, onServicesUpdated }: { language: Language; server: ServerSummary; model: ModelPreferences; onScan: () => void; onOpenTerminal: () => void; onOpenFiles: () => void; onServicesUpdated: (services: DiscoveredServiceSummary[]) => void }) {
  return <div className="server-home-center"><LinuxServerHomeContent language={language} server={server} model={model} onScan={onScan} onOpenTerminal={onOpenTerminal} onOpenFiles={onOpenFiles} /><WebServiceDiscoveryPanel server={server} onServicesUpdated={onServicesUpdated} /></div>;
}

function ServerTerminalPanel({ server, model }: { server: ServerSummary; model: ModelPreferences }) {
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [command, setCommand] = React.useState("");
  const [output, setOutput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = React.useState<string | null>(null);
  const [aiInput, setAiInput] = React.useState("");
  const [aiReply, setAiReply] = React.useState("");
  const [aiBusy, setAiBusy] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    const at = server.host.indexOf("@");
    const username = at > 0 ? server.host.slice(0, at) : "root";
    const host = at > 0 ? server.host.slice(at + 1) : server.host;
    void invoke<{ sessionId: string }>("open_ssh_session", { request: { host, port: server.port, username, authMethod: server.authMethod ?? "password", password: server.password ?? null, privateKeyPath: null, passphrase: null } })
      .then((result) => { if (active) setSessionId(result.sessionId); })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; setSessionId((current) => { if (current) void invoke("close_ssh_session", { sessionId: current }); return null; }); };
  }, [server.id]);
  const run = async () => {
    if (!sessionId || !command.trim() || busy) return;
    const next = command.trim();
    const approving = pendingCommand !== null && next.toLowerCase() === "approve";
    const risky = /(^|\s)(sudo|rm|mv|cp|chmod|chown|systemctl|service|reboot|shutdown|docker\s+(rm|stop|restart)|apt(-get)?\s+(install|remove|purge|upgrade)|dnf\s+(install|remove|upgrade)|yum\s+(install|remove|update))/i.test(next);
    if (pendingCommand === null && risky) {
      setPendingCommand(next);
      setCommand("");
      if (window.confirm(`即将执行可能改变服务器状态的命令：\n\n${next}\n\n点击“确定”执行，或在终端输入 approve。`)) { setCommand(next); setPendingCommand(next); window.setTimeout(() => void run(), 0); }
      return;
    }
    if (pendingCommand !== null && !approving && next !== pendingCommand) return;
    const executeCommand = pendingCommand ?? next;
    setPendingCommand(null); setCommand(""); setBusy(true); setError(null); setOutput((value) => `${value}$ ${executeCommand}\n`);
    try { const result = await invoke<string>("execute_ssh_command", { sessionId, command: executeCommand, approved: true }); setOutput((value) => `${value}${result}\n`); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const askAiSsh = async (approved: boolean) => {
    if (!sessionId || !model.baseUrl.trim() || !model.model.trim() || (!aiInput.trim() && !approved) || aiBusy) return;
    setAiBusy(true);
    try {
      const raw = await invoke<string>("ai_ssh_chat", { request: { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model, sessionId, prompt: approved ? `请执行已批准的命令：${pendingCommand}` : aiInput.trim(), approved } });
      const result = JSON.parse(raw) as { status?: string; command?: string; output?: string; content?: string; executed?: Array<{ command: string; output: string }> };
      if (result.status === "approval_required" && result.command) { setPendingCommand(result.command); setAiReply(`AI 请求执行：${result.command}`); }
      else if (result.status === "executed") { const history = result.executed?.map((item) => `$ ${item.command}\n${item.output}`).join("\n") ?? `$ ${result.command ?? ""}\n${result.output ?? ""}`; setAiReply(`${history}\n${result.content ?? ""}`); setPendingCommand(null); setOutput((value) => `${value}${history}\n`); }
      else setAiReply(result.content ?? raw);
    } catch (reason) { setAiReply(`AI-SSH 请求失败：${String(reason)}`); }
    finally { setAiBusy(false); }
  };
  return <section className="server-terminal-section"><div className="server-home-section-heading"><div><span className="home-section-label">SSH</span><h2>持久终端</h2></div><span className={`terminal-state ${sessionId ? "is-ready" : ""}`}>{sessionId ? "已连接" : "连接中"}</span></div><pre className="server-terminal-output">{output || (error ? "" : "等待终端连接…")}</pre>{error && <p className="model-test-message is-error">{error}</p>}<div className="server-terminal-input"><input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} placeholder="输入只读或已确认的命令" disabled={!sessionId || busy} /><button className="primary" type="button" onClick={() => void run()} disabled={!sessionId || busy || !command.trim()}>执行</button></div><div className="ai-ssh-box"><strong>AI-SSH</strong><textarea value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="让 AI 检查或处理这台服务器…" rows={2} disabled={!sessionId || aiBusy} /><div className="ai-ssh-actions"><button className="primary" type="button" onClick={() => void askAiSsh(false)} disabled={!sessionId || aiBusy || !aiInput.trim()}>询问 AI</button>{pendingCommand && <><span className="ai-ssh-pending">待确认：{pendingCommand}</span><button className="secondary" type="button" onClick={() => void askAiSsh(true)} disabled={aiBusy}>确认执行</button><input className="approve-input" placeholder="或输入 approve" onKeyDown={(event) => { if (event.key === "Enter" && event.currentTarget.value.trim().toLowerCase() === "approve") { event.currentTarget.value = ""; void askAiSsh(true); } }} /></>}</div>{aiReply && <pre className="ai-ssh-reply">{aiReply}</pre>}</div></section>;
}

function TerminalWorkspace({ server, servers, model, onConnectionState }: { server: ServerSummary; servers: ServerSummary[]; model: ModelPreferences; onConnectionState?: (serverId: string, connected: boolean) => void }) {
  const [tabIds, setTabIds] = React.useState<string[]>([server.id]);
  const [focusedId, setFocusedId] = React.useState(server.id);
  const [showAddMenu, setShowAddMenu] = React.useState(false);
  const [closeTarget, setCloseTarget] = React.useState<ServerSummary | null>(null);
  const tabs = tabIds.map((id) => servers.find((item) => item.id === id)).filter((item): item is ServerSummary => Boolean(item));
  const focused = tabs.find((item) => item.id === focusedId) ?? tabs[0] ?? server;
  React.useEffect(() => {
    const reopen = (event: Event) => {
      const requested = (event as CustomEvent<{ serverId?: string }>).detail?.serverId;
      const target = (requested && servers.find((item) => item.id === requested)) || server;
      setTabIds((current) => current.includes(target.id) ? current : [...current, target.id]);
      setFocusedId(target.id);
    };
    window.addEventListener("opsnest-open-ssh", reopen);
    return () => window.removeEventListener("opsnest-open-ssh", reopen);
  }, [server.id, servers]);
  React.useEffect(() => {
    const tabsBar = document.querySelector<HTMLElement>(".terminal-tabs");
    const add = tabsBar?.querySelector<HTMLButtonElement>(".terminal-tab-add");
    if (!tabsBar || !add) return;
    const toggle = (event: Event) => { event.stopPropagation(); setShowAddMenu((value) => !value); };
    add.addEventListener("click", toggle, true);
    if (showAddMenu) {
      const menu = document.createElement("div"); menu.className = "terminal-add-menu";
      servers.filter((item) => !tabIds.includes(item.id)).forEach((item) => { const option = document.createElement("button"); option.type = "button"; option.textContent = item.name; option.onclick = () => { setTabIds((current) => [...current, item.id]); setFocusedId(item.id); setShowAddMenu(false); }; menu.appendChild(option); });
      if (!menu.childElementCount) { const empty = document.createElement("span"); empty.textContent = "没有可打开的服务器"; menu.appendChild(empty); }
      tabsBar.appendChild(menu);
    }
    return () => { add.removeEventListener("click", toggle, true); tabsBar.querySelector(".terminal-add-menu")?.remove(); };
  }, [showAddMenu, servers, tabIds]);
  const closeTab = (id: string) => {
    const target = tabs.find((item) => item.id === id);
    if (!target) return;
    setCloseTarget(target);
  };
  const confirmCloseTab = () => {
    const id = closeTarget?.id;
    setCloseTarget(null);
    if (!id) return;
    const nextTabs = tabIds.filter((item) => item !== id);
    setTabIds(nextTabs);
    if (focusedId === id) setFocusedId(nextTabs[0] ?? "");
    if (nextTabs.length === 0) window.dispatchEvent(new CustomEvent("opsnest-close-ssh"));
    intentionallyClosedSessions.add(id);
    void invoke("close_interactive_ssh_terminal", { sessionId: id });
  };
  return <><div className="terminal-workspace"><div className="terminal-tabs">{tabs.map((item) => <div key={item.id} className={`terminal-tab ${item.id === focused.id ? "is-active" : ""}`}><button type="button" onClick={() => setFocusedId(item.id)}><TerminalGlyph size={14} strokeWidth={1.8} /><span>{item.name}</span></button><button className="terminal-tab-close" type="button" onClick={() => closeTab(item.id)} aria-label={`关闭 ${item.name}`}><X size={12} /></button></div>)}<button className="terminal-tab-add" type="button" onClick={() => { const next = servers.find((item) => !tabIds.includes(item.id)); if (next) { setTabIds((current) => [...current, next.id]); setFocusedId(next.id); } }} aria-label="新建 SSH 连接">+</button></div>{tabs.length > 0 && <InteractiveTerminalPanel key={focused.id} server={focused} model={model} onConnectionState={onConnectionState} />}</div>{closeTarget && <div className="rename-modal-backdrop" role="presentation"><section className="rename-modal terminal-close-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-close-title"><h2 id="terminal-close-title">关闭 {closeTarget.name} 的 SSH 终端？</h2><p>关闭后会断开当前 SSH 连接；聊天记录仍会保存在任务记录中。</p><div className="rename-modal-actions"><button className="secondary" type="button" onClick={() => setCloseTarget(null)}>取消</button><button className="primary" type="button" onClick={confirmCloseTab}>确定</button></div></section></div>}</>;
}
const SHELL_COMMANDS = new Set(["cd", "ls", "pwd", "cat", "echo", "printf", "clear", "history", "find", "grep", "sed", "awk", "head", "tail", "less", "more", "sort", "uniq", "cut", "xargs", "tee", "touch", "mkdir", "cp", "mv", "rm", "ln", "chmod", "chown", "sudo", "apt", "apt-get", "apk", "yum", "dnf", "pacman", "brew", "docker", "podman", "systemctl", "service", "journalctl", "ps", "top", "htop", "kill", "df", "du", "free", "uname", "hostname", "whoami", "id", "env", "export", "source", "set", "ssh", "scp", "curl", "wget", "tar", "zip", "unzip", "git", "npm", "pnpm", "yarn", "pip", "python", "python3", "node", "go", "cargo", "make", "cmake", "java", "php", "ruby", "perl", "openssl", "vim", "vi", "nano", "tmux", "screen", "reboot", "shutdown"]);
const RISKY_SHELL_PARTS = ["sudo ", "rm ", "mv ", "chmod ", "chown ", "systemctl start", "systemctl stop", "systemctl restart", "systemctl enable", "systemctl disable", "service start", "service stop", "service restart", "reboot", "shutdown", "docker rm", "docker stop", "docker restart", "apt install", "apt remove", "apt purge", "apt upgrade", "dnf install", "yum install"];
function looksLikeShellCommand(input: string) {
  const value = input.trim();
  if (!value) return false;
  if (value.startsWith("/cmd ")) return true;
  if (/^(?:[.!/~$][^\s]*|[A-Za-z]:\\[^\s]*)/.test(value)) return true;
  if (/[|;&<>`]|	/.test(value)) return true;
  const first = value.split(/\s+/, 1)[0].toLowerCase();
  return SHELL_COMMANDS.has(first);
}
function isRiskyShellCommand(input: string) {
  const value = input.trim().toLowerCase();
  return RISKY_SHELL_PARTS.some((part) => value.includes(part));
}
const terminalBuffers = new Map<string, string>();
const intentionallyClosedSessions = new Set<string>();
function terminalBufferStorageKey(sessionId: string) {
  return `opsnest-terminal-buffer:${sessionId}`;
}
function rememberTerminalOutput(sessionId: string, data: string) {
  if (!data) return;
  const next = `${terminalBuffers.get(sessionId) ?? ""}${data}`;
  const trimmed = next.length > 160_000 ? next.slice(-160_000) : next;
  terminalBuffers.set(sessionId, trimmed);
  try { window.sessionStorage.setItem(terminalBufferStorageKey(sessionId), trimmed); } catch { /* storage is best effort */ }
}
function clearTerminalOutput(sessionId: string) {
  terminalBuffers.delete(sessionId);
  try { window.sessionStorage.removeItem(terminalBufferStorageKey(sessionId)); } catch { /* storage is best effort */ }
}
function InteractiveTerminalPanel({ server, model, onConnectionState }: { server: ServerSummary; model: ModelPreferences; onConnectionState?: (serverId: string, connected: boolean) => void }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const modelRef = React.useRef(model);
  React.useEffect(() => { modelRef.current = model; }, [model]);
  const inputRef = React.useRef("");
  const promptRef = React.useRef("");
  const promptVersionRef = React.useRef(0);
  const pendingRef = React.useRef<string | null>(null);
  const approveHandlerRef = React.useRef<((command: string) => void) | null>(null);
  const [pendingApproval, setPendingApproval] = React.useState<string | null>(null);
  // Each mounted terminal gets its own backend session. Reusing the server id
  // lets a delayed close event from the previous PTY appear in the new tab.
  // One long-lived PTY per server. Switching the bottom tabs only changes the
  // visible panel; it must not create a new SSH connection or close the old one.
  const sessionRef = React.useRef<string>(server.id);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const host = hostRef.current; if (!host) return;
    void writeDebugLog("debug", "AI-SSH terminal mounted", { serverId: server.id });
    const term = new Terminal({ convertEol: true, cursorBlink: true, scrollback: 10000, fontSize: 13, lineHeight: 1.35, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", theme: { background: "#0d0d0f", foreground: "#e7e7e7", cursor: "#f5f5f5", selectionBackground: "#39404a" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host); fit.fit(); termRef.current = term; term.focus();
    const focusTerminal = () => term.focus();
    host.addEventListener("mousedown", focusTerminal);
    const render = (data: string, persist = true) => {
      // Keep the last shell prompt locally. AI-SSH must not send an empty
      // carriage return to the remote shell just to redraw it: bash treats
      // that as an empty command and emits a duplicate prompt.
      const plain = data.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
      if (persist) rememberTerminalOutput(server.id, data);
      const prompt = plain.match(/(?:^|\r?\n)([^\r\n]{1,160}(?:#|\$)\s?)$/);
      if (prompt?.[1] && !prompt[1].includes("AI 正在处理")) { promptRef.current = prompt[1]; promptVersionRef.current += 1; }
      if (data.includes("AI 正在处理") || data.includes("• ") || (prompt?.[1] && data.includes(prompt[1]))) {
        void writeDebugLog("debug", "AI-SSH terminal render", { serverId: server.id, length: data.length, hasProcessing: data.includes("AI 正在处理"), hasPrompt: Boolean(prompt?.[1]) });
      }
      term.write(data, () => { term.scrollToBottom(); term.refresh(0, term.rows - 1); });
    };
    const previous = terminalBuffers.get(server.id); if (previous) render(previous, false);
    const at = server.host.indexOf("@"); const username = at > 0 ? server.host.slice(0, at) : "root"; const hostName = at > 0 ? server.host.slice(at + 1) : server.host;
   const request = { host: hostName, port: server.port, username, authMethod: server.authMethod ?? "password", password: server.password ?? null, privateKeyPath: null, passphrase: null };
   const write = (data: string) => invoke("write_interactive_ssh_terminal", { sessionId: sessionRef.current, data }).catch((reason) => setError(String(reason)));
   const refreshPrompt = () => { if (promptRef.current) render(`\r\n${promptRef.current}`); };
    const askAi = async (prompt: string, approved: boolean) => {
      const currentModel = modelRef.current;
      void writeDebugLog("debug", "AI-SSH input received", { serverId: server.id, promptLength: prompt.length, approved });
      if (!currentModel.baseUrl.trim() || !currentModel.model.trim()) { render("\r\n\x1b[31mAI 模型尚未配置\x1b[0m\r\n"); refreshPrompt(); return; }
      render("\r\n\x1b[38;5;114m• AI 正在处理…\x1b[0m\r\n");
       void appendActivity({ category: "ai", title: `AI-SSH · ${server.name}`, detail: `用户: ${prompt}` }).catch(() => undefined);
      try {
        void writeDebugLog("debug", "AI-SSH model request started", { serverId: server.id, model: currentModel.model });
        const raw = await invoke<string>("ai_ssh_chat", { request: { baseUrl: currentModel.baseUrl, apiKey: currentModel.apiKey, model: currentModel.model, sessionId: sessionRef.current, prompt, approved, context: `服务器：${server.name}；地址：${server.host}:${server.port}；系统：${server.system || "尚未扫描"}` } });
        const result = JSON.parse(raw) as { status?: string; command?: string; content?: string; summary?: string; executed?: Array<{ command: string; output: string }> };
        void writeDebugLog("debug", "AI-SSH model response received", { serverId: server.id, status: result.status ?? "unknown", hasContent: Boolean(result.content), executed: result.executed?.length ?? 0 });
        if (result.status === "approval_required" && result.command) { pendingRef.current = result.command; setPendingApproval(result.command); render(`\r\n\x1b[38;5;220m• AI 建议执行：${result.command}\x1b[0m\r\n`); void appendActivity({ category: "ai", title: `AI-SSH · ${server.name}`, detail: `AI 待确认命令: ${result.command}` }).catch(() => undefined); return; }
        // The command and its output already arrive through the live PTY event.
        // Rendering the returned tool result again duplicates prompts and banners.
        const executedAny = Boolean(result.executed?.length);
        if (result.executed?.length) for (const item of result.executed) { void appendActivity({ category: "task", title: `AI-SSH · ${server.name}`, detail: `$ ${item.command}\n${item.output}` }).catch(() => undefined); }
        if (result.content) { render(`\r\n\x1b[38;5;114m• ${result.content}\x1b[0m\r\n`); void appendActivity({ category: "ai", title: `AI-SSH · ${server.name}`, detail: `AI: ${result.content}` }).catch(() => undefined); }
        pendingRef.current = null;
        if (!executedAny) refreshPrompt();
      } catch (reason) { void writeDebugLog("error", "AI-SSH request failed", { serverId: server.id, error: String(reason) }); render(`\r\n\x1b[31mAI-SSH 请求失败：${String(reason)}\x1b[0m\r\n`); refreshPrompt(); }
    };
    const executeApprovedCommand = async (command: string) => {
      try {
        const promptVersionBefore = promptVersionRef.current;
        const output = await invoke<string>("execute_interactive_ssh_command", { sessionId: sessionRef.current, command });
        pendingRef.current = null;
        setPendingApproval(null);
        if (!output.trim()) {
          render("\r\n\x1b[38;5;114m• 命令执行完成（无输出）\x1b[0m\r\n");
          await write("\r");
        } else if (promptVersionRef.current === promptVersionBefore) {
          await write("\r");
        }
        void appendActivity({ category: "task", title: `AI-SSH · ${server.name}`, detail: `$ ${command}\n${output}` }).catch(() => undefined);
      } catch (reason) {
        render(`\r\n\x1b[31m执行已批准命令失败：${String(reason)}\x1b[0m\r\n`);
        refreshPrompt();
      }
    };
    approveHandlerRef.current = (command: string) => { void executeApprovedCommand(command); };
    let unlisten: (() => void) | undefined;
    let markerCarry = "";
    const cleanInteractiveMarker = (data: string) => {
      const prefix = "__OPSNEST_INTERACTIVE_END_";
      let text = markerCarry + data;
      markerCarry = "";
      const markerStart = text.indexOf(prefix);
      if (markerStart >= 0) {
        const markerEnd = text.indexOf("__", markerStart + prefix.length);
        if (markerEnd >= 0) text = `${text.slice(0, markerStart)}${text.slice(markerEnd + 2)}`;
        else { markerCarry = text.slice(markerStart); text = text.slice(0, markerStart); }
      } else {
        for (let length = Math.min(prefix.length - 1, text.length); length > 0; length -= 1) {
          if (prefix.endsWith(text.slice(-length))) { markerCarry = text.slice(-length); text = text.slice(0, -length); break; }
        }
      }
      // `stty -echo` is an internal bootstrap command. The PTY may echo it
      // once before echo mode is disabled; keep the real login banner clean.
      return text.replace(/stty -echo/g, "");
    };
    // Register the output listener before opening the remote shell. A fast SSH
    // login can emit its first prompt immediately; subscribing afterwards
    // loses that prompt and leaves a blank terminal with only the cursor.
    let disposed = false;
    void listen<{ sessionId: string; data: string; closed: boolean }>("ssh-terminal-output", (event) => { if (event.payload.sessionId !== sessionRef.current) return; if (event.payload.closed) { clearTerminalOutput(server.id); if (!intentionallyClosedSessions.has(sessionRef.current)) window.dispatchEvent(new CustomEvent("opsnest-server-connection-state", { detail: { serverId: server.id, connected: false } })); render("\r\n\x1b[31m[SSH connection closed]\x1b[0m\r\n"); } else render(cleanInteractiveMarker(event.payload.data)); })
      .then((dispose) => { if (disposed) { dispose(); return null; } unlisten = dispose; intentionallyClosedSessions.delete(sessionRef.current); return invoke<boolean>("open_interactive_ssh_terminal", { request, sessionId: sessionRef.current }); })
      .then((created) => { if (created === null) return; if (disposed) { if (created) void invoke("close_interactive_ssh_terminal", { sessionId: sessionRef.current }); return; } window.dispatchEvent(new CustomEvent("opsnest-server-connection-state", { detail: { serverId: server.id, connected: true } })); })
      .catch((reason) => { if (disposed) return; window.dispatchEvent(new CustomEvent("opsnest-server-connection-state", { detail: { serverId: server.id, connected: false } })); setError(String(reason)); render(`\r\n\x1b[31mSSH connection failed: ${String(reason)}\x1b[0m\r\n`); });
    const input = term.onData((data) => {
      if (data === "\r" || data === "\n") {
        const line = inputRef.current.trim(); inputRef.current = ""; render("\r\n");
        if (!line) { void write("\r"); return; }
        if (pendingRef.current && line.toLowerCase() === "approve") { const approvedCommand = pendingRef.current; pendingRef.current = null; setPendingApproval(null); approveHandlerRef.current?.(approvedCommand); return; }
        const forcedAi = line.startsWith("/ai ");
        const command = line.startsWith("/cmd ") ? line.slice(5).trim() : line;
        if (!forcedAi && looksLikeShellCommand(line)) {
          if (isRiskyShellCommand(command) && !window.confirm(`此命令可能改变服务器状态：\n\n${command}\n\n确认直接执行？`)) return;
          void appendActivity({ category: "task", title: `AI-SSH · ${server.name}`, detail: `$ ${command}` }).catch(() => undefined);
          void write(`${command}\r`);
          return;
        }
        void askAi(forcedAi ? line.slice(4).trim() : line, false);
        return;
      }
       if (data === "\x7f" || data === "\b") { if (inputRef.current) { inputRef.current = inputRef.current.slice(0, -1); term.write("\b \b", () => term.refresh(0, term.rows - 1)); } return; }
       inputRef.current += data;
       // The remote PTY runs with echo disabled because natural-language input
       // is intercepted by AI-SSH. Echo the local line explicitly and refresh
       // the viewport after xterm's write queue drains; this avoids invisible
       // keystrokes when output and input arrive in the same frame.
       term.write(data, () => { term.scrollToBottom(); term.refresh(0, term.rows - 1); });
    });
    const resize = () => { fit.fit(); void invoke("resize_interactive_ssh_terminal", { sessionId: sessionRef.current, columns: term.cols, rows: term.rows }).catch(() => undefined); };
    const hostResizeObserver = new ResizeObserver(() => { resize(); term.scrollToBottom(); });
    hostResizeObserver.observe(host);
    window.addEventListener("resize", resize); resize();
    return () => {
      disposed = true;
      approveHandlerRef.current = null;
      void writeDebugLog("debug", "AI-SSH terminal unmounted", { serverId: server.id });
      input.dispose();
      unlisten?.();
      hostResizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      host.removeEventListener("mousedown", focusTerminal);
      const closingSession = sessionRef.current;
      // Persist the shared blackboard, but keep the PTY alive while the user
      // switches tabs. It is closed only by the explicit tab-close handler.
      void invoke<{ events?: Array<{ kind: string; text: string }> }>("get_ssh_session_blackboard", { sessionId: closingSession })
        .then((snapshot) => {
          const detail = (snapshot.events ?? []).slice(-80).map((event) => `[${event.kind}] ${event.text}`).join("\n").slice(-24000);
          if (detail.trim()) void appendActivity({ category: "task", title: `AI-SSH · ${server.name}`, detail }).catch(() => undefined);
        })
        .catch(() => undefined);
      term.dispose();
      termRef.current = null;
    };
  }, [server.id]);
  const approvePending = () => { const approvedCommand = pendingRef.current; if (!approvedCommand) return; pendingRef.current = null; setPendingApproval(null); approveHandlerRef.current?.(approvedCommand); };
  const editPending = () => { const command = pendingRef.current; if (!command) return; pendingRef.current = null; setPendingApproval(null); inputRef.current = command; termRef.current?.write(command); termRef.current?.focus(); };
  const rejectPending = () => { pendingRef.current = null; setPendingApproval(null); };
  return <section className="interactive-terminal-panel"><div ref={hostRef} className="interactive-terminal-host" />{pendingApproval && <div className="interactive-terminal-approval" role="alert"><div className="interactive-terminal-approval-title"><span className="approval-dot" />AI 请求执行命令</div><p>是否同意执行以下命令并查看输出？</p><pre>{pendingApproval}</pre><div className="interactive-terminal-approval-actions"><button className="secondary" type="button" onClick={approvePending}>执行</button><button className="secondary" type="button" onClick={editPending}>修改</button><button className="secondary" type="button" onClick={rejectPending}>拒绝</button></div></div>}{error && <div className="interactive-terminal-error">{error}</div>}</section>;
}
function ServiceDiscoveryPanel({ server }: { server: ServerSummary }) {
  const [services, setServices] = React.useState<Array<{ name: string; kind: string; status: string; detail: string }>>([]);
  const [state, setState] = React.useState("扫描中");
  const scan = React.useCallback(async () => {
    setState("扫描中");
    const at = server.host.indexOf("@"); const username = at > 0 ? server.host.slice(0, at) : "root"; const host = at > 0 ? server.host.slice(at + 1) : server.host;
    try { const result = await invoke<Array<{ name: string; kind: string; status: string; detail: string }>>("discover_linux_services", { request: { host, port: server.port, username, authMethod: server.authMethod ?? "password", password: server.password ?? null, privateKeyPath: null, passphrase: null } }); setServices(result); setState(`已发现 ${result.length} 项`); }
    catch (reason) { setState(`扫描失败：${String(reason)}`); }
  }, [server.id]);
  React.useEffect(() => { void scan(); }, [scan]);
  React.useEffect(() => {
    let cancelled = false;
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".discovered-service"));
    void (async () => {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]; const service = services[index]; if (!service || row.querySelector(".discovered-service-icon")) continue;
        const directory = iconDirectory(service.kind, service.name); const key = service.name.toLowerCase().split(/\s+/)[0]; const candidates = iconCandidates(key, service.name.match(/\d+(?:\.\d+)+/)?.[0]); let source = "";
        for (const candidate of candidates) { for (const type of ["svg", "png"] as const) { const local = `/icons/packed/${directory}/${encodeURIComponent(candidate)}.${type}`; try { if ((await fetch(local, { method: "HEAD" })).ok) { source = local; break; } const remote = remoteIconUrl(directory, candidate, type); if ((await fetch(remote, { method: "HEAD" })).ok) { source = remote; break; } } catch { /* fallback */ } } if (source) break; }
        if (!source || cancelled) continue; const holder = document.createElement("span"); holder.className = "discovered-service-icon"; const image = document.createElement("img"); image.src = source; image.alt = ""; image.width = 18; image.height = 18; holder.appendChild(image); row.prepend(holder);
      }
    })();
    return () => { cancelled = true; };
  }, [services]);
  return <section className="service-discovery-section"><div className="server-home-section-heading"><div><span className="home-section-label">服务</span><h2>内置服务发现</h2></div><button className="text-button" type="button" onClick={() => void scan()}>重新扫描</button></div><p className="service-discovery-state">{state}</p>{services.length > 0 ? <div className="discovered-service-list">{services.map((service, index) => <div className="discovered-service" key={`${service.kind}-${service.name}-${index}`}><strong>{service.name}</strong><span>{service.kind} · {service.status}</span><small>{service.detail}</small></div>)}</div> : <div className="server-service-empty"><strong>暂未发现可展示的服务</strong><span>扫描 Docker、systemd 服务和监听端口后，结果会显示在这里。</span></div>}</section>;
}

function WebServiceDiscoveryPanel({ server, onServicesUpdated }: { server: ServerSummary; onServicesUpdated: (services: DiscoveredServiceSummary[]) => void }) {
  const [services, setServices] = React.useState<DiscoveredServiceSummary[]>(() => (server.services ?? []).filter((service) => (service.kind.toLowerCase() !== "docker" || Boolean(service.port)) && !(service.id === "1panel" && service.port === server.port)));
  const [state, setState] = React.useState("正在扫描");
  const [showCustomService, setShowCustomService] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customLabel, setCustomLabel] = React.useState("");
  const [customPort, setCustomPort] = React.useState("");
  const [customPath, setCustomPath] = React.useState("");
  const [editingServiceId, setEditingServiceId] = React.useState<string | null>(null);
  const [editingLabel, setEditingLabel] = React.useState("");
  const scan = React.useCallback(async () => {
    setState("正在扫描");
    const at = server.host.indexOf("@");
    const username = at > 0 ? server.host.slice(0, at) : "root";
    const host = at > 0 ? server.host.slice(at + 1) : server.host;
    void writeDebugLog("debug", "service discovery started", { serverId: server.id, host, port: server.port, hasPassword: Boolean(server.password) });
    try {
      const credential = server.password ?? await invoke<string | null>("load_server_credential", { serverId: server.id }).catch(() => null);
      const result = await invoke<DiscoveredServiceSummary[]>("discover_linux_services", { request: { host, port: server.port, username, authMethod: server.authMethod ?? "password", password: credential ?? null, privateKeyPath: null, passphrase: null } });
      const cleaned = result.filter((service) => !(service.id === "1panel" && service.port === server.port));
      const webServices = cleaned.filter((service) => service.kind.toLowerCase() !== "docker" || Boolean(service.port));
      setServices(webServices); onServicesUpdated(cleaned); setState(`已发现 ${webServices.length} 个 Web 服务`);
      void writeDebugLog("info", "service discovery completed", { serverId: server.id, total: cleaned.length, webServices: webServices.length, services: cleaned.map((service) => ({ id: service.id, kind: service.kind, port: service.port, status: service.status })) });
    } catch (reason) { setState(`扫描失败：${String(reason)}`); void writeDebugLog("error", "service discovery failed", { serverId: server.id, error: String(reason) }); }
  }, [server.id, server.password, onServicesUpdated]);
  React.useEffect(() => { void scan(); }, [scan]);
  const updateService = (id: string, field: "port" | "webPath" | "customLabel", value: string) => {
    const next = services.map((service) => service.id === id ? { ...service, [field]: field === "port" ? (Number(value) || undefined) : (value.trim() || undefined) } : service);
    setServices(next); onServicesUpdated([...(server.services ?? []).filter((service) => service.kind.toLowerCase() === "docker" && !next.some((item) => item.id === service.id)), ...next]);
  };
  const beginEditLabel = (service: DiscoveredServiceSummary) => { setEditingServiceId(service.id); setEditingLabel(service.customLabel ?? ""); };
  const saveEditLabel = () => { if (!editingServiceId) return; updateService(editingServiceId, "customLabel", editingLabel); setEditingServiceId(null); setEditingLabel(""); };
  const addCustomService = () => {
    const name = customName.trim(); const port = Number(customPort);
    if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const service: DiscoveredServiceSummary = { id: `custom-${Date.now()}`, name, kind: "web", status: "自定义", detail: `端口 · ${port}`, port, webPath: customPath.trim() || undefined, customLabel: customLabel.trim() || undefined };
    const next = [...services, service]; setServices(next); onServicesUpdated([...(server.services ?? []).filter((item) => item.kind.toLowerCase() === "docker" && !next.some((entry) => entry.id === item.id)), ...next]);
    setCustomName(""); setCustomLabel(""); setCustomPort(""); setCustomPath(""); setShowCustomService(false);
  };
  const removeCustomService = (id: string) => {
    const next = services.filter((service) => service.id !== id);
    setServices(next);
    onServicesUpdated([...(server.services ?? []).filter((item) => item.kind.toLowerCase() === "docker" && !next.some((entry) => entry.id === item.id)), ...next]);
  };
  const openService = async (service: DiscoveredServiceSummary) => {
    if (!service.port) return;
    if (service.id === "1panel" && service.port === server.port) { setState("1Panel 管理端口未能确认，请重新扫描"); return; }
    const host = server.host.split("@").pop() ?? server.host;
    const path = service.webPath ? (service.webPath.startsWith("/") ? service.webPath : `/${service.webPath}`) : "/";
    try {
      const baseUrl = await invoke<string>("resolve_service_url", { host, port: service.port, preferredScheme: service.webScheme ?? null });
      const resolved = `${baseUrl.replace(/\/$/, "")}${path === "/" ? "" : path}`;
      await invoke("open_external_url", { url: resolved });
    }
    catch (reason) { setState(`打开服务失败：${String(reason)}`); }
  };
  return <section className="service-discovery-section"><div className="server-home-section-heading"><div><span className="home-section-label">服务</span><div className="service-heading-title"><h2>常用入口</h2><button className="service-add-button" type="button" onClick={() => setShowCustomService((value) => !value)} aria-label="添加自定义服务入口">+</button></div></div><button className="text-button" type="button" onClick={() => void scan()}>重新扫描</button></div>{showCustomService && <div className="custom-service-form"><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="服务名称" /><input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="备注内容（可选）" /><input value={customPort} onChange={(event) => setCustomPort(event.target.value)} placeholder="端口" inputMode="numeric" /><input value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="路径（可选）" /><button className="primary" type="button" onClick={addCustomService} disabled={!customName.trim() || !customPort}>添加</button></div>}<p className="service-discovery-state">{state}</p><DockerServiceCard server={server} />{services.length > 0 ? <div className="discovered-service-list">{services.map((service) => <div className="discovered-service" key={service.id}>{<span className="service-card-actions-zone">{!service.id.startsWith("custom-") && <button className="service-card-edit" type="button" onClick={() => beginEditLabel(service)} aria-label={`编辑 ${service.name}`}>✎</button>}{service.id.startsWith("custom-") && <button className="custom-service-remove" type="button" onClick={() => removeCustomService(service.id)} aria-label={`删除 ${service.name}`}>×</button>}</span>}<span className="discovered-service-icon-slot"><ServiceIcon kind={service.id.startsWith("custom-") ? "custom-web" : service.kind} name={service.name} /></span><div><strong>{service.name}</strong><span>{service.kind} · {service.status}{service.webScheme ? ` · ${service.webScheme.toUpperCase()}` : ""}</span>{editingServiceId === service.id ? <div className="service-custom-label-editor"><input autoFocus value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} placeholder="自定义显示字段" onKeyDown={(event) => { if (event.key === "Enter") saveEditLabel(); if (event.key === "Escape") setEditingServiceId(null); }} /><button type="button" onClick={saveEditLabel}>保存</button></div> : service.customLabel && <small className="service-custom-label">{service.customLabel}</small>}</div><small>{service.detail}</small><div className="discovered-service-edit"><input aria-label="端口" value={service.port ? String(service.port) : ""} onChange={(event) => updateService(service.id, "port", event.target.value)} placeholder="端口" inputMode="numeric" /><input aria-label="路径" value={service.webPath ?? ""} onChange={(event) => updateService(service.id, "webPath", event.target.value)} placeholder="路径（可选）" /><button className="text-button" type="button" onClick={() => void openService(service)}>打开</button></div></div>)}</div> : <div className="server-service-empty"><strong>暂未发现 Web 服务入口</strong><span>仅显示具有可访问 Web 端口的服务。</span></div>}</section>;
}

function App() {
  const [appearance, setAppearance] = React.useState<AppearancePreferences>(DEFAULT_APPEARANCE);
  const [model, setModel] = React.useState<ModelPreferences>(DEFAULT_MODEL);
  const [servers, setServers] = React.useState<ServerSummary[]>([]);
  const [appearanceLoaded, setAppearanceLoaded] = React.useState(false);
  const [modelLoaded, setModelLoaded] = React.useState(false);
  const [serversLoaded, setServersLoaded] = React.useState(false);
  const [selectedMenu, setSelectedMenu] = React.useState<string | null>("home");
  const [menuHistory, setMenuHistory] = React.useState<string[]>([]);
  const [forwardHistory, setForwardHistory] = React.useState<string[]>([]);
  const [forwardSettings, setForwardSettings] = React.useState<"appearance" | "model" | null>(null);
  const [renameTarget, setRenameTarget] = React.useState<ServerSummary | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [editingServer, setEditingServer] = React.useState<ServerSummary | null>(null);
  const [passwordTarget, setPasswordTarget] = React.useState<ServerSummary | null>(null);
  const [passwordDraft, setPasswordDraft] = React.useState("");
  const [settingsRequest, setSettingsRequest] = React.useState<"appearance" | "model" | null>(null);
  const [openManagerBottomSignal, setOpenManagerBottomSignal] = React.useState(0);
  const [openFileManagerSignal, setOpenFileManagerSignal] = React.useState(0);
  const [closeFileManagerSignal, setCloseFileManagerSignal] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    void readPortableJson<Partial<AppearancePreferences>>(APPEARANCE_FILE, {}).then((saved) => {
      if (!active) return;
      setAppearance(normalizeAppearance(saved));
      setAppearanceLoaded(true);
    });
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    let active = true;
    void readPortableJson<ServerSummary[]>(SERVERS_FILE, []).then(async (saved) => {
      const valid = Array.isArray(saved) ? saved.filter((server) => server && typeof server.name === "string" && typeof server.host === "string" && Number.isInteger(server.port)) : [];
      const enriched = await Promise.all(valid.map(async (server) => {
        try {
          const password = await invoke<string | null>("load_server_credential", { serverId: server.id });
          if (password) return { ...server, password };
          if (server.password) {
            await invoke("save_server_credential", { serverId: server.id, password: server.password });
            return server;
          }
          return server;
        } catch { return server; }
      }));
      if (!active) return;
      setServers(enriched.map((server) => ({ ...server, connected: false })));
      setServersLoaded(true);
    });
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    let active = true;
    void readPortableJson<Partial<ModelPreferences>>(MODEL_FILE, {}).then((saved) => {
      if (!active) return;
      setModel({ ...DEFAULT_MODEL, ...saved, provider: saved.provider === "openai" || saved.provider === "deepseek" || saved.provider === "ollama" ? saved.provider : "custom" });
      setModelLoaded(true);
    });
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = appearance.theme === "system" ? (media.matches ? "dark" : "light") : appearance.theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.lang = appearance.language;
      document.documentElement.style.setProperty("--ui-font-size", `${appearance.uiSize}px`);
      document.documentElement.classList.toggle("reduce-motion", appearance.reduceMotion);
      document.documentElement.classList.toggle("translucent-sidebar", appearance.translucentSidebar);
    };

    apply();
    if (appearance.theme === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);

  React.useEffect(() => {
    if (!appearanceLoaded) return;
    void writePortableJson(APPEARANCE_FILE, appearance).catch(() => undefined);
  }, [appearance, appearanceLoaded]);

  React.useEffect(() => {
    if (!appearanceLoaded) return;
    void writePortableJson(DEBUG_FILE, { enabled: appearance.debugLogging }).catch(() => undefined);
  }, [appearance.debugLogging, appearanceLoaded]);

  React.useEffect(() => {
    if (!appearanceLoaded) return;
    void writeDebugLog("info", "application preferences loaded", {
      theme: appearance.theme,
      language: appearance.language,
      debugLogging: appearance.debugLogging,
    });
  }, [appearanceLoaded]);

  React.useEffect(() => {
    if (selectedMenu) void writeDebugLog("debug", "navigation selection changed", { selectedMenu });
  }, [selectedMenu]);

  React.useEffect(() => {
    if (!modelLoaded) return;
    void writePortableJson(MODEL_FILE, model).catch(() => undefined);
  }, [model, modelLoaded]);

  React.useEffect(() => {
    if (!serversLoaded) return;
    const metadataOnly = servers.map(({ password: _password, ...server }) => server);
    void writePortableJson(SERVERS_FILE, metadataOnly).catch(() => undefined);
  }, [servers, serversLoaded]);

  const isEnglish = appearance.language === "en";
  const navigate = (next: string) => {
    if (next === "activity") { next = "tasks"; }
    if (next.startsWith("__edit:")) { const server = servers.find((item) => item.id === next.slice(7)); if (server) { setEditingServer(server); setSelectedMenu("server-edit"); } return; }
    if (next.startsWith("__rename:")) { const server = servers.find((item) => item.id === next.slice(9)); if (server) { setRenameTarget(server); setRenameDraft(server.name); } return; }
    if (next.startsWith("__connect:")) { const id = next.slice(10); setServers((current) => current.map((item) => item.id === id ? { ...item, connected: !item.connected } : item)); return; }
    if (next.startsWith("__delete:")) { const id = next.slice(9); const server = servers.find((item) => item.id === id); if (server && window.confirm(`确定删除服务器“${server.name}”？`)) { setServers((current) => current.filter((item) => item.id !== id)); if (selectedMenu === `server-${id}`) setSelectedMenu("home"); } return; }
    if (next === "manager") window.dispatchEvent(new Event("opsnest-close-ssh"));
    if (next === selectedMenu) return;
    if (selectedMenu) setMenuHistory((history) => [...history, selectedMenu]);
    setForwardHistory([]);
    setForwardSettings(null);
    setSelectedMenu(next);
  };
  const navigateBack = () => {
    setMenuHistory((history) => {
      const next = [...history];
      const previous = next.pop();
      setSelectedMenu(previous ?? "home");
      setForwardHistory((future) => [...future, selectedMenu ?? "home"]);
      return next;
    });
  };
  const navigateForward = () => {
    setForwardHistory((future) => {
      const next = [...future];
      const target = next.pop();
      if (target) { setMenuHistory((history) => [...history, selectedMenu ?? "home"]); setSelectedMenu(target); }
      return next;
    });
  };
  const handleSettingsClosed = (section: "appearance" | "model") => setForwardSettings(section);
  const navigateForwardSettings = () => { if (!forwardSettings) return; const section = forwardSettings; setForwardSettings(null); setSettingsRequest(null); window.setTimeout(() => setSettingsRequest(section), 0); };
  const toggleServerPin = (id: string) => setServers((current) => current.map((server) => server.id === id ? { ...server, pinned: !server.pinned } : server));
  const updateServerServices = React.useCallback((serverId: string, services: DiscoveredServiceSummary[]) => {
    setServers((current) => current.map((server) => server.id === serverId ? { ...server, services } : server));
  }, []);
  const handleServerSaved = (server: ServerSummary) => { if (server.password) void invoke("save_server_credential", { serverId: server.id, password: server.password }); setServers((current) => current.some((item) => item.id === server.id) ? current.map((item) => item.id === server.id ? server : item) : [...current, server]); setEditingServer(null); navigate("home"); };
  const handleConversationalServerAdded = async (server: ServerSummary) => {
    if (server.password) await invoke("save_server_credential", { serverId: server.id, password: server.password });
    setServers((current) => current.some((item) => item.id === server.id) ? current.map((item) => item.id === server.id ? server : item) : [...current, server]);
  };
  const openModelSettings = () => { setForwardSettings(null); setSettingsRequest(null); window.setTimeout(() => setSettingsRequest("model"), 0); };
  const openServerTerminal = (id: string) => { if (selectedMenu !== `server-${id}`) navigate(`server-${id}`); window.setTimeout(() => window.dispatchEvent(new CustomEvent("opsnest-open-ssh", { detail: { serverId: id } })), 0); };
  const openServerFiles = (id: string) => { if (selectedMenu !== `server-${id}`) navigate(`server-${id}`); setOpenFileManagerSignal((value) => value + 1); };
  const closeEmptyFileManager = React.useCallback(() => setCloseFileManagerSignal((value) => value + 1), []);
  const updateConnectionState = React.useCallback((serverId: string, connected: boolean) => {
    setServers((current) => current.map((item) => item.id === serverId ? { ...item, connected } : item));
  }, []);
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ serverId?: string; connected?: boolean }>).detail;
      if (detail?.serverId && typeof detail.connected === "boolean") updateConnectionState(detail.serverId, detail.connected);
    };
    window.addEventListener("opsnest-server-connection-state", handler);
    return () => window.removeEventListener("opsnest-server-connection-state", handler);
  }, [updateConnectionState]);
  const scanServer = async (server: ServerSummary, passwordOverride?: string) => {
    const at = server.host.indexOf("@");
    const username = at > 0 ? server.host.slice(0, at) : "root";
    const host = at > 0 ? server.host.slice(at + 1) : server.host;
    const inspect = (password?: string) => invoke<{ system: string; hostname: string; cpu: string; memory: string; disk: string; docker: string }>("inspect_linux_server", { request: { host, port: server.port, username, authMethod: server.authMethod ?? "password", password: password ?? null, privateKeyPath: null, passphrase: null } });
    try {
      const storedPassword = passwordOverride ?? server.password ?? await invoke<string | null>("load_server_credential", { serverId: server.id }).catch(() => null);
      let result;
      try { result = await inspect(storedPassword ?? undefined); }
      catch (firstError) {
        if ((server.authMethod ?? "password") !== "password") throw firstError;
        if (!passwordOverride) { throw firstError; }
        result = await inspect(passwordOverride);
        void invoke("save_server_credential", { serverId: server.id, password: passwordOverride }).catch(() => undefined);
        setServers((current) => current.map((item) => item.id === server.id ? { ...item, password: passwordOverride } : item));
      }
      setServers((current) => current.map((item) => item.id === server.id ? { ...item, connected: true, system: result.system, cpu: result.cpu, memory: result.memory, disk: result.disk, docker: result.docker } : item));
    } catch (error) {
      void writeDebugLog("error", "linux server scan failed", { serverId: server.id, error: String(error) });
    }
  };
  const selectedLabel = selectedMenu === "manager" ? (isEnglish ? "Server Manager" : "服务器总管")
    : selectedMenu === "tasks" ? (isEnglish ? "Task history" : "任务记录")
      : selectedMenu === "cron" ? (isEnglish ? "Scheduled tasks" : "定时任务")
        : selectedMenu === "activity" ? (isEnglish ? "Activity log" : "活动日志")
          : selectedMenu?.endsWith("-add") ? (isEnglish ? "Add server" : "添加服务器")
            : selectedMenu?.startsWith("pinned-") || selectedMenu?.startsWith("server-") ? (isEnglish ? "Server placeholder" : "服务器占位页")
          : "";

  const selectedServer = selectedMenu?.startsWith("server-") ? servers.find((server) => server.id === selectedMenu.slice("server-".length)) : undefined;
  const updateSelectedServerServices = React.useCallback((services: DiscoveredServiceSummary[]) => {
    if (selectedServer) updateServerServices(selectedServer.id, services);
  }, [selectedServer?.id, updateServerServices]);
  React.useEffect(() => { if (selectedServer && !selectedServer.cpu) void scanServer(selectedServer); }, [selectedServer?.id]);
  const pageTitle = selectedServer ? `${selectedServer.name} · ${selectedServer.host}:${selectedServer.port} · ${selectedServer.connected ? (isEnglish ? "Connected" : "已连接") : (isEnglish ? "Not connected" : "未连接")}` : selectedMenu === "home" ? (isEnglish ? "Home" : "首页") : selectedLabel;

  return (
    <>
    <ShellLayout
      title={selectedMenu === "server-edit" ? (isEnglish ? "Edit server" : "编辑服务器") : pageTitle}
      appName="OpsNest"
      language={appearance.language}
      showMenuBar={false}
      closeAction={appearance.closeAction}
      settings={<AppearanceSettings value={appearance} onChange={setAppearance} />}
      modelSettings={<ModelSettingsPanel value={model} onChange={setModel} />}
      left={<ShellNavigation language={appearance.language} selected={selectedMenu} onSelect={navigate} servers={servers} onTogglePin={toggleServerPin} onRename={(id) => navigate(`__edit:${id}`)} onOpenSsh={(id) => { navigate(`server-${id}`); window.setTimeout(() => window.dispatchEvent(new CustomEvent("opsnest-open-ssh", { detail: { serverId: id } })), 0); }} />}
      main={selectedMenu === "manager" ? <ServerManagerPage language={appearance.language} servers={servers} onSelect={navigate} onConfigureModel={openModelSettings} onServerAdded={handleConversationalServerAdded} debugLogging={appearance.debugLogging} /> : selectedMenu === "tasks" ? <TaskHistoryPage /> : selectedMenu === "cron" ? <FeaturePage title={isEnglish ? "Scheduled tasks" : "定时任务"} description={isEnglish ? "Scheduled server tasks will appear here." : "已创建的服务器定时任务会显示在这里。"} /> : selectedMenu ? <FeaturePage title={selectedLabel} description={isEnglish ? "This area is ready for its feature module." : "此区域已准备好接入对应功能。"} /> : <EmptySlot label={isEnglish ? "OpsNest main area" : "OpsNest main area"} />}
      right={selectedServer ? <FileManagerPanel server={selectedServer} servers={servers} openSignal={openFileManagerSignal} onEmpty={closeEmptyFileManager} /> : <EmptySlot label={isEnglish ? "Side panel reserved" : "侧栏功能暂未规划"} />}
      {...({ [selectedMenu === "home" || selectedMenu === "server-add" || selectedMenu === "server-edit" || selectedServer ? "main" : "__homeMainDisabled"]: selectedMenu === "server-add" ? <ServerForm language={appearance.language} onSaved={handleServerSaved} /> : selectedMenu === "server-edit" && editingServer ? <ServerForm language={appearance.language} initialServer={editingServer} onSaved={handleServerSaved} /> : selectedServer ? <LinuxServerHome language={appearance.language} server={selectedServer} model={model} onScan={() => void scanServer(selectedServer)} onOpenTerminal={() => openServerTerminal(selectedServer.id)} onOpenFiles={() => openServerFiles(selectedServer.id)} onServicesUpdated={updateSelectedServerServices} /> : <HomePage language={appearance.language} onSelect={navigate} onConfigureModel={openModelSettings} onOpenManagerBottom={() => setOpenManagerBottomSignal((value) => value + 1)} onOpenTerminal={openServerTerminal} onOpenFiles={openServerFiles} servers={servers} aiConfigured={Boolean(model.baseUrl.trim())} /> })}
      settingsRequest={settingsRequest}
      onNavigateBack={navigateBack}
      canNavigateBack={menuHistory.length > 0}
      onNavigateForward={forwardSettings ? navigateForwardSettings : navigateForward}
      canNavigateForward={Boolean(forwardSettings) || forwardHistory.length > 0}
      onSettingsClosed={handleSettingsClosed}
      openBottomSignal={openManagerBottomSignal}
      openRightSignal={openFileManagerSignal}
      closeRightSignal={closeFileManagerSignal}
      bottomRouteKey={selectedMenu}
      bottom={selectedMenu === "home" ? <ServerManagerPage language={appearance.language} servers={servers} onSelect={navigate} onConfigureModel={openModelSettings} onServerAdded={handleConversationalServerAdded} debugLogging={appearance.debugLogging} model={model} /> : selectedServer ? <TerminalWorkspace server={selectedServer} servers={servers} model={model} /> : null}
    />
    {renameTarget && <div className="rename-modal-backdrop" role="presentation"><section className="rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-title"><h2 id="rename-title">重命名服务器</h2><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { const name = renameDraft.trim(); if (name) setServers((current) => current.map((item) => item.id === renameTarget.id ? { ...item, name } : item)); setRenameTarget(null); } }} /><div className="rename-modal-actions"><button className="secondary" type="button" onClick={() => setRenameTarget(null)}>取消</button><button className="primary" type="button" onClick={() => { const name = renameDraft.trim(); if (name) setServers((current) => current.map((item) => item.id === renameTarget.id ? { ...item, name } : item)); setRenameTarget(null); }}>确定</button></div></section></div>}
    {passwordTarget && <div className="rename-modal-backdrop" role="presentation"><section className="rename-modal" role="dialog" aria-modal="true" aria-labelledby="password-title"><h2 id="password-title">SSH 登录需要密码</h2><input autoFocus type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && passwordDraft) { const target = passwordTarget; setPasswordTarget(null); void scanServer(target, passwordDraft); } }} placeholder="请输入 SSH 密码" /><div className="rename-modal-actions"><button className="secondary" type="button" onClick={() => setPasswordTarget(null)}>取消</button><button className="primary" type="button" disabled={!passwordDraft} onClick={() => { const target = passwordTarget; setPasswordTarget(null); void scanServer(target, passwordDraft); }}>确认扫描</button></div></section></div>}
    </>
  );
}

export default App;
