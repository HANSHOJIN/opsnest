import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronDown, ChevronRight, ExternalLink, Files as FilesGlyph, Info, Link2, MoreHorizontal, Pencil, Power, RefreshCw, RotateCcw, ScrollText, Search, Settings2, X } from "lucide-react";
import dockerIcon from "../../../icons/packed/services/docker.svg";
import dockerIconMarkup from "../../../icons/packed/services/docker.svg?raw";
import type { DockerEventSummary, ServerSummary } from "../../components/ShellLayout";
import { containerIconAliases, iconCandidates, normalizeIconKey } from "../../services/iconCatalog";
import { RemoteIcon } from "../icons/catalog";
import { openServiceUrl } from "../services/url";
import { ComposePanel } from "./compose-panel";
import { ImagesPanel } from "./images-panel";
import { NetworkPanel } from "./network-panel";
import { RegistryPanel } from "./registry-panel";

export type DockerPanelService = {
  id: string;
  name: string;
  kind: string;
  status: string;
  detail: string;
  version?: string;
  port?: number;
  portMappings?: string[];
  webPath?: string;
  webScheme?: "http" | "https";
  dockerRootDir?: string;
  dockerAutostart?: string;
  dockerCapabilities?: string;
  dockerEvents?: DockerEventSummary[];
};
export type DockerPanelPlacement = "right" | "bottom";
export type DockerComposeProject = {
  name: string;
  status: string;
  configPath: string;
  containerCount?: number;
  createdAt?: string;
};
export type DockerImageSummary = {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
  digest?: string;
  updateStatus?: "current" | "available" | "unknown";
  remoteDigest?: string;
  usedBy?: string[];
  composeTargets?: Array<{ path: string; service: string }>;
};
export type DockerImageUpdateSummary = {
  reference: string;
  updateStatus: "current" | "available" | "unknown";
  localDigest?: string;
  remoteDigest?: string;
  usedBy: string[];
  composeTargets: Array<{ path: string; service: string }>;
};
export type DockerRegistrySummary = {
  name: string;
  secure: boolean;
  mirrors: string[];
};
export type DockerNetworkSummary = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal?: string;
  ipv6?: string;
};
export type DockerPanelAction =
  | { kind: "service"; enabled: boolean }
  | { kind: "autostart"; enabled: boolean }
  | { kind: "root"; value: string }
  | { kind: "container"; name: string; operation: "start" | "stop" | "restart" | "details" | "logs" }
  | { kind: "image"; operation: "list" | "inspect" | "pull" | "remove" | "check" | "upgrade"; reference?: string; usedBy?: string[]; composeTargets?: Array<{ path: string; service: string }> }
  | { kind: "registry"; operation: "list" }
  | { kind: "network"; operation: "list" | "inspect"; name?: string }
  | { kind: "compose"; operation: "list" | "browse" | "mkdir" | "inspect" | "read" | "config" | "logs" | "build" | "up" | "down" | "restart" | "remove" | "create"; path?: string; name?: string; content?: string; startAfterCreate?: boolean; overwriteExisting?: boolean };
export type DockerPanelActionResult = {
  running?: boolean;
  containerRunning?: boolean;
  dockerRootDir?: string;
  dockerAutostart?: string;
  composeProjects?: DockerComposeProject[];
  composeDirectories?: Array<{ name: string; path: string }>;
  composeExists?: boolean;
  composeContent?: string;
  composePath?: string;
  images?: DockerImageSummary[];
  imageUpdates?: DockerImageUpdateSummary[];
  imageUpgrade?: { reference: string; composeServices: number; standaloneContainers: number };
  registries?: DockerRegistrySummary[];
  networks?: DockerNetworkSummary[];
  message?: string;
};
type DockerManagementSection = "overview" | "containers" | "compose" | "images" | "registry" | "network";

function endpointHost(host: string) {
  const at = host.indexOf("@");
  return at > 0 ? host.slice(at + 1) : host;
}

function isRunning(status: string) {
  return /^(?:up|running|healthy)\b/i.test(status.trim());
}

function isComposeProjectRunning(status: string) {
  const normalized = status.trim();
  return /^(?:up|running|healthy)\b/i.test(normalized) && !/(?:exited|stopped|unbuilt|未构建)/i.test(normalized);
}

function isComposeProjectProblem(status: string) {
  return /(?:error|failed|failure|unhealthy|exited|dead|stopped|异常|失败)/i.test(status.trim());
}

function serviceUrl(server: ServerSummary, service: DockerPanelService) {
  if (!service.port) return "";
  const path = service.webPath?.trim() || "";
  const normalizedPath = path
    ? path.startsWith("/")
      ? path
      : `/${path}`
    : "";
  return `${service.webScheme === "https" ? "https" : "http"}://${endpointHost(server.host)}:${service.port}${normalizedPath}`;
}

function ContainerServiceIcon({ name, image, refreshKey = 0 }: { name: string; image?: string; refreshKey?: number }) {
  const key = normalizeIconKey(name);
  const candidates = useMemo(
    () => iconCandidates(key, undefined, containerIconAliases(name, image)),
    [image, key, name],
  );
  return (
    <RemoteIcon
      directory="services"
      candidates={candidates}
      fallback={dockerIconMarkup}
      empty=""
      className="docker-container-resolved-icon"
      refreshKey={refreshKey}
    />
  );
}

function dockerAutostartLabel(value: string | undefined, zhMode: boolean) {
  const normalized = value?.trim().toLowerCase() || "";
  if (normalized === "enabled" || normalized === "true" || normalized === "yes")
    return zhMode ? "已开启" : "Enabled";
  if (normalized === "disabled" || normalized === "masked" || normalized === "false" || normalized === "no")
    return zhMode ? "未开启" : "Disabled";
  if (normalized === "static")
    return zhMode ? "静态服务" : "Static";
  return "—";
}

function dockerEventTime(timestamp: string) {
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds) && seconds > 1_000_000_000) {
    return new Date(seconds * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return timestamp;
}

export function DockerPanel({
  server,
  services,
  language,
  onManage,
  iconRefreshKey = 0,
}: {
  server: ServerSummary;
  services: DockerPanelService[];
  language: "zh-CN" | "en";
  onManage?: () => void;
  iconRefreshKey?: number;
}) {
  const zhMode = language === "zh-CN";
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const dockerService = services.find((service) => service.id.toLowerCase() === "docker");
  const containers = useMemo(
    () => services.filter(
      (service) =>
        service.id.toLowerCase() !== "docker" &&
        /^(?:docker|container)$/i.test(service.kind.trim()),
    ),
    [services],
  );
  const filteredContainers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return containers;
    return containers.filter((container) =>
      `${container.name} ${container.version || ""} ${container.detail}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [containers, query]);
  const installed = Boolean(server.docker && !/not\s+installed|未安装/i.test(server.docker));
  if (!installed && !dockerService && containers.length === 0) return null;

  const runningCount = containers.filter((container) => isRunning(container.status)).length;
  const dockerVersion = dockerService?.version || dockerService?.detail || "—";
  const statusText = dockerService && isRunning(dockerService.status)
    ? zhMode ? "运行中" : "Running"
    : zhMode ? "已安装" : "Installed";

  return (
    <section className="docker-panel-card" aria-label="Docker">
      <div className="docker-panel-heading">
        <div className="docker-panel-brand">
          <span className="docker-panel-brand-icon">
            <img src={dockerIcon} alt="Docker" aria-hidden="true" />
          </span>
          <div>
            <span className="home-section-label">Docker</span>
            <h2>{zhMode ? "容器运行概览" : "Container overview"}</h2>
          </div>
        </div>
        <span className="docker-panel-status">● {statusText}</span>
      </div>

      <div className="docker-panel-stats">
        <div><span>{zhMode ? "运行中容器" : "Running"}</span><strong>{runningCount}</strong></div>
        <div><span>{zhMode ? "容器总数" : "Containers"}</span><strong>{containers.length}</strong></div>
        <div><span>{zhMode ? "Docker 版本" : "Docker version"}</span><strong>{dockerVersion}</strong></div>
        <div><span>{zhMode ? "管理方式" : "Management"}</span><strong>SSH</strong></div>
      </div>

      <div className="docker-panel-toolbar">
        <button
          className="docker-expand-button"
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded
            ? zhMode ? "收起容器" : "Collapse containers"
            : zhMode ? `展开全部容器（${containers.length}）` : `Show all containers (${containers.length})`}
        </button>
        {onManage && (
          <button
            className="docker-manage-button"
            type="button"
            onClick={onManage}
            title={zhMode ? "打开 Docker 管理面板" : "Open Docker management panel"}
          >
            <Settings2 size={14} />
            <span>{zhMode ? "管理" : "Manage"}</span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="docker-panel-expanded">
          <div className="docker-panel-list-heading">
            <div><strong>{zhMode ? "容器" : "Containers"}</strong><span>{zhMode ? "来自服务器扫描结果" : "Read from the server scan"}</span></div>
            <b>{containers.length}</b>
          </div>
          {containers.length > 0 && (
            <label className="docker-panel-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={zhMode ? "搜索容器" : "Search containers"}
              />
            </label>
          )}
          {filteredContainers.length > 0 ? (
            <div className="docker-panel-container-grid">
              {filteredContainers.map((container) => {
                const running = isRunning(container.status);
                const url = serviceUrl(server, container);
                return (
                  <article className="docker-panel-container" key={container.id}>
                    <div className="docker-panel-container-icon"><ContainerServiceIcon name={container.name} image={container.version || container.detail} refreshKey={iconRefreshKey} /></div>
                    <div className="docker-panel-container-main">
                      <strong>{container.name}</strong>
                      <span>{container.version || container.detail || (zhMode ? "镜像信息未知" : "Image unavailable")}</span>
                      <small className={running ? "is-running" : "is-stopped"}>
                        ● {running ? (zhMode ? "运行中" : "Running") : (zhMode ? "已停止" : "Stopped")}
                        {container.port ? ` · ${zhMode ? "端口" : "Port"} ${container.port}` : ""}
                      </small>
                    </div>
                    {url ? (
                      <button className="docker-panel-open" type="button" onClick={() => openServiceUrl(url)} title={zhMode ? "打开 Web 入口" : "Open web entry"}>
                        <ExternalLink size={14} />
                      </button>
                    ) : <span className="docker-panel-no-port">{zhMode ? "无 Web" : "No Web"}</span>}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="docker-panel-empty">{query ? (zhMode ? "没有匹配的容器" : "No matching containers") : (zhMode ? "尚未扫描到容器" : "No containers found")}</div>
          )}
        </div>
      )}
    </section>
  );
}

export function DockerManagementPanel({
  server,
  services,
  language,
  placement = "right",
  showTabs = false,
  onBackToFiles,
  onMove,
  onClose,
  onRefresh,
  refreshing = false,
  onAction,
  onOpenComposeEditor,
  iconRefreshKey = 0,
}: {
  server: ServerSummary;
  services: DockerPanelService[];
  language: "zh-CN" | "en";
  placement?: DockerPanelPlacement;
  showTabs?: boolean;
  onBackToFiles?: () => void;
  onMove?: (placement: DockerPanelPlacement) => void;
  onClose?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onAction?: (action: DockerPanelAction) => Promise<DockerPanelActionResult | void>;
  onOpenComposeEditor?: (path: string, name: string) => void;
  iconRefreshKey?: number;
}) {
  const zhMode = language === "zh-CN";
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<DockerManagementSection>("overview");
  const [rootEditing, setRootEditing] = useState(false);
  const [rootDraft, setRootDraft] = useState("");
  const [actionBusy, setActionBusy] = useState<DockerPanelAction["kind"] | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [containerFeedbackName, setContainerFeedbackName] = useState<string | null>(null);
  const [localRunning, setLocalRunning] = useState<boolean | undefined>(undefined);
  const [localContainerRunning, setLocalContainerRunning] = useState<Record<string, boolean>>({});
  const [serviceTransition, setServiceTransition] = useState<"starting" | "stopping" | null>(null);
  const [autostartTransition, setAutostartTransition] = useState<"starting" | "stopping" | null>(null);
  const [localRootDir, setLocalRootDir] = useState("");
  const [localAutostart, setLocalAutostart] = useState("");
  const [openContainerMenu, setOpenContainerMenu] = useState<string | null>(null);
  const [openPortMenu, setOpenPortMenu] = useState<string | null>(null);
  const [overviewImages, setOverviewImages] = useState<DockerImageSummary[] | null>(null);
  const [overviewComposeProjects, setOverviewComposeProjects] = useState<DockerComposeProject[] | null>(null);
  const [overviewStatsError, setOverviewStatsError] = useState("");
  const [overviewStatsLoading, setOverviewStatsLoading] = useState(false);
  const onActionRef = useRef(onAction);
  const overviewLoadGeneration = useRef(0);
  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);
  const panelRef = useRef<HTMLElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const update = () => setPanelWidth(panel.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const fullPanel = placement === "bottom" || (placement === "right" && panelWidth >= 520);
  const dockerService = services.find((service) => service.id.toLowerCase() === "docker");
  const containers = useMemo(
    () => services.filter(
      (service) =>
        service.id.toLowerCase() !== "docker" &&
        /^(?:docker|container)$/i.test(service.kind.trim()),
    ),
    [services],
  );
  const filteredContainers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return containers;
    return containers.filter((container) =>
      `${container.name} ${container.version || ""} ${container.detail}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [containers, query]);
  const runningCount = containers.filter((container) =>
    localContainerRunning[container.name] ?? isRunning(container.status),
  ).length;
  const running = Boolean(dockerService && isRunning(dockerService.status));
  const webEntryCount = containers.filter((item) => Boolean(item.port)).length;
  const dockerRootDir = dockerService?.dockerRootDir?.trim() || "";
  const effectiveRunning = localRunning ?? running;
  const effectiveRootDir = localRootDir || dockerRootDir;
  const effectiveAutostart = localAutostart || dockerService?.dockerAutostart || "";
  const effectiveAutostartLabel = dockerAutostartLabel(effectiveAutostart, zhMode);
  const isContainerRunning = (container: DockerPanelService) =>
    localContainerRunning[container.name] ?? isRunning(container.status);
  const activityItems = useMemo(() => {
    const eventItems = (dockerService?.dockerEvents ?? [])
      .slice(-5)
      .reverse()
      .map((event) => ({
        name: event.name || "Docker",
        status: dockerEventTime(event.timestamp) + " · " + event.action,
        tone: /(die|kill|stop|restart|unhealthy|oom|destroy|remove)/i.test(event.action)
          ? "warning"
          : "normal",
      }));
    if (eventItems.length) return eventItems;
    const problemItems = containers.filter((container) =>
      /(restart|restarting|unhealthy|exited|dead|paused|oom)/i.test(container.status),
    );
    const normalItems = containers.filter((container) =>
      /^(up|running|healthy)/i.test(container.status),
    );
    const source = [...problemItems, ...normalItems].slice(0, 5);
    return source.map((container) => ({
      name: container.name,
      status: container.status,
      tone: problemItems.includes(container) ? "warning" : "normal",
    }));
  }, [containers, dockerService?.dockerEvents]);
  const capabilities = new Set(
    (dockerService?.dockerCapabilities || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const canControl = capabilities.has("control");
  const canAutostart = capabilities.has("autostart");
  const canEditRoot = capabilities.has("root") && Boolean(effectiveRootDir);
  useEffect(() => {
    setLocalRunning(undefined);
    setLocalContainerRunning({});
    setServiceTransition(null);
    setAutostartTransition(null);
    setLocalRootDir("");
    setLocalAutostart("");
    setRootEditing(false);
    setActionError("");
  }, [dockerService?.id, dockerService?.status, dockerService?.dockerRootDir, dockerService?.dockerAutostart, dockerService?.dockerCapabilities]);
  const runAction = async (action: DockerPanelAction) => {
    if (!onAction || actionBusy || overviewStatsLoading) return;
    setActionBusy(action.kind);
    setActionError("");
    setActionMessage("");
    if (!(action.kind === "container" && (action.operation === "logs" || action.operation === "details"))) setContainerFeedbackName(null);
    if (action.kind === "service") {
      setLocalRunning(action.enabled);
      setServiceTransition(action.enabled ? "starting" : "stopping");
    }
    if (action.kind === "autostart") {
      setLocalAutostart(action.enabled ? "enabled" : "disabled");
      setAutostartTransition(action.enabled ? "starting" : "stopping");
    }
    const delayedRefresh = () => {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("opsnest-refresh-docker-state", { detail: { serverId: server.id } }));
      }, 2800);
    };
    const ACTION_TIMEOUT = Symbol("docker-action-timeout");
    try {
      const result = await Promise.race([
        onAction(action),
        new Promise<typeof ACTION_TIMEOUT>((resolve) => window.setTimeout(() => resolve(ACTION_TIMEOUT), 7000)),
      ]);
      if (result === ACTION_TIMEOUT) {
        setActionMessage(zhMode ? "操作已发出，正在重新读取状态…" : "The action was sent; refreshing status…");
        delayedRefresh();
        window.setTimeout(() => {
          setServiceTransition(null);
          setAutostartTransition(null);
        }, 6000);
        return;
      }
      if (result?.running !== undefined) setLocalRunning(result.running);
      if (action.kind === "container" && result?.containerRunning !== undefined) {
        setLocalContainerRunning((current) => ({
          ...current,
          [action.name]: result.containerRunning as boolean,
        }));
      }
      if (result?.dockerRootDir !== undefined) setLocalRootDir(result.dockerRootDir);
      if (result?.dockerAutostart !== undefined) setLocalAutostart(result.dockerAutostart);
      if (result?.message) setActionMessage(result.message);
      if (action.kind === "root") setRootEditing(false);
      if (action.kind === "service" || action.kind === "autostart" || action.kind === "container") delayedRefresh();
    } catch (error) {
      setActionError(String(error));
      if (action.kind === "service") setServiceTransition(null);
      if (action.kind === "autostart") setAutostartTransition(null);
    } finally {
      setActionBusy(null);
    }
  };
  const runContainerAction = (name: string, operation: Extract<DockerPanelAction, { kind: "container" }>["operation"]) => {
    setOpenContainerMenu(null);
    setOpenPortMenu(null);
    if (operation === "logs" || operation === "details") setContainerFeedbackName(name);
    void runAction({ kind: "container", name, operation });
  };
  const statusText = serviceTransition === "starting"
    ? zhMode ? "启动中" : "Starting"
    : serviceTransition === "stopping"
      ? zhMode ? "停止中" : "Stopping"
      : effectiveRunning
        ? zhMode ? "运行中" : "Running"
        : dockerService
          ? zhMode ? "已停止" : "Stopped"
          : zhMode ? "已安装" : "Installed";
  const sectionLabels: Array<[DockerManagementSection, string, string]> = [
    ["overview", "概览", "Overview"],
    ["containers", "容器", "Containers"],
    ["compose", "Compose", "Compose"],
    ["images", "本地镜像", "Local images"],
    ["registry", "镜像仓库", "Registry"],
    ["network", "网络", "Network"],
  ];
  useEffect(() => {
    setSection(fullPanel ? "overview" : "containers");
  }, [fullPanel]);

  useEffect(() => {
    if (!fullPanel || section !== "overview" || !dockerService || !onActionRef.current) return;
    const generation = ++overviewLoadGeneration.current;
    let cancelled = false;
    setOverviewImages(null);
    setOverviewComposeProjects(null);
    setOverviewStatsError("");
    setOverviewStatsLoading(true);

    const loadOverviewStats = async () => {
      let imageError = "";
      try {
        const result = await onActionRef.current?.({ kind: "image", operation: "list" });
        if (cancelled || generation !== overviewLoadGeneration.current) return;
        setOverviewImages(result?.images || []);
      } catch (error) {
        imageError = String(error);
        if (!cancelled && generation === overviewLoadGeneration.current) setOverviewImages([]);
      }
      if (cancelled || generation !== overviewLoadGeneration.current) return;
      try {
        const result = await onActionRef.current?.({ kind: "compose", operation: "list" });
        if (cancelled || generation !== overviewLoadGeneration.current) return;
        setOverviewComposeProjects(result?.composeProjects || []);
      } catch (error) {
        if (!cancelled && generation === overviewLoadGeneration.current) {
          setOverviewComposeProjects([]);
          setOverviewStatsError(imageError ? `${imageError}; ${String(error)}` : String(error));
        }
      }
      if (imageError && !cancelled && generation === overviewLoadGeneration.current) setOverviewStatsError(imageError);
      if (!cancelled && generation === overviewLoadGeneration.current) setOverviewStatsLoading(false);
    };
    void loadOverviewStats();
    return () => {
      cancelled = true;
      if (generation === overviewLoadGeneration.current) setOverviewStatsLoading(false);
    };
  }, [dockerService?.id, fullPanel, iconRefreshKey, section, server.id]);

  const overviewImageCount = overviewImages?.length;
  const overviewUsedImageCount = overviewImages?.filter((image) => Boolean(image.usedBy?.length)).length;
  const overviewComposeCount = overviewComposeProjects?.length;
  const overviewComposeRunningCount = overviewComposeProjects?.filter((project) => isComposeProjectRunning(project.status)).length;
  const overviewComposeProblemCount = overviewComposeProjects?.filter((project) => isComposeProjectProblem(project.status)).length;

  return (
    <section ref={panelRef} className={`docker-management-panel ${fullPanel ? "is-full-layout" : "is-compact-layout"}`} aria-label={zhMode ? "Docker 管理" : "Docker management"}>
      {showTabs && (
        <div className="file-manager-tabs docker-management-tabs">
          <div className="file-manager-tab">
            <button className="file-manager-tab-select" type="button" onClick={onBackToFiles} title={zhMode ? `返回 ${server.name} 文件栏` : `Back to ${server.name} files`}>
              <FilesGlyph className="file-manager-tab-icon" size={14} strokeWidth={1.8} />
              <span className="file-manager-tab-label">{server.name}</span>
            </button>
          </div>
          <div className="file-manager-tab is-active">
            <button className="file-manager-tab-select" type="button" title="Docker">
              <img className="file-manager-tab-icon docker-tab-icon" src={dockerIcon} alt="" aria-hidden="true" />
              <span className="file-manager-tab-label">{server.name}</span>
            </button>
            {onClose && <button className="file-manager-tab-close" type="button" onClick={onClose} aria-label={zhMode ? "关闭 Docker 标签" : "Close Docker tab"}><X size={12} /></button>}
          </div>
        </div>
      )}
      <header className="docker-management-header">
        <div className="docker-management-title">
          <span className="docker-management-icon"><img src={dockerIcon} alt="Docker" aria-hidden="true" /></span>
          <div><strong>Docker</strong><span>{server.name}</span></div>
        </div>
        <div className="docker-management-header-actions">
          <span className="docker-panel-status">● {statusText}</span>
          {onMove && (
            <button className="docker-management-action" type="button" onClick={() => onMove(placement === "right" ? "bottom" : "right")} title={placement === "right" ? (zhMode ? "移动到下栏" : "Move to bottom") : (zhMode ? "移动到右栏" : "Move to side panel")}>
              {placement === "right" ? <ArrowDown size={14} /> : <ArrowRight size={14} />}
            </button>
          )}
          {onClose && !showTabs && <button className="docker-management-action" type="button" onClick={onClose} title={zhMode ? "关闭 Docker" : "Close Docker"}><X size={14} /></button>}
        </div>
      </header>
      {!fullPanel && (
        <div className="docker-management-summary">
          <div><span>{zhMode ? "容器" : "Containers"}</span><strong>{containers.length}</strong></div>
          <div><span>{zhMode ? "运行中" : "Running"}</span><strong>{runningCount}</strong></div>
        </div>
      )}
      {fullPanel && (
        <nav className="docker-management-nav" aria-label={zhMode ? "Docker 功能" : "Docker sections"}>
          {sectionLabels.map(([id, zhLabel, enLabel]) => (
            <button key={id} type="button" className={section === id ? "is-active" : ""} onClick={() => setSection(id)}>
              {zhMode ? zhLabel : enLabel}
            </button>
          ))}
        </nav>
      )}
      {fullPanel && section === "overview" && (
        <div className="docker-full-overview">
          <div className="docker-full-dashboard-grid">
            <div className="docker-full-health">
              <div>
                <strong>{zhMode ? "健康" : "Health"}</strong>
                <span>{effectiveRunning ? (zhMode ? "所有服务运行状态正常" : "All services are running normally") : (zhMode ? "状态来自当前服务器扫描" : "Status from the current server scan")}</span>
                <div className="docker-full-health-metrics">
                  <span><i aria-hidden="true">◈</i>{zhMode
                    ? overviewComposeCount === undefined
                      ? "Compose 项目读取中…"
                      : `共 ${overviewComposeCount} 个项目；${overviewComposeRunningCount} 个运行中；${overviewComposeProblemCount} 个异常`
                    : overviewComposeCount === undefined
                      ? "Loading Compose projects…"
                      : `${overviewComposeCount} projects; ${overviewComposeRunningCount} running; ${overviewComposeProblemCount} issues`}</span>
                  <span><i aria-hidden="true">◉</i>{zhMode
                    ? overviewImageCount === undefined
                      ? "镜像读取中…"
                      : `共 ${overviewImageCount} 个镜像；${overviewUsedImageCount} 个已使用；${overviewImageCount - (overviewUsedImageCount || 0)} 个未使用`
                    : overviewImageCount === undefined
                      ? "Loading images…"
                      : `${overviewImageCount} images; ${overviewUsedImageCount} used; ${overviewImageCount - (overviewUsedImageCount || 0)} unused`}</span>
                  <span><i aria-hidden="true">⬡</i>{zhMode ? `共 ${containers.length} 个容器；${runningCount} 个运行中` : `${containers.length} containers; ${runningCount} running`}</span>
                </div>
                {overviewStatsError && <small className="docker-overview-stats-error">{zhMode ? "镜像或 Compose 统计读取失败，容器扫描仍可用" : "Image or Compose statistics could not be read; container scan is still available"}</small>}
              </div>
              <b className={effectiveRunning ? "is-healthy" : "is-unknown"} aria-label={effectiveRunning ? (zhMode ? "健康" : "Healthy") : (zhMode ? "状态未知" : "Status unknown")}>{effectiveRunning ? <Check size={13} strokeWidth={2.5} /> : "!"}</b>
            </div>
            <div className="docker-full-service-card">
              <div className="docker-full-service-card-heading">
                <div><strong>{zhMode ? "Docker 服务" : "Docker service"}</strong><span>{zhMode ? "服务状态由 SSH 扫描读取" : "Read from the SSH scan"}</span></div>
                {canControl ? <button className={"docker-service-toggle " + (effectiveRunning ? "is-on" : "")} type="button" aria-pressed={effectiveRunning} onClick={() => void runAction({ kind: "service", enabled: !effectiveRunning })} disabled={!onAction || actionBusy !== null} title={zhMode ? "启动或停止 Docker 服务" : "Start or stop Docker service"}>{serviceTransition === "starting" ? (zhMode ? "启动中" : "Starting") : serviceTransition === "stopping" ? (zhMode ? "停止中" : "Stopping") : effectiveRunning ? (zhMode ? "运行中" : "Running") : (zhMode ? "已停止" : "Stopped")}</button> : <span className="docker-capability-unavailable">{zhMode ? "不可用" : "Unavailable"}</span>}
              </div>
              <div className="docker-full-service-row"><span>{zhMode ? "存储位置" : "Storage"}</span>
                {rootEditing ? (
                  <div className="docker-full-edit-row">
                    <input value={rootDraft} onChange={(event) => setRootDraft(event.target.value)} aria-label={zhMode ? "Docker 存储位置" : "Docker storage location"} />
                    <button type="button" onClick={() => void runAction({ kind: "root", value: rootDraft.trim() })} disabled={!rootDraft.trim() || actionBusy === "root"} title={zhMode ? "保存存储位置" : "Save storage location"}><Check size={13} /></button>
                    <button type="button" onClick={() => setRootEditing(false)} disabled={actionBusy === "root"} title={zhMode ? "取消编辑" : "Cancel editing"}><X size={13} /></button>
                  </div>
                ) : (
                  <><strong>{effectiveRootDir || "—"}</strong>{canEditRoot && <button className="docker-inline-edit" type="button" onClick={() => { setRootDraft(effectiveRootDir); setRootEditing(true); }} disabled={!onAction || actionBusy !== null} title={zhMode ? "编辑 Docker 存储位置" : "Edit Docker storage location"}><Pencil size={13} /></button>}</>
                )}
                <small>{effectiveRootDir ? (canEditRoot ? (zhMode ? "Docker 根目录，可编辑" : "Docker root directory, editable") : (zhMode ? "已读取但当前只读" : "Read successfully, but read-only")) : (zhMode ? "未读取到 Docker 信息，暂不可编辑" : "Docker info unavailable; editing disabled")}</small>
              </div>
              <div className="docker-full-service-row"><span>{zhMode ? "开机自动开启" : "Autostart"}</span><strong>{effectiveAutostartLabel}</strong>{canAutostart ? <button className={"docker-service-toggle " + (/^enabled|true|yes$/i.test(effectiveAutostart) ? "is-on" : "")} type="button" aria-pressed={/^enabled|true|yes$/i.test(effectiveAutostart)} onClick={() => void runAction({ kind: "autostart", enabled: !/^enabled|true|yes$/i.test(effectiveAutostart) })} disabled={!onAction || actionBusy !== null} title={zhMode ? "切换开机自启" : "Toggle autostart"}>{autostartTransition === "starting" ? (zhMode ? "启动中" : "Starting") : autostartTransition === "stopping" ? (zhMode ? "停止中" : "Stopping") : /^enabled|true|yes$/i.test(effectiveAutostart) ? (zhMode ? "已开启" : "Enabled") : (zhMode ? "未开启" : "Disabled")}</button> : <span className="docker-capability-unavailable">{zhMode ? "不可用" : "Unavailable"}</span>}<small>{effectiveAutostart ? (zhMode ? "来自服务管理器" : "From the service manager") : (zhMode ? "未读取到 Docker 服务配置" : "Docker service configuration unavailable")}</small></div>
              {actionError && <div className="docker-action-error">{actionError}</div>}
            </div>
          </div>
          <div className="docker-full-overview-grid">
            <article><span>{zhMode ? "容器" : "Containers"}</span><strong>{containers.length}</strong><small>{zhMode ? `${runningCount} 个运行中` : `${runningCount} running`}</small></article>
            <article><span>{zhMode ? "已发现 Web 入口" : "Web entries"}</span><strong>{webEntryCount}</strong><small>{zhMode ? "来自服务扫描" : "From service scan"}</small></article>
            <article><span>{zhMode ? "存储位置" : "Storage"}</span><strong>{effectiveRootDir || "—"}</strong><small>{effectiveRootDir ? (zhMode ? "Docker 根目录" : "Docker root directory") : (zhMode ? "未读取到 Docker 信息" : "Docker info unavailable")}</small></article>
            <article><span>{zhMode ? "开机自启" : "Autostart"}</span><strong>{effectiveAutostartLabel}</strong><small>{effectiveAutostart ? (zhMode ? "服务管理器状态" : "Service manager state") : (zhMode ? "未读取到服务配置" : "Service configuration unavailable")}</small></article>
          </div>
          <div className="docker-recent-activity">
            <div className="docker-recent-activity-heading">
              <div><strong>{zhMode ? "最近活动与异常" : "Recent activity and issues"}</strong><span>{zhMode ? "基于本次服务器扫描的状态摘要" : "Status summary from the current server scan"}</span></div>
              {activityItems.some((item) => item.tone === "warning") && <b>{zhMode ? "有异常" : "Issues found"}</b>}
            </div>
            {activityItems.length ? (
              <div className="docker-recent-activity-list">
                {activityItems.map((item) => (
                  <div className={"docker-recent-activity-item is-" + item.tone} key={item.name}>
                    <i />
                    <strong>{item.name}</strong>
                    <span>{item.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="docker-recent-activity-empty">{zhMode ? "最近没有异常活动" : "No recent issues detected"}</div>
            )}
          </div>
        </div>
      )}
      {fullPanel && section === "compose" && (
        <ComposePanel
          language={language}
          dockerRootDir={effectiveRootDir}
          onAction={onAction}
          onOpenEditor={onOpenComposeEditor}
        />
      )}
      {fullPanel && section === "images" && (
        <ImagesPanel language={language} onAction={onAction} />
      )}
      {fullPanel && section === "registry" && (
        <RegistryPanel language={language} onAction={onAction} />
      )}
      {fullPanel && section === "network" && (
        <NetworkPanel language={language} onAction={onAction} />
      )}
      {(!fullPanel || section === "containers") && (
        <>
      <div className="docker-management-toolbar">
        <label className="docker-panel-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zhMode ? "搜索容器" : "Search containers"}
          />
        </label>
        {onRefresh && (
          <button className="docker-management-refresh" type="button" onClick={onRefresh} disabled={refreshing} title={zhMode ? "刷新容器" : "Refresh containers"}>
            <RefreshCw size={14} className={refreshing ? "is-spinning" : ""} />
          </button>
        )}
      </div>
      {filteredContainers.length ? (
        <div className="docker-management-list">
          {filteredContainers.map((container) => {
            const url = serviceUrl(server, container);
            const running = isContainerRunning(container);
            const mappings = container.portMappings?.length
              ? container.portMappings
              : container.port
                ? [String(container.port)]
                : [];
            return (
              <div className="docker-management-row-group" key={container.id}>
              <article className="docker-management-row">
                <div className="docker-management-row-icon"><ContainerServiceIcon name={container.name} image={container.version || container.detail} refreshKey={iconRefreshKey} /></div>
                <div className="docker-management-row-main">
                  <strong>{container.name}</strong>
                  <span>{container.version || container.detail || (zhMode ? "镜像信息未知" : "Image unavailable")}</span>
                  <small className={running ? "is-running" : "is-stopped"}>
                    ● {running ? (zhMode ? "运行中" : "Running") : (zhMode ? "已停止" : "Stopped")}
                    {container.port ? ` · ${zhMode ? "端口" : "Port"} ${container.port}` : ""}
                  </small>
                  {mappings.length > 0 && <span className="docker-management-ports">{mappings.join(" · ")}</span>}
                </div>
                <div className="docker-management-row-actions">
                  {mappings.length > 0 && (
                    <div className="docker-container-popover-wrap">
                      <button className="docker-management-open" type="button" onClick={() => setOpenPortMenu(openPortMenu === container.id ? null : container.id)} title={zhMode ? "端口映射" : "Port mappings"}><Link2 size={14} /></button>
                      {openPortMenu === container.id && <div className="docker-container-popover docker-port-popover">{mappings.map((mapping) => <button key={mapping} type="button" onClick={() => { setOpenPortMenu(null); if (url) openServiceUrl(url); }}>{mapping}</button>)}</div>}
                    </div>
                  )}
                  <button className={"docker-container-toggle " + (running ? "is-on" : "")} type="button" aria-label={running ? (zhMode ? "停止容器" : "Stop container") : (zhMode ? "启动容器" : "Start container")} aria-pressed={running} onClick={() => runContainerAction(container.name, running ? "stop" : "start")} disabled={!onAction || actionBusy !== null} title={running ? (zhMode ? "停止容器" : "Stop container") : (zhMode ? "启动容器" : "Start container")}><Power size={14} /></button>
                  <div className="docker-container-popover-wrap">
                    <button className="docker-management-open" type="button" onClick={() => setOpenContainerMenu(openContainerMenu === container.id ? null : container.id)} title={zhMode ? "更多操作" : "More actions"}><MoreHorizontal size={14} /></button>
                    {openContainerMenu === container.id && (
                      <div className="docker-container-popover docker-more-popover">
                        <button type="button" onClick={() => runContainerAction(container.name, "restart")}><RotateCcw size={14} />{zhMode ? "重启" : "Restart"}</button>
                        <button type="button" onClick={() => runContainerAction(container.name, "details")}><Info size={14} />{zhMode ? "详情" : "Details"}</button>
                        <button type="button" onClick={() => runContainerAction(container.name, "logs")}><ScrollText size={14} />{zhMode ? "运行日志" : "Logs"}</button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
              {containerFeedbackName === container.name && (actionError || actionMessage) && (
                <div className="docker-action-feedback-wrap">
                  <pre className={"docker-action-feedback" + (actionError ? " docker-action-feedback-error" : "")}>{actionError || actionMessage}</pre>
                  <button className="docker-action-feedback-close" type="button" onClick={() => { setActionError(""); setActionMessage(""); setContainerFeedbackName(null); }} title={zhMode ? "关闭反馈" : "Close feedback"} aria-label={zhMode ? "关闭反馈" : "Close feedback"}><X size={13} /></button>
                </div>
              )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="docker-management-empty">{query ? (zhMode ? "没有匹配的容器" : "No matching containers") : (zhMode ? "暂无容器" : "No containers")}</div>
      )}
      {(actionError || actionMessage) && !containerFeedbackName && (
        <div className="docker-action-feedback-wrap">
          <pre className={"docker-action-feedback" + (actionError ? " docker-action-feedback-error" : "")}>{actionError || actionMessage}</pre>
          <button className="docker-action-feedback-close" type="button" onClick={() => { setActionError(""); setActionMessage(""); setContainerFeedbackName(null); }} title={zhMode ? "关闭反馈" : "Close feedback"} aria-label={zhMode ? "关闭反馈" : "Close feedback"}><X size={13} /></button>
        </div>
      )}
        </>
      )}
    </section>
  );
}
