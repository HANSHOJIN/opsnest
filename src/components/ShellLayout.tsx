import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { readPortableJson, writePortableJson } from "../services/portableStorage";
import {
  ArrowLeft,
  ArrowRight,
  Activity,
  CalendarClock,
  ClipboardList,
  Copy,
  House,
  ChevronUp,
  CircleHelp,
  ChevronDown,
  MessageSquare,
  Maximize2,
  Minimize2,
  Minus,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pin,
  Plus,
  Server,
  Settings,
  Square,
  Sun,
  X,
} from "lucide-react";

type DragKind = "left" | "right" | "bottom";

export type ShellLayoutProps = {
  title?: string;
  appName?: string;
  language?: "zh-CN" | "en";
  showMenuBar?: boolean;
  closeAction?: "tray" | "exit";
  left: ReactNode;
  main: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
  settings?: ReactNode;
  modelSettings?: ReactNode;
  settingsRequest?: "appearance" | "model" | null;
  onNavigateBack?: () => void;
  canNavigateBack?: boolean;
  onNavigateForward?: () => void;
  canNavigateForward?: boolean;
  onSettingsClosed?: (section: "appearance" | "model") => void;
  openBottomSignal?: number;
  openRightSignal?: number;
  closeRightSignal?: number;
  bottomRouteKey?: string | null;
};

export type DiscoveredServiceSummary = { id: string; name: string; kind: string; status: string; detail: string; port?: number; webPath?: string; webScheme?: "http" | "https"; version?: string; customLabel?: string };
export type ServerSummary = { id: string; name: string; host: string; port: number; authMethod?: "password" | "key"; password?: string; sudoConfigured?: boolean; pinned?: boolean; connected?: boolean; system?: string; kernel?: string; cpu?: string; cpuModel?: string; memory?: string; disk?: string; docker?: string; services?: DiscoveredServiceSummary[]; router?: { model?: string; firmware?: string; kernel?: string; wanIp?: string; lanIp?: string; lanClients?: string; wifiClients?: string } };

export function ShellNavigation({ language = "zh-CN", selected, onSelect, servers: serverSummaries = [], onTogglePin, onRename, onToggleConnection, onDelete, onOpenSsh }: { language?: "zh-CN" | "en"; selected?: string | null; onSelect?: (id: string) => void; servers?: ServerSummary[]; onTogglePin?: (id: string) => void; onRename?: (id: string) => void; onToggleConnection?: (id: string) => void; onDelete?: (id: string) => void; onOpenSsh?: (id: string) => void }) {
  const isEnglish = language === "en";
  const [openGroups, setOpenGroups] = useState({ pinned: true, servers: true });
  const toggle = (group: "pinned" | "servers") => setOpenGroups((value) => ({ ...value, [group]: !value[group] }));
  const displayServers = serverSummaries.length > 0 ? serverSummaries.map((server) => server.name) : (isEnglish ? ["Server A", "Server B", "Router", "NAS"] : ["服务器 A", "服务器 B", "路由器", "NAS"]);

  if (true) {
    const pinned = serverSummaries.filter((server) => server.pinned);
    return <nav className="left-navigation" aria-label={isEnglish ? "Shell navigation" : "导航"}>
      <button className={`nav-item ${selected === "home" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("home")}><House size={15} /><span>{isEnglish ? "Home" : "首页"}</span></button>
      <button className={`nav-item ${selected === "manager" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("manager")}><MessageSquare size={15} /><span>{isEnglish ? "Server Manager" : "服务器总管"}</span></button>
      <button className={`nav-item ${selected === "tasks" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("tasks")}><ClipboardList size={15} /><span>{isEnglish ? "Task history" : "任务记录"}</span></button>
      <button className={`nav-item ${selected === "cron" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("cron")}><CalendarClock size={15} /><span>{isEnglish ? "Scheduled tasks" : "定时任务"}</span></button>
      {pinned.length > 0 && <ServerNavGroup label={isEnglish ? "Pinned" : "置顶"} servers={pinned} selected={selected} onSelect={onSelect} onTogglePin={onTogglePin} onRename={onRename} onToggleConnection={onToggleConnection} onDelete={onDelete} onOpenSsh={onOpenSsh} />}
      <ServerNavGroup label={isEnglish ? "My servers" : "我的服务器"} servers={serverSummaries} selected={selected} onSelect={onSelect} onTogglePin={onTogglePin} onRename={onRename} onToggleConnection={onToggleConnection} onDelete={onDelete} onOpenSsh={onOpenSsh} addLabel={isEnglish ? "Add server" : "添加服务器"} />
    </nav>;
  }
  const pinnedServers = isEnglish ? ["Server A", "Router"] : ["服务器 A", "路由器"];
  const servers = isEnglish ? ["Server A", "Server B", "Router", "NAS"] : ["服务器 A", "服务器 B", "路由器", "NAS"];

  return (
    <nav className="left-navigation" aria-label={isEnglish ? "Shell navigation" : "壳导航"}>
      <button className={`nav-item ${selected === "manager" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("manager")}><MessageSquare size={15} /><span>{isEnglish ? "Server Manager" : "服务器总管"}</span></button>
      <button className={`nav-item ${selected === "tasks" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("tasks")}><ClipboardList size={15} /><span>{isEnglish ? "Task history" : "任务记录"}</span></button>
      <button className={`nav-item ${selected === "cron" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("cron")}><CalendarClock size={15} /><span>{isEnglish ? "Scheduled tasks" : "定时任务"}</span></button>
      <NavGroup label={isEnglish ? "Pinned" : "置顶"} icon={<Pin size={14} />} open={openGroups.pinned} onToggle={() => toggle("pinned")} items={pinnedServers} onSelect={onSelect} groupId="pinned" selected={selected} />
      <NavGroup label={isEnglish ? "My servers" : "我的服务器"} icon={<Server size={14} />} open={openGroups.servers} onToggle={() => toggle("servers")} items={servers} onSelect={onSelect} groupId="server" selected={selected} trailingAction={<Plus size={15} />} trailingLabel={isEnglish ? "Add server" : "添加服务器"} />
      <button className={`nav-item ${selected === "activity" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("activity")}><Activity size={15} /><span>{isEnglish ? "Activity log" : "活动日志"}</span></button>
      <button className={`nav-item ${selected === "home" ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.("home")}><House size={15} /><span>{isEnglish ? "Home" : "首页"}</span></button>
    </nav>
  );
}

function ServerNavGroup({ label, servers, selected, onSelect, onTogglePin, onRename = (id) => onSelect?.(`__rename:${id}`), onToggleConnection = (id) => onSelect?.(`__connect:${id}`), onDelete = (id) => onSelect?.(`__delete:${id}`), onOpenSsh, addLabel }: { label: string; servers: ServerSummary[]; selected?: string | null; onSelect?: (id: string) => void; onTogglePin?: (id: string) => void; onRename?: (id: string) => void; onToggleConnection?: (id: string) => void; onDelete?: (id: string) => void; onOpenSsh?: (id: string) => void; addLabel?: string }) {
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => { const close = () => setContext(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, []);
  const target = context ? servers.find((server) => server.id === context.id) : undefined;
  return <section className={`server-nav-group ${open ? "is-open" : "is-collapsed"}`}><div className="server-nav-heading"><button className="server-nav-heading-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>{label}</span><ChevronDown className="server-nav-heading-chevron" size={13} /></button>{addLabel && <button className="nav-group-action" type="button" onClick={() => onSelect?.("server-add")} aria-label={addLabel}><Plus size={15} /></button>}</div><div className="server-nav-group-content"><div className="server-nav-group-content-inner">{servers.map((server) => <div className="server-nav-row" key={server.id}><button className={`nav-subitem ${selected === `server-${server.id}` ? "is-selected" : ""}`} type="button" onContextMenu={(event) => { event.preventDefault(); setContext({ id: server.id, x: event.clientX, y: event.clientY }); }} onClick={() => onSelect?.(`server-${server.id}`)}><span className={`server-status-dot ${server.connected ? "is-connected" : "is-disconnected"}`} /><span>{server.name}</span></button><button className={`server-pin-button ${server.pinned ? "is-pinned" : ""}`} type="button" onClick={() => onTogglePin?.(server.id)} aria-label={server.pinned ? "取消置顶" : "置顶"}><Pin size={13} /></button></div>)}</div></div>{context && target && <div className="server-context-menu" style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}><button type="button" onClick={() => { onTogglePin?.(target.id); setContext(null); }}>{target.pinned ? "取消置顶" : "置顶"}</button><button type="button" onClick={() => { onRename?.(target.id); setContext(null); }}>编辑</button><button type="button" onClick={() => { onToggleConnection?.(target.id); setContext(null); }}>{target.connected ? "断开" : "连接"}</button><button type="button" onClick={() => { onSelect?.(`server-${target.id}`); onOpenSsh?.(target.id); setContext(null); }}>SSH</button><button className="is-danger" type="button" onClick={() => { onDelete?.(target.id); setContext(null); }}>删除</button></div>}</section>;
}

function LegacyServerNavGroup({ label, servers, selected, onSelect, onTogglePin, onRename, onToggleConnection, onDelete, addLabel }: { label: string; servers: ServerSummary[]; selected?: string | null; onSelect?: (id: string) => void; onTogglePin?: (id: string) => void; onRename?: (id: string) => void; onToggleConnection?: (id: string) => void; onDelete?: (id: string) => void; onOpenSsh?: (id: string) => void; addLabel?: string }) {
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => { const close = () => setContext(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, []);
  return <section className="server-nav-group"><div className="server-nav-heading"><span>{label}</span>{addLabel && <button className="nav-group-action" type="button" onClick={() => onSelect?.("server-add")} aria-label={addLabel}><Plus size={15} /></button>}</div>{servers.map((server) => <div className="server-nav-row" key={server.id}><button className={`nav-subitem ${selected === `server-${server.id}` ? "is-selected" : ""}`} type="button" onClick={() => onSelect?.(`server-${server.id}`)}><span className={`server-status-dot ${server.connected ? "is-connected" : "is-disconnected"}`} title={server.connected ? "已连接" : "未连接"} /> <span>{server.name}</span></button><button className={`server-pin-button ${server.pinned ? "is-pinned" : ""}`} type="button" onClick={() => onTogglePin?.(server.id)} aria-label={server.pinned ? "取消置顶" : "置顶"} title={server.pinned ? "取消置顶" : "置顶"}><Pin size={13} /></button></div>)}</section>;
}

function NavGroup({ label, icon, open, onToggle, items, onSelect, groupId, selected, trailingAction, trailingLabel }: { label: string; icon: ReactNode; open: boolean; onToggle: () => void; items: string[]; onSelect?: (id: string) => void; groupId: string; selected?: string | null; trailingAction?: ReactNode; trailingLabel?: string }) {
  return (
    <div className={`nav-group ${open ? "is-open" : ""}`}>
      <div className="nav-group-heading">
        <button className="nav-group-button" type="button" onClick={onToggle} aria-expanded={open}>
          {icon}<span>{label}</span><ChevronDown className="nav-group-chevron" size={13} />
        </button>
        {trailingAction && <button className="nav-group-action" type="button" onClick={() => onSelect?.(`${groupId}-add`)} title={trailingLabel} aria-label={trailingLabel}>{trailingAction}</button>}
      </div>
      <div className="nav-group-content" aria-hidden={!open}>
        <div className="nav-group-content-inner">
          {items.map((item, index) => { const id = `${groupId}-${index + 1}`; return <button className={`nav-subitem ${selected === id ? "is-selected" : ""}`} type="button" key={id} onClick={() => onSelect?.(id)}><span>{item}</span></button>; })}
        </div>
      </div>
    </div>
  );
}

const LEFT_DEFAULT = 260;
const RIGHT_NARROW = 320;
const RIGHT_STANDARD = 420;
const RIGHT_EXPANDED_THRESHOLD = 600;
const RIGHT_DEFAULT = RIGHT_STANDARD;
const BOTTOM_DEFAULT = 210;
const MIN_SIDE = 190;
const MIN_BOTTOM = 120;
const LAYOUT_FILE = "layout.json";

type LayoutState = {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function snapRightWidth(value: number) {
  return value < (RIGHT_NARROW + RIGHT_STANDARD) / 2 ? RIGHT_NARROW : RIGHT_STANDARD;
}

function IconButton({ label, onClick, children, className = "" }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button className={`icon-button ${className}`} type="button" onClick={(event) => { event.stopPropagation(); onClick(); }} title={label} aria-label={label}>
      {children}
    </button>
  );
}

function WindowButton({ label, onClick, children, danger = false }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button className={`window-button${danger ? " danger" : ""}`} onClick={onClick} aria-label={label} title={label}>
      {children}
    </button>
  );
}

function SidebarFooter({ onSettings, language }: { onSettings: () => void; language: "zh-CN" | "en" }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const isEnglish = language === "en";

  return (
    <div className="sidebar-footer">
      {menuOpen && (
        <div className="sidebar-menu" role="menu">
          <button className="sidebar-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); onSettings(); }}>
            <Settings className="sidebar-menu-icon" size={15} />
            <span>{isEnglish ? "Settings" : "设置"}</span>
          </button>
        </div>
      )}
      {versionOpen && (
        <div className="sidebar-help-menu" role="menu">
          <button className="sidebar-menu-item" role="menuitem" onClick={() => { setVersionOpen(false); setAboutOpen(true); }}>
            <CircleHelp className="sidebar-menu-icon" size={15} />
            <span>{isEnglish ? "About OpsNest" : "关于 OpsNest"}</span>
          </button>
        </div>
      )}
      <div className="sidebar-footer-row">
        <button className="sidebar-account" onClick={() => { setVersionOpen(false); setMenuOpen((value) => !value); }} aria-expanded={menuOpen}>
          <span className="sidebar-avatar">ON</span>
          <span>OpsNest</span>
          <ChevronUp className={menuOpen ? "" : "is-down"} size={14} />
        </button>
        <button className="sidebar-help" title={isEnglish ? "Help" : "帮助"} aria-label={isEnglish ? "Help" : "帮助"} aria-expanded={versionOpen} onClick={() => { setMenuOpen(false); setVersionOpen((value) => !value); }}>
          <CircleHelp size={15} strokeWidth={1.7} />
        </button>
      </div>
      {aboutOpen && createPortal((
        <div className="about-backdrop" role="presentation" onMouseDown={() => setAboutOpen(false)}>
          <section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="about-close" type="button" aria-label={isEnglish ? "Close" : "关闭"} onClick={() => setAboutOpen(false)}><X size={15} /></button>
            <div className="about-mark">ON</div>
            <h2 id="about-title">OpsNest</h2>
            <p className="about-version">OpsNest 0.2.0-alpha.4</p>
            <p className="about-credit">{isEnglish ? "AI-integrated server management." : "集成 AI 的服务器管理工具。"}</p>
            <a className="about-link" href="https://github.com/HANSHOJIN/opsnest" target="_blank" rel="noreferrer">github.com/HANSHOJIN/opsnest</a>
            <p className="about-license">{isEnglish ? "OpsNest is open source and free to use. Please keep the project name and source address when using it, so more people can discover the project. Thank you." : "OpsNest 是开源且免费的软件。使用或再发布时，请保留项目名称和源码地址，让更多人可以找到这个项目。谢谢。"}</p>
            <p className="about-powered">{isEnglish ? "Built on the CodexShell desktop shell." : "基于 CodexShell 桌面外壳构建。"}</p>
            <a className="about-link" href="https://github.com/HANSHOJIN/codex-shell" target="_blank" rel="noreferrer">github.com/HANSHOJIN/codex-shell</a>
            <p className="about-copyright">© 2026 OpsNest</p>
          </section>
        </div>
      ), document.body)}
    </div>
  );
}

function SettingsSidebar({ onBack, language, section, onSectionChange }: { onBack: () => void; language: "zh-CN" | "en"; section: "appearance" | "model"; onSectionChange: (section: "appearance" | "model") => void }) {
  const isEnglish = language === "en";
  return (
    <div className="settings-sidebar" aria-label={isEnglish ? "Settings navigation" : "设置导航"}>
      <button className="settings-return" onClick={onBack}>
        <ArrowLeft size={14} />
        <span>{isEnglish ? "Back to app" : "返回应用"}</span>
      </button>
      <div className="settings-nav-label">{isEnglish ? "Settings" : "设置"}</div>
      <button className={`settings-nav-item ${section === "appearance" ? "is-selected" : ""}`} aria-current={section === "appearance" ? "page" : undefined} onClick={() => onSectionChange("appearance")}>
        <Sun size={15} />
        <span>{isEnglish ? "Appearance" : "外观"}</span>
      </button>
      <button className={`settings-nav-item ${section === "model" ? "is-selected" : ""}`} aria-current={section === "model" ? "page" : undefined} onClick={() => onSectionChange("model")}>
        <MessageSquare size={15} />
        <span>{isEnglish ? "AI model" : "AI 模型"}</span>
      </button>
    </div>
  );
}

function ShellLayout({ title = "OpsNest", appName = "OpsNest", language = "zh-CN", showMenuBar = true, closeAction = "tray", left, main, right, bottom, settings, modelSettings, settingsRequest, onNavigateBack, canNavigateBack = false, onNavigateForward, canNavigateForward = false, onSettingsClosed, openBottomSignal = 0, openRightSignal = 0, closeRightSignal = 0, bottomRouteKey = null }: ShellLayoutProps) {
  const isEnglish = language === "en";
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightFullscreen, setRightFullscreen] = useState(false);
  const [rightFullscreenBottomOpen, setRightFullscreenBottomOpen] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomFullscreen, setBottomFullscreen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [bottomHeight, setBottomHeight] = useState(BOTTOM_DEFAULT);
  const [isMaximized, setIsMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"appearance" | "model">("appearance");
  const rightWidthRef = useRef(RIGHT_DEFAULT);
  rightWidthRef.current = rightWidth;
  useEffect(() => {
    const windowHandle = getCurrentWindow();
    let disposed = false;
    const syncMaximizedState = async () => {
      const maximized = await windowHandle.isMaximized();
      if (!disposed) setIsMaximized(maximized);
    };
    void syncMaximizedState();
    let unlisten: (() => void) | undefined;
    void windowHandle.onResized(() => { void syncMaximizedState(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!settingsRequest) return;
    setSettingsSection(settingsRequest);
    setSettingsOpen(true);
  }, [settingsRequest]);
  useEffect(() => {
    if (bottom == null) {
      setBottomOpen(false);
      setBottomFullscreen(false);
      setRightFullscreenBottomOpen(false);
    }
  }, [bottom]);
  const lastOpenBottomSignal = useRef(0);
  useEffect(() => {
    if (openBottomSignal !== lastOpenBottomSignal.current) {
      lastOpenBottomSignal.current = openBottomSignal;
      if (openBottomSignal > 0 && bottom != null) setBottomOpen(true);
    }
  }, [openBottomSignal, bottom]);
  const lastOpenRightSignal = useRef(0);
  useEffect(() => {
    if (openRightSignal !== lastOpenRightSignal.current) {
      lastOpenRightSignal.current = openRightSignal;
      if (openRightSignal > 0 && right != null) {
        setRightOpen(true);
        setRightFullscreen(false);
        setRightFullscreenBottomOpen(false);
      }
    }
  }, [openRightSignal, right]);
  const lastCloseRightSignal = useRef(0);
  useEffect(() => {
    if (closeRightSignal !== lastCloseRightSignal.current) {
      lastCloseRightSignal.current = closeRightSignal;
      if (closeRightSignal > 0) {
        setRightOpen(false);
        setRightFullscreen(false);
        setRightFullscreenBottomOpen(false);
      }
    }
  }, [closeRightSignal]);
  useEffect(() => {
    setBottomFullscreen(false);
    setBottomOpen(false);
  }, [bottomRouteKey]);
  useEffect(() => {
    const openTerminal = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".server-profile-banner .primary, .open-terminal-action, .open-manager-action")) setBottomOpen(true);
    };
    document.addEventListener("click", openTerminal, true);
    const openSsh = () => {
      setBottomOpen(true);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("opsnest-focus-ssh-terminal")), 0);
    };
    const openManager = () => setBottomOpen(true);
    const closeSsh = () => { setBottomFullscreen(false); setBottomOpen(false); };
    const closeFiles = () => {
      setRightOpen(false);
      setRightFullscreen(false);
      setRightFullscreenBottomOpen(false);
    };
    window.addEventListener("opsnest-open-ssh", openSsh);
    window.addEventListener("opsnest-open-manager", openManager);
    window.addEventListener("opsnest-close-ssh", closeSsh);
    window.addEventListener("opsnest-close-files", closeFiles);
    return () => { document.removeEventListener("click", openTerminal, true); window.removeEventListener("opsnest-open-ssh", openSsh); window.removeEventListener("opsnest-open-manager", openManager); window.removeEventListener("opsnest-close-ssh", closeSsh); window.removeEventListener("opsnest-close-files", closeFiles); };
  }, []);
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void readPortableJson<Partial<LayoutState>>(LAYOUT_FILE, {}).then((saved) => {
      if (!active) return;
      setLeftOpen(saved.leftOpen ?? true);
      setRightOpen(saved.rightOpen ?? false);
      // Always start with the bottom panel collapsed. Its open state is a
      // transient session choice and should not surprise the user on launch.
      setBottomOpen(false);
      setLeftWidth(saved.leftWidth ?? LEFT_DEFAULT);
      setRightWidth(snapRightWidth(saved.rightWidth ?? RIGHT_DEFAULT));
      setBottomHeight(saved.bottomHeight ?? BOTTOM_DEFAULT);
      setLayoutLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const keepLayoutInsideWindow = () => {
      const bounds = shell.getBoundingClientRect();
      const openSides = Number(leftOpen) + Number(rightOpen);
      if (openSides > 0) {
        const availableForSides = Math.max(MIN_SIDE * openSides, bounds.width - 240);
        if (leftOpen && rightOpen && leftWidth + rightWidth > availableForSides) {
          const ratio = leftWidth / (leftWidth + rightWidth);
          const nextLeft = clamp(availableForSides * ratio, MIN_SIDE, availableForSides - MIN_SIDE);
          setLeftWidth(Math.round(nextLeft));
          setRightWidth(Math.round(availableForSides - nextLeft));
        } else if (leftOpen && !rightOpen) {
          setLeftWidth((value) => Math.min(value, availableForSides));
        } else if (rightOpen && !leftOpen) {
          setRightWidth((value) => Math.min(value, availableForSides));
        }
      }

      if (bottomOpen) {
        setBottomHeight((value) => Math.min(value, Math.max(MIN_BOTTOM, bounds.height - 44)));
      }
    };

    keepLayoutInsideWindow();
    const observer = new ResizeObserver(keepLayoutInsideWindow);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [bottomOpen, leftOpen, leftWidth, rightOpen, rightWidth]);

  const startDrag = useCallback((kind: DragKind, event: React.PointerEvent) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDragging(kind);
  }, []);

  const toggleBottomFullscreen = useCallback(() => {
    if (bottomFullscreen) {
      setBottomFullscreen(false);
      setBottomHeight(BOTTOM_DEFAULT);
      return;
    }
    const shellHeight = shellRef.current?.getBoundingClientRect().height ?? 600;
    setBottomOpen(true);
    setBottomFullscreen(true);
    setBottomHeight(Math.max(MIN_BOTTOM, shellHeight - 44));
  }, [bottomFullscreen]);

  const toggleRightFullscreen = useCallback(() => {
    setRightOpen(true);
    setRightFullscreen((value) => {
      if (value) {
        setRightFullscreenBottomOpen(false);
        setBottomOpen(false);
        setBottomFullscreen(false);
        setRightWidth(RIGHT_STANDARD);
      }
      else {
        setBottomOpen(false);
        setBottomFullscreen(false);
      }
      return !value;
    });
  }, []);

  const toggleRightBottom = useCallback(() => {
    if (rightFullscreen) {
      setRightFullscreenBottomOpen((value) => {
        const next = !value;
        setBottomOpen(next);
        if (!next) setBottomFullscreen(false);
        return next;
      });
    }
    else {
      setBottomFullscreen(false);
      setBottomOpen((value) => !value);
    }
  }, [rightFullscreen]);

  const resizeWithKeyboard = useCallback((kind: DragKind, event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 8;
    let handled = true;
    if (kind === "left") {
      if (event.key === "ArrowRight") setLeftWidth((value) => clamp(value + step, MIN_SIDE, 420));
      else if (event.key === "ArrowLeft") setLeftWidth((value) => clamp(value - step, MIN_SIDE, 420));
      else if (event.key === "Home") setLeftOpen(false);
      else if (event.key === "End") { setLeftOpen(true); setLeftWidth(420); }
      else handled = false;
    } else if (kind === "right") {
      if (event.key === "ArrowLeft") setRightWidth((value) => clamp(value + step, RIGHT_NARROW, RIGHT_STANDARD));
      else if (event.key === "ArrowRight") setRightWidth((value) => clamp(value - step, RIGHT_NARROW, RIGHT_STANDARD));
      else if (event.key === "Home") setRightOpen(false);
      else if (event.key === "End") { setRightOpen(true); setRightFullscreen(true); }
      else handled = false;
    } else {
      if (event.key === "ArrowUp") setBottomHeight((value) => clamp(value + step, MIN_BOTTOM, 600));
      else if (event.key === "ArrowDown") { setBottomFullscreen(false); setBottomHeight((value) => clamp(value - step, MIN_BOTTOM, 1200)); }
      else if (event.key === "Home") { setBottomFullscreen(false); setBottomOpen(false); }
      else if (event.key === "End") { setBottomOpen(true); setBottomFullscreen(true); setBottomHeight(1200); }
      else handled = false;
    }
    if (handled) event.preventDefault();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const bounds = shellRef.current?.getBoundingClientRect();
      if (!bounds) return;
      if (dragging === "left") {
        const next = event.clientX - bounds.left;
        if (next < MIN_SIDE * 0.62) { setDragging(null); setLeftOpen(false); }
        else { setLeftOpen(true); setLeftWidth(clamp(next, MIN_SIDE, 420)); }
      }
      if (dragging === "right") {
        const next = bounds.right - event.clientX;
        if (next < MIN_SIDE * 0.62) { setDragging(null); setRightOpen(false); }
        else {
          setRightOpen(true);
          setRightFullscreen(false);
          // Follow the pointer continuously. The final width is snapped only
          // when the pointer is released, so the panel does not jump between
          // presets while dragging.
          setRightWidth(clamp(next, RIGHT_NARROW, RIGHT_EXPANDED_THRESHOLD + 80));
        }
      }
      if (dragging === "bottom") {
        const next = bounds.bottom - event.clientY;
        if (next < MIN_BOTTOM * 0.62) { setDragging(null); setBottomOpen(false); }
        else {
          const maxBottom = Math.max(MIN_BOTTOM, bounds.height - 44);
          const snapped = next >= maxBottom - 64;
          setBottomOpen(true);
          setBottomFullscreen(snapped);
          setBottomHeight(snapped ? maxBottom : clamp(next, MIN_BOTTOM, maxBottom));
        }
      }
    };
    const stop = () => {
      if (dragging === "right") {
        const width = rightWidthRef.current;
        if (width >= RIGHT_EXPANDED_THRESHOLD) {
          setRightFullscreen(true);
          setRightFullscreenBottomOpen(false);
          setBottomOpen(false);
          setBottomFullscreen(false);
        } else {
          setRightFullscreen(false);
          setRightWidth(snapRightWidth(width));
        }
      }
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    window.addEventListener("blur", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [dragging]);

  useEffect(() => {
    if (!layoutLoaded) return;
    void writePortableJson(LAYOUT_FILE, { leftOpen, rightOpen, bottomOpen, leftWidth, rightWidth, bottomHeight } satisfies LayoutState).catch(() => undefined);
  }, [layoutLoaded, leftOpen, rightOpen, bottomOpen, leftWidth, rightWidth, bottomHeight]);

  // xterm measures its host while the grid is still animating. Notify the
  // mounted terminal after fullscreen/height changes so it can fit and place
  // the input cursor against the final viewport instead of the old bounds.
  useEffect(() => {
    if (!bottomOpen) return;
    const timers = [0, 120, 280].map((delay) => window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("opsnest-terminal-layout-changed"));
    }, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [bottomOpen, bottomFullscreen, bottomHeight]);

  const layoutStyle = {
    "--left-width": leftOpen ? `${leftWidth}px` : "0px",
    "--right-width": rightOpen ? `${rightWidth}px` : "0px",
    "--bottom-height": bottomOpen ? `${bottomHeight}px` : "0px",
  } as React.CSSProperties;
  const rightLayoutClass = rightFullscreen ? "right-layout-expanded" : rightWidth <= RIGHT_NARROW ? "right-layout-narrow" : "right-layout-standard";

  return (
    <div className="window-shell" style={layoutStyle}>
      <header className="window-chrome" data-tauri-drag-region>
        <div className="window-chrome-left" data-tauri-drag-region>
          <WindowButton label={isEnglish ? "Toggle sidebar" : "切换左侧栏"} onClick={() => setLeftOpen((value) => !value)}><PanelLeft size={15} /></WindowButton>
          <button className={`window-button window-history ${canNavigateBack || settingsOpen ? "is-enabled" : ""}`} type="button" aria-label={isEnglish ? "Back" : "后退"} aria-disabled={!canNavigateBack && !settingsOpen} disabled={!canNavigateBack && !settingsOpen} onClick={() => { if (settingsOpen) { setSettingsOpen(false); onSettingsClosed?.(settingsSection); } else onNavigateBack?.(); }}><ArrowLeft size={15} /></button>
          <button className={`window-button window-history ${canNavigateForward ? "is-enabled" : ""}`} type="button" aria-label={isEnglish ? "Forward" : "前进"} aria-disabled={!canNavigateForward} disabled={!canNavigateForward} onClick={() => onNavigateForward?.()}><ArrowRight size={15} /></button>
          {showMenuBar && (
            <nav className="window-menu" aria-label={isEnglish ? "Application menu" : "应用菜单"}>
              {(isEnglish ? ["File", "Edit", "View", "Help"] : ["文件", "编辑", "视图", "帮助"]).map((item) => (
                <button key={item} type="button" aria-disabled="true">{item}</button>
              ))}
            </nav>
          )}
        </div>
        <div className="window-chrome-right" data-tauri-drag-region="false">
          <WindowButton label={isEnglish ? "Minimize" : "最小化"} onClick={() => void getCurrentWindow().minimize()}><Minus size={14} /></WindowButton>
          <WindowButton label={isMaximized ? (isEnglish ? "Restore" : "恢复") : (isEnglish ? "Maximize" : "最大化")} onClick={() => void getCurrentWindow().toggleMaximize()}>{isMaximized ? <Copy size={12} /> : <Square size={12} />}</WindowButton>
          <WindowButton label={isEnglish ? "Close" : "关闭"} danger onClick={() => {
            if (closeAction === "exit") void invoke("exit_app");
            else void getCurrentWindow().hide();
          }}><X size={14} /></WindowButton>
        </div>
      </header>
      <div ref={shellRef} className={`app-shell ${rightFullscreen ? "right-fullscreen" : ""} ${rightLayoutClass} ${dragging ? `is-dragging drag-${dragging}` : ""}`}>
        <aside className={`panel left-panel ${leftOpen ? "is-open" : "is-closed"}`} aria-hidden={!leftOpen} inert={!leftOpen}>
          {settingsOpen ? (
            <SettingsSidebar onBack={() => setSettingsOpen(false)} language={language} section={settingsSection} onSectionChange={setSettingsSection} />
          ) : (
            <>
              <div className="panel-toolbar left-toolbar"><span className="app-title">{appName}</span></div>
              <div className="left-content">{left}</div>
              <SidebarFooter onSettings={() => setSettingsOpen(true)} language={language} />
            </>
          )}
        </aside>

        {leftOpen && <div className="resize-handle vertical left-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整左侧栏宽度" onPointerDown={(e) => startDrag("left", e)} onKeyDown={(e) => resizeWithKeyboard("left", e)} />}

        <main className="center-area">
          <div className="center-toolbar">
            {!leftOpen && <IconButton label={isEnglish ? "Show sidebar" : "展开左侧栏"} onClick={() => setLeftOpen(true)} className="left-restore"><PanelLeft size={15} /></IconButton>}
            {!settingsOpen && title && <span className="center-label">{title}</span>}
            <div className="toolbar-actions">
              <IconButton label={isEnglish ? (bottomOpen ? "Hide bottom panel" : "Show bottom panel") : (bottomOpen ? "收起底部面板" : "展开底部面板")} onClick={() => { setBottomFullscreen(false); setBottomOpen((value) => !value); }} className={bottomOpen ? "is-active" : ""}><PanelBottom size={15} /></IconButton>
              <IconButton label={isEnglish ? (rightOpen ? "Hide files panel" : "Show files panel") : (rightOpen ? "收起文件栏" : "展开文件栏")} onClick={() => { setRightFullscreen(false); setRightFullscreenBottomOpen(false); setRightOpen((value) => !value); }} className={rightOpen ? "is-active" : ""}><PanelRight size={15} /></IconButton>
            </div>
          </div>
          <section className="main-placeholder">{settingsOpen ? (settingsSection === "model" && modelSettings ? modelSettings : settings) : main}</section>
          {bottomOpen && !rightFullscreenBottomOpen && <div className="resize-handle horizontal bottom-handle" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="调整底部面板高度" onPointerDown={(e) => startDrag("bottom", e)} onKeyDown={(e) => resizeWithKeyboard("bottom", e)} />}
          <section className={`bottom-panel ${bottomOpen && !rightFullscreenBottomOpen ? "is-open" : "is-closed"}`} aria-hidden={!bottomOpen || rightFullscreenBottomOpen}>
            <div className="bottom-toolbar" aria-label={isEnglish ? "Terminal controls" : "终端窗口操作"}>
              <div className="toolbar-actions">
                <IconButton label={isEnglish ? (bottomFullscreen ? "Restore terminal" : "Maximize terminal") : (bottomFullscreen ? "恢复终端" : "最大化终端")} onClick={toggleBottomFullscreen} className={bottomFullscreen ? "is-active" : ""}>
                  {bottomFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </IconButton>
                <IconButton label={isEnglish ? "Hide bottom panel" : "关闭底栏"} onClick={() => { setBottomFullscreen(false); setBottomOpen(false); }}>
                  <PanelBottom size={15} />
                </IconButton>
              </div>
            </div>
            {bottom}
          </section>
        </main>

        {rightOpen && !rightFullscreen && <div className="resize-handle vertical right-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整右侧栏宽度" onPointerDown={(e) => startDrag("right", e)} onKeyDown={(e) => resizeWithKeyboard("right", e)} />}
        <aside className={`panel right-panel ${rightOpen ? "is-open" : "is-closed"} ${rightFullscreen ? "is-fullscreen" : ""}`} aria-hidden={!rightOpen} inert={!rightOpen}>
          <div className="panel-toolbar right-toolbar">
            <span>{isEnglish ? "Files" : "文件"}</span>
            <div className="toolbar-actions">
              <IconButton label={rightFullscreen ? (isEnglish ? "Restore files panel" : "退出文件栏全屏") : (isEnglish ? "Maximize files panel" : "文件栏全屏")} onClick={() => {
                if (!rightFullscreen) {
                  // A right-panel fullscreen view owns the viewport. Clear the
                  // ordinary bottom panel first so its content cannot remain
                  // mounted underneath and steal the lower layout row.
                  setBottomOpen(false);
                  setBottomFullscreen(false);
                }
                toggleRightFullscreen();
              }} className={rightFullscreen ? "is-active" : ""}>{rightFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</IconButton>
              <IconButton label={(rightFullscreen ? rightFullscreenBottomOpen : bottomOpen) ? (isEnglish ? "Hide bottom panel" : "收起底部面板") : (isEnglish ? "Show bottom panel" : "呼出底部面板")} onClick={toggleRightBottom} className={(rightFullscreen ? rightFullscreenBottomOpen : bottomOpen) ? "is-active" : ""}><PanelBottom size={15} /></IconButton>
              <IconButton label={isEnglish ? "Hide files panel" : "收起文件栏"} onClick={() => { setRightFullscreen(false); setRightFullscreenBottomOpen(false); setRightOpen(false); }}><PanelRight size={15} /></IconButton>
            </div>
          </div>
          {right}
          {rightFullscreen && rightFullscreenBottomOpen && <section className="right-fullscreen-bottom bottom-panel is-open">
            <div className="bottom-toolbar" aria-label={isEnglish ? "Terminal controls" : "终端窗口操作"}>
              <div className="toolbar-actions">
                <IconButton label={isEnglish ? (bottomFullscreen ? "Restore terminal" : "Maximize terminal") : (bottomFullscreen ? "恢复终端" : "最大化终端")} onClick={toggleBottomFullscreen} className={bottomFullscreen ? "is-active" : ""}>{bottomFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</IconButton>
                <IconButton label={isEnglish ? "Hide bottom panel" : "关闭底栏"} onClick={() => { setRightFullscreenBottomOpen(false); setBottomFullscreen(false); setBottomOpen(false); }}><PanelBottom size={15} /></IconButton>
              </div>
            </div>
            {bottom}
          </section>}
        </aside>
      </div>
    </div>
  );
}

export default ShellLayout;
