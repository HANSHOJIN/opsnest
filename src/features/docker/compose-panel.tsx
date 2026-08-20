import { Check, FileCode2, FolderOpen, FolderPlus, LoaderCircle, MoreHorizontal, Play, Plus, Power, RefreshCw, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DockerComposeProject, DockerPanelAction, DockerPanelActionResult } from "./docker-panel";
import "./compose-panel.css";

type ComposeSource = "create" | "upload";

function fileName(path: string) {
  const value = path.trim().replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).pop() || "compose.yml";
}

function defaultComposePath(path: string) {
  const normalized = normalizeRemotePath(path).replace(/[\\/]+$/, "");
  return /\.(?:ya?ml)$/i.test(normalized) ? normalized : `${normalized}/compose.yaml`;
}

function parentDirectory(path: string) {
  const normalized = normalizeRemotePath(path).replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent || "/";
}

function normalizeRemotePath(path: string) {
  const value = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!value) return "";
  return value.startsWith("/") ? value : `/${value}`;
}

function composeProjectState(project: DockerComposeProject, zhMode: boolean) {
  const status = project.status.trim();
  const running = /(?:^|\b)(?:up|running|healthy)(?:\b|\()/i.test(status);
  const countFromStatus = status.match(/\((\d+)\)/)?.[1];
  const count = countFromStatus ? Number(countFromStatus) : (project.containerCount ?? 0);
  // Docker Compose uses `created(n)` for containers that have already been
  // created but are not running. OpsNest's own `unbuilt(n)` sentinel is the
  // only state that means a YAML file exists without project containers.
  const unbuilt = /(?:未构建|unbuilt)/i.test(status);
  const label = running
    ? (zhMode ? "正在运行" : "Running")
    : unbuilt
      ? (zhMode ? "未构建" : "Not built")
      : (zhMode ? "已停止" : "Stopped");
  return { running, unbuilt, count, label };
}

export function ComposePanel({
  language,
  dockerRootDir,
  onAction,
  onOpenEditor,
}: {
  language: "zh-CN" | "en";
  dockerRootDir?: string;
  onAction?: (action: DockerPanelAction) => Promise<DockerPanelActionResult | void>;
  onOpenEditor?: (path: string, name: string) => void;
}) {
  const zhMode = language === "zh-CN";
  const [projects, setProjects] = useState<DockerComposeProject[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPath, setCreatePath] = useState("");
  const [createSource, setCreateSource] = useState<ComposeSource>("create");
  const [createContent, setCreateContent] = useState("");
  const [uploadedName, setUploadedName] = useState("");
  const [startAfterCreate, setStartAfterCreate] = useState(false);
  const [detectedComposePath, setDetectedComposePath] = useState("");
  const [pathChecking, setPathChecking] = useState(false);
  const [query, setQuery] = useState("");
  const [openMenuPath, setOpenMenuPath] = useState("");
  const [detailProject, setDetailProject] = useState<DockerComposeProject | null>(null);
  const [detailContent, setDetailContent] = useState("");
  const [detailDraft, setDetailDraft] = useState("");
  const [projectOperation, setProjectOperation] = useState<{ path: string; operation: "build" | "up" | "down" | "restart" | "remove" } | null>(null);
  const [deleteProject, setDeleteProject] = useState<DockerComposeProject | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerPath, setDirectoryPickerPath] = useState("");
  const [directoryEntries, setDirectoryEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const pathCheckTimer = useRef<number | undefined>(undefined);
  const visibleProjects = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return projects;
    return projects.filter((project) => `${project.name} ${project.configPath}`.toLowerCase().includes(value));
  }, [projects, query]);
  const detailState = detailProject ? composeProjectState(detailProject, zhMode) : null;

  const run = async (action: DockerPanelAction) => {
    if (!onAction || busy) return undefined;
    setBusy(action.kind === "compose" ? action.operation : action.kind);
    setError("");
    setMessage("");
    const operationLabel = action.kind === "compose"
      ? action.operation === "up"
        ? (zhMode ? "正在启动 Compose 项目…" : "Starting Compose project…")
        : action.operation === "build"
          ? (zhMode ? "正在构建 Compose 项目…" : "Building Compose project…")
        : action.operation === "down"
          ? (zhMode ? "正在停止 Compose 项目…" : "Stopping Compose project…")
          : action.operation === "restart"
            ? (zhMode ? "正在重启 Compose 项目…" : "Restarting Compose project…")
            : action.operation === "config"
              ? (zhMode ? "正在校验 Compose 配置…" : "Validating Compose configuration…")
              : action.operation === "browse"
                ? (zhMode ? "正在读取远程目录…" : "Reading remote directory…")
              : action.operation === "mkdir"
                ? (zhMode ? "正在创建文件夹…" : "Creating folder…")
              : action.operation === "create"
                ? (zhMode ? "正在创建 Compose 项目…" : "Creating Compose project…")
                : (zhMode ? "正在扫描 Compose 项目…" : "Scanning Compose projects…")
      : (zhMode ? "正在处理…" : "Working…");
    if (action.kind === "compose" && action.operation !== "list") setMessage(operationLabel);
    const ACTION_TIMEOUT = Symbol("compose-action-timeout");
    try {
      const result = await Promise.race([
        onAction(action),
        new Promise<typeof ACTION_TIMEOUT>((resolve) => window.setTimeout(() => resolve(ACTION_TIMEOUT), 10000)),
      ]);
      if (result === ACTION_TIMEOUT) {
        const delayedMessage = zhMode ? `${operationLabel}已发出，稍后刷新状态。` : `${operationLabel} The request was sent; status will refresh shortly.`;
        setMessage(delayedMessage);
        if (action.kind === "compose" && action.operation !== "list") window.setTimeout(() => void refresh(), 2800);
        return { message: delayedMessage };
      }
      if (result?.composeProjects) {
        if (!(action.kind === "compose" && action.operation === "list")) setProjects(result.composeProjects);
        if (!selectedPath && result.composeProjects[0]) setSelectedPath(result.composeProjects[0].configPath);
      }
      if (result?.composePath) setSelectedPath(result.composePath);
      if (result?.message) setMessage(result.message);
      return result;
    } catch (reason) {
      setError(String(reason));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (fallbackProject?: DockerComposeProject) => {
    // Docker's data-root contains image-layer files such as
    // overlay2/*/diff/**/docker-compose.yml. Those are application files
    // inside images, not host-side Compose projects. Project discovery must
    // use Compose's own registry/container labels; a filesystem path is only
    // scanned after the user explicitly selects it in the create flow.
    const result = await run({ kind: "compose", operation: "list" });
    const dockerDataRoot = normalizeRemotePath(dockerRootDir || "").replace(/\/$/, "");
    const isDockerInternalConfig = (configPath: string) => {
      if (!dockerDataRoot) return false;
      const normalizedPath = normalizeRemotePath(configPath);
      const relativePath = normalizedPath.startsWith(`${dockerDataRoot}/`)
        ? normalizedPath.slice(dockerDataRoot.length + 1)
        : "";
      return /^(?:overlay2|containers|image|volumes|buildkit|network|plugins|swarm|tmp)(?:\/|$)/.test(relativePath);
    };
    const listedProjects = (result?.composeProjects || []).filter(
      (project) => !isDockerInternalConfig(project.configPath),
    );
    const knownProjects = fallbackProject
      ? [...projects.filter((project) => project.configPath !== fallbackProject.configPath), fallbackProject]
      : projects.filter((project) => !isDockerInternalConfig(project.configPath));
    const mergedProjects = [...listedProjects];
    for (const knownProject of knownProjects) {
      if (mergedProjects.some((project) => project.configPath === knownProject.configPath)) continue;
      if (fallbackProject?.configPath === knownProject.configPath) {
        mergedProjects.push(knownProject);
        continue;
      }
      if (!onAction) continue;
      try {
        const inspected = await onAction({ kind: "compose", operation: "inspect", path: knownProject.configPath });
        if (inspected?.composeExists !== false) mergedProjects.push(knownProject);
      } catch {
        mergedProjects.push(knownProject);
      }
    }
    setProjects(mergedProjects);
    if (detailProject) {
      const latestDetail = mergedProjects.find((project) => project.configPath === detailProject.configPath);
      if (latestDetail) setDetailProject(latestDetail);
    }
    if (!mergedProjects.some((project) => project.configPath === selectedPath)) {
      setSelectedPath(mergedProjects[0]?.configPath || "");
    }
    setOpenMenuPath("");
  };

  useEffect(() => {
    void refresh();
    // Compose is mounted only when its Docker section is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (pathCheckTimer.current !== undefined) window.clearTimeout(pathCheckTimer.current);
  }, []);

  const selectProject = (project: DockerComposeProject) => {
    setSelectedPath(project.configPath);
    setOpenMenuPath("");
  };

  const openProject = async (project: DockerComposeProject) => {
    selectProject(project);
    setDetailProject(project);
    setDetailContent("");
    setDetailDraft("");
    const result = await run({ kind: "compose", operation: "read", path: project.configPath });
    if (result?.composeContent !== undefined) {
      setDetailContent(result.composeContent);
      setDetailDraft(result.composeContent);
    }
  };

  const saveDetail = async () => {
    if (!detailProject || !detailDraft.trim()) return;
    const result = await run({
      kind: "compose",
      operation: "create",
      path: detailProject.configPath,
      name: detailProject.name,
      content: detailDraft,
      overwriteExisting: true,
    });
    if (result) {
      setDetailContent(detailDraft);
      setMessage(zhMode ? "Compose 配置已保存。" : "Compose configuration saved.");
      await refresh(detailProject);
    }
  };

  const projectAction = async (project: DockerComposeProject, operation: "config" | "build" | "up" | "down" | "restart" | "remove" | "logs"): Promise<boolean> => {
    setSelectedPath(project.configPath);
    setOpenMenuPath("");
    const isTrackedOperation = operation === "build" || operation === "up" || operation === "down" || operation === "restart" || operation === "remove";
    if (isTrackedOperation) setProjectOperation({ path: project.configPath, operation });
    try {
      const result = await run({ kind: "compose", operation, path: project.configPath });
      if (result && operation === "remove") {
        setProjects((current) => current.filter((item) => item.configPath !== project.configPath));
        if (detailProject?.configPath === project.configPath) setDetailProject(null);
        setSelectedPath((current) => current === project.configPath ? "" : current);
        setMessage(zhMode ? `已删除 Compose 项目：${project.name}` : `Compose project deleted: ${project.name}`);
        window.setTimeout(() => void refresh(), 1000);
      } else if (result && isTrackedOperation) {
        const nextProject = operation === "down"
          ? { ...project, status: "exited(0)", containerCount: 0 }
          : operation === "build"
            ? { ...project, status: "created(1)", containerCount: Math.max(1, project.containerCount || 0) }
            : { ...project, status: "running(1)", containerCount: Math.max(1, project.containerCount || 0) };
        setProjects((current) => current.map((item) => item.configPath === project.configPath ? nextProject : item));
        if (detailProject?.configPath === project.configPath) setDetailProject(nextProject);
        window.setTimeout(() => void refresh(nextProject), 1800);
      } else if (result && operation !== "config" && operation !== "logs") {
        window.setTimeout(() => void refresh(), 1800);
      }
      if (operation === "build" || operation === "up" || operation === "down" || operation === "restart") {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("opsnest-refresh-docker-state")), 2800);
      }
      return Boolean(result);
    } finally {
      if (isTrackedOperation) setProjectOperation((current) => current?.path === project.configPath ? null : current);
    }
  };

  const confirmDeleteProject = async () => {
    if (!deleteProject) return;
    const target = deleteProject;
    const result = await projectAction(target, "remove");
    if (result) setDeleteProject(null);
  };

  const createProject = async () => {
    const path = normalizeRemotePath(createPath);
    const existingComposePath = detectedComposePath;
    const savedPath = existingComposePath || defaultComposePath(path);
    const savedName = createName.trim() || fileName(path);
    if (!path) {
      setError(zhMode ? "请填写 Compose 文件或项目目录路径" : "Enter a Compose file or project directory path");
      return;
    }
    if (pathChecking) return;
    if (!createContent.trim()) {
      setError(zhMode ? "请填写 Compose 内容或选择本地文件" : "Enter Compose content or choose a local file");
      return;
    }
    const result = await run({
      kind: "compose",
      operation: "create",
      path: existingComposePath || path,
      name: savedName,
      content: createContent,
      startAfterCreate,
      overwriteExisting: Boolean(existingComposePath),
    });
    if (!result) return;
    const createdProject: DockerComposeProject = {
      name: savedName,
      status: "unbuilt(0)",
      configPath: savedPath,
      containerCount: 0,
    };
    setShowCreate(false);
    setCreateName("");
    setCreatePath("");
    setCreateContent("");
    setUploadedName("");
    setStartAfterCreate(false);
    setDetectedComposePath("");
    setSelectedPath(savedPath);
    setProjects((current) => current.some((project) => project.configPath === savedPath)
      ? current.map((project) => project.configPath === savedPath ? createdProject : project)
      : [...current, createdProject]);
    await refresh(createdProject);
  };

  const inspectCreatePath = async (rawPath: string) => {
    const path = normalizeRemotePath(rawPath);
    if (!path || pathChecking || !onAction) return;
    setPathChecking(true);
    setDetectedComposePath("");
    const inspected = await run({ kind: "compose", operation: "inspect", path });
    setPathChecking(false);
    if (inspected?.composeExists) {
      const detectedPath = inspected.composePath || path;
      setDetectedComposePath(detectedPath);
      setCreateSource("create");
      setCreateContent(inspected.composeContent || "");
      setMessage(zhMode ? `已读取现有 Compose 配置：${detectedPath}，可直接编辑后保存。` : `Existing Compose configuration loaded: ${detectedPath}. Edit and save it here.`);
    } else if (inspected) {
      setMessage(zhMode ? "未检测到现有配置，可以继续创建。" : "No existing configuration found. You can continue creating it.");
    }
  };
  const schedulePathInspection = (rawPath: string) => {
    if (pathCheckTimer.current !== undefined) window.clearTimeout(pathCheckTimer.current);
    const path = rawPath.trim();
    if (!path) return;
    pathCheckTimer.current = window.setTimeout(() => {
      pathCheckTimer.current = undefined;
      void inspectCreatePath(path);
    }, 450);
  };
  const chooseCreatePath = (path: string) => {
    const normalizedPath = normalizeRemotePath(path);
    setCreatePath(normalizedPath);
    setDetectedComposePath("");
    setError("");
    void inspectCreatePath(normalizedPath);
  };

  const browseDirectory = async (rawPath: string) => {
    const path = normalizeRemotePath(rawPath) || "/";
    if (!onAction || directoryBusy) return;
    setDirectoryBusy(true);
    setDirectoryPickerPath(path);
    setError("");
    const result = await run({ kind: "compose", operation: "browse", path });
    setDirectoryBusy(false);
    if (result?.composeDirectories) setDirectoryEntries(result.composeDirectories);
  };

  const createRemoteFolder = async () => {
    const name = newFolderName.trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      setError(zhMode ? "文件夹名称不能为空，且不能包含斜杠。" : "Enter a folder name without slashes.");
      return;
    }
    const parent = normalizeRemotePath(directoryPickerPath) || "/";
    const target = parent === "/" ? `/${name}` : `${parent}/${name}`;
    setError("");
    const result = await run({ kind: "compose", operation: "mkdir", path: target });
    if (!result || busy) return;
    setNewFolderMode(false);
    setNewFolderName("");
    await browseDirectory(target);
  };

  const openDirectoryPicker = () => {
    const currentPath = normalizeRemotePath(createPath);
    const current = currentPath && !/\.(?:ya?ml)$/i.test(currentPath)
      ? currentPath
      : normalizeRemotePath(dockerRootDir || "/");
    setDirectoryPickerOpen(true);
    setDirectoryEntries([]);
    setNewFolderMode(false);
    setNewFolderName("");
    void browseDirectory(current);
  };

  const selectDirectory = () => {
    const path = directoryPickerPath || "/";
    setDirectoryPickerOpen(false);
    chooseCreatePath(path);
  };

  const openCreateModal = () => {
    setShowCreate(true);
    setDetectedComposePath("");
    setCreateName("");
    setCreatePath("");
    setCreateContent("");
    setUploadedName("");
    setCreateSource("create");
    setStartAfterCreate(false);
    setError("");
    setMessage("");
  };

  return (
    <section className="docker-compose-panel" aria-label={zhMode ? "Compose 管理" : "Compose management"}>
      <header className="docker-compose-project-management-heading">
        <strong>{zhMode ? "项目管理" : "Project management"}</strong>
        <div className="docker-compose-project-toolbar">
          <label className="docker-compose-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zhMode ? "搜索" : "Search"} />
          </label>
          <button className="docker-compose-refresh-button" type="button" onClick={() => void refresh()} disabled={!onAction || Boolean(busy)} title={zhMode ? "刷新" : "Refresh"} aria-label={zhMode ? "刷新" : "Refresh"}><RefreshCw size={14} className={busy === "list" ? "is-spinning" : ""} /></button>
          <button className="docker-compose-primary" type="button" onClick={openCreateModal} disabled={!onAction}><Plus size={14} />{zhMode ? "新增项目" : "New project"}</button>
        </div>
      </header>
      {error && <div className="docker-compose-feedback is-error"><span>{error}</span><button type="button" onClick={() => setError("")} title={zhMode ? "关闭反馈" : "Close feedback"} aria-label={zhMode ? "关闭反馈" : "Close feedback"}><X size={13} /></button></div>}
      {message && <div className="docker-compose-feedback"><span>{message}</span><button type="button" onClick={() => setMessage("")} title={zhMode ? "关闭反馈" : "Close feedback"} aria-label={zhMode ? "关闭反馈" : "Close feedback"}><X size={13} /></button></div>}
      <div className="docker-compose-project-list">
        {visibleProjects.length ? visibleProjects.map((project) => {
          const state = composeProjectState(project, zhMode);
          const menuOpen = openMenuPath === project.configPath;
          const activeOperation = projectOperation?.path === project.configPath ? projectOperation.operation : null;
          const operationLabel = activeOperation === "restart"
            ? (zhMode ? "重启中" : "Restarting")
            : activeOperation === "down"
              ? (zhMode ? "停止中" : "Stopping")
                : activeOperation === "build"
                  ? (zhMode ? "构建中" : "Building")
                : activeOperation === "remove"
                  ? (zhMode ? "删除中" : "Deleting")
                : activeOperation === "up"
                  ? (zhMode ? "启动中" : "Starting")
                : state.label;
          return (
            <div className="docker-compose-project-group" key={project.configPath}>
              <div className={"docker-compose-project-row " + (project.configPath === selectedPath ? "is-selected" : "")} role="button" tabIndex={0} onClick={() => selectProject(project)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectProject(project); } }}>
                <div className="docker-compose-project-main">
                  <span className="docker-compose-project-icon"><FileCode2 size={18} /></span>
                  <span className="docker-compose-project-copy">
                    <strong>{project.name}</strong>
                    <span className="docker-compose-project-meta">
                      <span className={activeOperation ? "is-operation" : state.running ? "is-running" : state.unbuilt ? "is-unbuilt" : "is-stopped"}>{operationLabel}</span>
                      <span>{zhMode ? `容器: ${state.count}` : `Containers: ${state.count}`}</span>
                    </span>
                  </span>
                </div>
                <div className="docker-compose-project-actions" onClick={(event) => event.stopPropagation()}>
                  <button className="docker-compose-project-power" type="button" onClick={() => void projectAction(project, state.running ? "down" : state.unbuilt ? "build" : "up")} disabled={Boolean(busy) || Boolean(activeOperation)} title={state.running ? (zhMode ? "停止" : "Stop") : state.unbuilt ? (zhMode ? "构建" : "Build") : (zhMode ? "启动" : "Start")} aria-label={state.running ? (zhMode ? "停止" : "Stop") : state.unbuilt ? (zhMode ? "构建" : "Build") : (zhMode ? "启动" : "Start")}>
                    {activeOperation ? <LoaderCircle className="is-spinning" size={16} /> : state.running ? <Power size={16} /> : <Play size={16} />}
                  </button>
                  <span className="docker-compose-menu-wrap">
                    <button className="docker-compose-more" type="button" onClick={() => setOpenMenuPath(menuOpen ? "" : project.configPath)} title={zhMode ? "更多" : "More"} aria-label={zhMode ? "更多" : "More"}><MoreHorizontal size={16} /></button>
                    {menuOpen && <span className="docker-compose-project-menu" role="menu">
                      {state.running ? <>
                        <button type="button" onClick={() => void projectAction(project, "down")} disabled={Boolean(activeOperation)}><Power size={15} />{zhMode ? "停止" : "Stop"}</button>
                        <button type="button" onClick={() => void projectAction(project, "restart")} disabled={Boolean(activeOperation)}><RotateCcw size={15} />{zhMode ? "重启" : "Restart"}</button>
                       </> : <button type="button" onClick={() => void projectAction(project, state.unbuilt ? "build" : "up")} disabled={Boolean(activeOperation)}><Play size={15} />{state.unbuilt ? (zhMode ? "构建" : "Build") : (zhMode ? "启动" : "Start")}</button>}
                       <button type="button" onClick={() => void openProject(project)}><Check size={15} />{zhMode ? "详情" : "Details"}</button>
                       <button className="is-danger" type="button" onClick={() => { setDeleteProject(project); setOpenMenuPath(""); }} disabled={Boolean(activeOperation)}><Trash2 size={15} />{zhMode ? "删除" : "Delete"}</button>
                     </span>}
                  </span>
                </div>
              </div>
            </div>
          );
        }) : <div className="docker-compose-empty">{busy === "list" ? (zhMode ? "正在扫描 Compose 项目…" : "Scanning Compose projects…") : (query ? (zhMode ? "没有匹配的项目" : "No matching projects") : (zhMode ? "尚未发现 Compose 项目" : "No Compose projects found"))}</div>}
      </div>
      {detailProject && (
        <div className="docker-compose-modal-backdrop" role="presentation">
          <section className="docker-compose-detail-modal" role="dialog" aria-modal="true" aria-labelledby="compose-detail-title">
            <header>
              <strong id="compose-detail-title">{zhMode ? "项目详情" : "Project details"}</strong>
              <button type="button" onClick={() => setDetailProject(null)} aria-label={zhMode ? "关闭" : "Close"}><X size={17} /></button>
            </header>
            <div className="docker-compose-detail-summary">
              <span className="docker-compose-project-icon"><FileCode2 size={20} /></span>
              <div>
                <strong>{detailProject.name}</strong>
                <span>{zhMode ? `状态：${detailState?.label} · 容器：${detailState?.count}` : `${detailState?.label} · Containers: ${detailState?.count}`}</span>
                <small>{detailProject.configPath}</small>
              </div>
            </div>
            <div className="docker-compose-detail-tabs"><span className="is-active">{zhMode ? "YAML 配置" : "YAML configuration"}</span></div>
            {detailState?.running ? (
              <pre className="docker-compose-detail-source">{detailContent || (busy === "read" ? (zhMode ? "正在读取…" : "Loading…") : (zhMode ? "未读取到 Compose 配置。" : "Compose configuration is unavailable."))}</pre>
            ) : (
              <textarea className="docker-compose-detail-editor" value={detailDraft} onChange={(event) => setDetailDraft(event.target.value)} placeholder={zhMode ? "Compose YAML 配置" : "Compose YAML configuration"} />
            )}
            <div className="docker-compose-detail-footer">
              <span>{detailState?.running ? (zhMode ? "项目运行中，YAML 配置为只读。停止后可编辑。" : "The project is running; YAML is read-only. Stop it to edit.") : (zhMode ? "项目已停止，可以编辑配置。" : "The project is stopped and can be edited.")}</span>
              {!detailState?.running && <button className="docker-compose-primary" type="button" onClick={() => void saveDetail()} disabled={Boolean(busy) || !detailDraft.trim()}>{zhMode ? "保存" : "Save"}</button>}
            </div>
          </section>
        </div>
      )}
      {deleteProject && (
        <div className="docker-compose-modal-backdrop docker-compose-delete-backdrop" role="presentation">
          <section className="docker-compose-delete-modal" role="dialog" aria-modal="true" aria-labelledby="compose-delete-title">
            <header>
              <strong id="compose-delete-title">{zhMode ? "删除 Compose 项目" : "Delete Compose project"}</strong>
              <button type="button" onClick={() => setDeleteProject(null)} aria-label={zhMode ? "关闭" : "Close"}><X size={17} /></button>
            </header>
            <p>{zhMode ? `确定删除“${deleteProject.name}”吗？将移除 Compose 容器和配置文件，不删除挂载数据目录。` : `Delete “${deleteProject.name}”? Its Compose containers and configuration file will be removed; mounted data directories are kept.`}</p>
            <small>{deleteProject.configPath}</small>
            <footer><button type="button" onClick={() => setDeleteProject(null)} disabled={busy === "remove"}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-compose-danger" type="button" onClick={() => void confirmDeleteProject()} disabled={busy === "remove"}>{busy === "remove" ? (zhMode ? "删除中…" : "Deleting…") : (zhMode ? "确认删除" : "Delete")}</button></footer>
          </section>
        </div>
      )}
      {directoryPickerOpen && (
        <div className="docker-compose-modal-backdrop docker-compose-directory-backdrop" role="presentation">
          <section className="docker-compose-directory-modal" role="dialog" aria-modal="true" aria-labelledby="compose-directory-title">
            <header>
              <strong id="compose-directory-title">{zhMode ? "选择远程目录" : "Choose remote directory"}</strong>
              <button type="button" onClick={() => setDirectoryPickerOpen(false)} aria-label={zhMode ? "关闭" : "Close"}><X size={17} /></button>
            </header>
            <div className="docker-compose-directory-toolbar">
              <input value={directoryPickerPath} onChange={(event) => setDirectoryPickerPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void browseDirectory(directoryPickerPath); } }} />
              <button type="button" onClick={() => void browseDirectory(parentDirectory(directoryPickerPath))} disabled={directoryBusy || directoryPickerPath === "/"} title={zhMode ? "上级目录" : "Parent directory"}>↑</button>
              <button type="button" onClick={() => void browseDirectory(directoryPickerPath)} disabled={directoryBusy} title={zhMode ? "刷新目录" : "Refresh directory"}><RefreshCw size={14} className={directoryBusy ? "is-spinning" : ""} /></button>
              <button type="button" onClick={() => { setNewFolderMode((value) => !value); setNewFolderName(""); setError(""); }} disabled={directoryBusy} title={zhMode ? "新建文件夹" : "New folder"} aria-label={zhMode ? "新建文件夹" : "New folder"}><FolderPlus size={14} /></button>
            </div>
            {newFolderMode && <div className="docker-compose-new-folder-row"><input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createRemoteFolder(); } }} placeholder={zhMode ? "文件夹名称" : "Folder name"} /><button type="button" onClick={() => void createRemoteFolder()} disabled={directoryBusy || !newFolderName.trim()} title={zhMode ? "创建" : "Create"}><Check size={14} /></button><button type="button" onClick={() => { setNewFolderMode(false); setNewFolderName(""); }} disabled={directoryBusy} title={zhMode ? "取消" : "Cancel"}><X size={14} /></button></div>}
            <div className="docker-compose-directory-list">
              {directoryEntries.length ? directoryEntries.map((entry) => (
                <button type="button" key={entry.path} onClick={() => void browseDirectory(entry.path)} disabled={directoryBusy}><FolderOpen size={15} /><span>{entry.name}</span></button>
              )) : <div className="docker-compose-directory-empty">{directoryBusy ? (zhMode ? "正在读取目录…" : "Reading directory…") : (zhMode ? "当前目录没有子目录" : "No subdirectories")}</div>}
            </div>
            <footer><button type="button" onClick={() => setDirectoryPickerOpen(false)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-compose-primary" type="button" onClick={selectDirectory} disabled={directoryBusy}>{zhMode ? "选择此目录" : "Use this directory"}</button></footer>
          </section>
        </div>
      )}
      {showCreate && (
        <div className="docker-compose-modal-backdrop" role="presentation">
          <section className="docker-compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-create-title">
            <header><strong id="compose-create-title">{zhMode ? "创建 Compose" : "Create Compose project"}</strong><button type="button" onClick={() => setShowCreate(false)} aria-label={zhMode ? "关闭" : "Close"}><X size={16} /></button></header>
            <label>{zhMode ? "名称" : "Name"}<input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={zhMode ? "例如 OpenList" : "e.g. OpenList"} /></label>
            <label>{zhMode ? "路径" : "Path"}<div className="docker-compose-path-input"><input value={createPath} onChange={(event) => { const value = normalizeRemotePath(event.target.value); setCreatePath(value); setDetectedComposePath(""); schedulePathInspection(value); }} onBlur={() => void inspectCreatePath(createPath)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void inspectCreatePath(createPath); } }} placeholder={zhMode ? "/opt/stacks/openlist 或 compose.yml" : "/opt/stacks/openlist or compose.yml"} /><button type="button" onClick={openDirectoryPicker} title={zhMode ? "浏览远程目录" : "Browse remote directories"} aria-label={zhMode ? "浏览远程目录" : "Browse remote directories"}><FolderOpen size={15} /></button></div><button className="docker-compose-root-fallback" type="button" onClick={() => chooseCreatePath("/")}>{zhMode ? "使用系统根目录 /" : "Use system root /"}</button>{pathChecking && <small className="docker-compose-path-status">{zhMode ? "正在检测目录和 Compose 配置…" : "Checking directory and Compose configuration…"}</small>}</label>
            <div className="docker-compose-source-label">{zhMode ? "来源" : "Source"}</div>
            <div className="docker-compose-source-options">
              <label><input type="radio" checked={createSource === "create"} onChange={() => { setCreateSource("create"); setDetectedComposePath(""); }} />{zhMode ? "直接编辑" : "Edit directly"}</label>
              <label><input type="radio" checked={createSource === "upload"} onChange={() => { setCreateSource("upload"); setDetectedComposePath(""); }} />{zhMode ? "上传本地文件" : "Upload local file"}</label>
            </div>
            {createSource === "create" && <textarea className="docker-compose-create-content" value={createContent} onChange={(event) => setCreateContent(event.target.value)} placeholder="services:\n  app:\n    image: ..." />}
            {createSource === "upload" && <label className="docker-compose-upload"><Upload size={15} /><span>{uploadedName || (zhMode ? "选择 docker-compose.yml" : "Choose docker-compose.yml")}</span><input type="file" accept=".yml,.yaml,.txt" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setUploadedName(file.name); setCreateContent(await file.text()); }} /></label>}
            <label className="docker-compose-start-option"><input type="checkbox" checked={startAfterCreate} onChange={(event) => setStartAfterCreate(event.target.checked)} />{zhMode ? "创建后立即启动" : "Start after creation"}</label>
            <footer><button type="button" onClick={() => setShowCreate(false)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-compose-primary" type="button" onClick={() => void createProject()} disabled={!onAction || Boolean(busy) || pathChecking}>{detectedComposePath ? (zhMode ? "保存" : "Save") : (zhMode ? "创建" : "Create")}</button></footer>
          </section>
        </div>
      )}
    </section>
  );
}
