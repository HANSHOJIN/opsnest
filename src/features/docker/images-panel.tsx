import { Box, Check, Download, Info, MoreHorizontal, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DockerImageSummary, DockerImageUpdateSummary, DockerPanelAction, DockerPanelActionResult } from "./docker-panel";
import "./images-panel.css";

const IMAGE_UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IMAGE_UPDATE_CACHE_PREFIX = "opsnest.docker.image-update.";
type CachedImageUpdate = DockerImageUpdateSummary & { checkedAt: number };

function imageCacheKey(serverId: string) {
  return IMAGE_UPDATE_CACHE_PREFIX + serverId;
}

function readImageUpdateCache(serverId: string) {
  const now = Date.now();
  try {
    const raw = localStorage.getItem(imageCacheKey(serverId));
    if (!raw) return {} as Record<string, CachedImageUpdate>;
    const parsed = JSON.parse(raw) as Record<string, CachedImageUpdate>;
    const valid = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => Number.isFinite(value?.checkedAt) && now - value.checkedAt < IMAGE_UPDATE_CACHE_TTL_MS),
    );
    if (Object.keys(valid).length !== Object.keys(parsed).length)
      localStorage.setItem(imageCacheKey(serverId), JSON.stringify(valid));
    return valid;
  } catch {
    return {} as Record<string, CachedImageUpdate>;
  }
}

function writeImageUpdateCache(serverId: string, updates: DockerImageUpdateSummary[]) {
  try {
    const cache = readImageUpdateCache(serverId);
    const checkedAt = Date.now();
    for (const update of updates) cache[update.reference] = { ...update, checkedAt };
    localStorage.setItem(imageCacheKey(serverId), JSON.stringify(cache));
  } catch {
    // Cache is only a UX optimization; a restricted storage context must not
    // make a remote Docker check fail.
  }
}

function removeImageUpdateCache(serverId: string, reference: string) {
  try {
    const cache = readImageUpdateCache(serverId);
    delete cache[reference];
    localStorage.setItem(imageCacheKey(serverId), JSON.stringify(cache));
  } catch {
    // Ignore unavailable local storage.
  }
}

function applyCachedImageUpdates(serverId: string, images: DockerImageSummary[]) {
  const cache = readImageUpdateCache(serverId);
  return images.map((image) => {
    const reference = image.repository && image.repository !== "<none>"
      ? `${image.repository}:${image.tag || "latest"}`
      : image.id;
    const update = cache[reference];
    return update
      ? {
          ...image,
          updateStatus: update.updateStatus,
          remoteDigest: update.remoteDigest,
          usedBy: update.usedBy,
          composeTargets: update.composeTargets,
        }
      : image;
  });
}

function parseImageUpdateLine(line: string): DockerImageUpdateSummary | null {
  if (!line.startsWith("__OPSNEST_IMAGE_UPDATE__\t")) return null;
  const [, reference = "", rawStatus = "unknown", localDigest = "", remoteDigest = "", usedBy = "", rawTargets = ""] = line.split("\t");
  if (!reference.trim()) return null;
  const updateStatus: DockerImageUpdateSummary["updateStatus"] = rawStatus === "current" || rawStatus === "available"
    ? rawStatus
    : "unknown";
  const composeTargets = rawTargets
    .split(";")
    .map((target) => {
      const separator = target.lastIndexOf("::");
      if (separator < 1) return null;
      const path = target.slice(0, separator).trim();
      const service = target.slice(separator + 2).trim();
      return path.startsWith("/") && service ? { path, service } : null;
    })
    .filter((target): target is { path: string; service: string } => Boolean(target));
  return {
    reference: reference.trim(),
    updateStatus,
    localDigest: localDigest || undefined,
    remoteDigest: remoteDigest || undefined,
    usedBy: usedBy.split(",").map((name) => name.trim()).filter(Boolean),
    composeTargets,
  };
}

type DockerLayerProgress = {
  id: string;
  status: string;
  current?: string;
  total?: string;
  percent?: number;
};

function stripDockerProgressControl(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
}

function dockerProgressBytes(value: string) {
  const match = value.trim().match(/^([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  const unit = match[2].toLowerCase();
  const factors: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return number * factors[unit];
}

function parseDockerProgressLine(rawLine: string) {
  const line = stripDockerProgressControl(rawLine);
  if (!line) return {};
  const layer = line.match(/^([a-f0-9]{8,64}):\s*(.+)$/i);
  if (!layer) {
    if (/pulling from/i.test(line)) return { stage: "连接镜像仓库…" };
    if (/^digest:/i.test(line)) return { stage: "校验镜像…" };
    if (/^status:/i.test(line)) return { stage: line };
    return {};
  }
  const id = layer[1];
  const detail = layer[2];
  const sizes = detail.match(/([\d.]+\s*(?:B|KB|KiB|MB|MiB|GB|GiB|TB|TiB))\s*\/\s*([\d.]+\s*(?:B|KB|KiB|MB|MiB|GB|GiB|TB|TiB))/i);
  const current = sizes?.[1];
  const total = sizes?.[2];
  const currentBytes = current ? dockerProgressBytes(current) : undefined;
  const totalBytes = total ? dockerProgressBytes(total) : undefined;
  const percent = totalBytes && totalBytes > 0 && currentBytes !== undefined
    ? Math.min(100, Math.max(0, Math.round((currentBytes / totalBytes) * 100)))
    : /pull complete|already exists|download complete/i.test(detail)
      ? 100
      : undefined;
  const status = /extracting/i.test(detail)
    ? "解压中"
    : /downloading/i.test(detail)
      ? "下载中"
      : /verifying checksum/i.test(detail)
        ? "校验中"
        : /pull complete|already exists|download complete/i.test(detail)
          ? "已完成"
          : /pulling fs layer/i.test(detail)
            ? "准备下载"
            : detail;
  return {
    layer: { id, status, current, total, percent } satisfies DockerLayerProgress,
    stage: status === "解压中" ? "正在解压镜像层…" : status === "下载中" ? "正在下载镜像层…" : undefined,
  };
}

export function ImagesPanel({
  language,
  onAction,
  serverId,
}: {
  language: "zh-CN" | "en";
  onAction?: (action: DockerPanelAction) => Promise<DockerPanelActionResult | void>;
  serverId: string;
}) {
  const zhMode = language === "zh-CN";
  const [images, setImages] = useState<DockerImageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [, setBusyOperations] = useState<string[]>([]);
  const busyOperationsRef = useRef(new Set<string>());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [openMenu, setOpenMenu] = useState("");
  const [pullOpen, setPullOpen] = useState(false);
  const [pullReference, setPullReference] = useState("");
  const [removeTarget, setRemoveTarget] = useState<DockerImageSummary | null>(null);
  const [upgradeTarget, setUpgradeTarget] = useState<DockerImageSummary | null>(null);
  const [detailTarget, setDetailTarget] = useState<DockerImageSummary | null>(null);
  const [detailContent, setDetailContent] = useState("");
  const [upgradeProgress, setUpgradeProgress] = useState<{
    reference: string;
    stage: string;
    layers: DockerLayerProgress[];
  } | null>(null);
  const [checkProgress, setCheckProgress] = useState("");
  const progressBufferRef = useRef("");
  const checkBufferRef = useRef("");
  const layerProgressRef = useRef(new Map<string, DockerLayerProgress>());

  const imageReference = (image: DockerImageSummary) =>
    image.repository && image.repository !== "<none>"
      ? `${image.repository}:${image.tag || "latest"}`
      : image.id;

  const imageDisplayName = (image: DockerImageSummary) => {
    if (!image.repository || image.repository === "<none>")
      return zhMode ? "未命名镜像" : "Unnamed image";
    return image.tag && image.tag !== "<none>"
      ? `${image.repository}:${image.tag}`
      : image.repository;
  };

  const operationKey = (action: DockerPanelAction) => {
    if (action.kind !== "image") return action.kind;
    if (action.operation === "list" || action.operation === "pull") {
      return `image:${action.operation}`;
    }
    const reference = action.reference?.trim() || "unknown";
    if (action.operation === "check") return "image:check";
    return `image:${action.operation}:${reference}`;
  };

  const isBusy = (key: string) => busyOperationsRef.current.has(key);

  const beginOperation = (key: string) => {
    if (busyOperationsRef.current.has(key)) return false;
    busyOperationsRef.current.add(key);
    setBusyOperations(Array.from(busyOperationsRef.current));
    return true;
  };

  const finishOperation = (key: string) => {
    busyOperationsRef.current.delete(key);
    setBusyOperations(Array.from(busyOperationsRef.current));
  };

  useEffect(() => {
    const handleProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ serverId?: string; reference?: string; operation?: string; data?: string }>).detail;
      if (!detail || detail.serverId !== serverId || !detail.data) return;
      if (detail.operation === "check" || detail.operation === "checkOne") {
        const lines = (checkBufferRef.current + detail.data.replace(/\r/g, "\n")).split("\n");
        checkBufferRef.current = lines.pop() || "";
        for (const line of lines) {
          const match = line.match(/__OPSNEST_IMAGE_CHECK_PROGRESS__\t([^\t]+)\t(start|done)/);
          if (match) {
            setCheckProgress(
              match[2] === "done"
                ? (zhMode ? `已完成检查：${match[1]}` : `Checked: ${match[1]}`)
                : (zhMode ? `正在检查：${match[1]}` : `Checking: ${match[1]}`),
            );
          }
          const update = parseImageUpdateLine(line);
          if (!update) continue;
          writeImageUpdateCache(serverId, [update]);
          setImages((current) => current.map((image) =>
            imageReference(image) === update.reference
              ? {
                  ...image,
                  updateStatus: update.updateStatus,
                  remoteDigest: update.remoteDigest,
                  usedBy: update.usedBy,
                  composeTargets: update.composeTargets,
                }
              : image,
          ));
        }
        return;
      }
      const reference = detail.reference || "";
      const lines = (progressBufferRef.current + detail.data.replace(/\r/g, "\n")).split("\n");
      progressBufferRef.current = lines.pop() || "";
      let stage = "";
      for (const line of lines) {
        const parsed = parseDockerProgressLine(line);
        if (parsed.layer) layerProgressRef.current.set(parsed.layer.id, parsed.layer);
        if (parsed.stage) stage = parsed.stage;
      }
      if (!stage && layerProgressRef.current.size) stage = "正在处理镜像层…";
      setUpgradeProgress((current) => current && current.reference === reference
        ? {
            ...current,
            stage: stage || current.stage,
            layers: Array.from(layerProgressRef.current.values()),
          }
        : current);
    };
    window.addEventListener("opsnest-docker-image-progress", handleProgress);
    return () => window.removeEventListener("opsnest-docker-image-progress", handleProgress);
  }, [language, serverId, zhMode]);

  const filteredImages = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return images;
    return images.filter((image) => `${image.repository} ${image.tag} ${image.id} ${image.digest || ""} ${(image.usedBy || []).join(" ")}`.toLowerCase().includes(value));
  }, [images, query]);

  const run = async (action: DockerPanelAction) => {
    if (!onAction) return undefined;
    const key = operationKey(action);
    const queuedBehindAnotherOperation = busyOperationsRef.current.size > 0;
    if (!beginOperation(key)) return undefined;
    setError("");
    setMessage(
      queuedBehindAnotherOperation
        ? (zhMode ? "已加入队列，等待上一项镜像操作完成…" : "Queued behind the current image operation…")
        : "",
    );
    try {
      const result = await onAction(action);
      if (result?.images) setImages(applyCachedImageUpdates(serverId, result.images));
      if (result?.imageUpdates) {
        writeImageUpdateCache(serverId, result.imageUpdates);
        const updates = new Map(result.imageUpdates.map((update) => [update.reference, update]));
        setImages((current) => current.map((image) => {
          const update = updates.get(imageReference(image));
          return update
            ? {
                ...image,
                updateStatus: update.updateStatus,
                remoteDigest: update.remoteDigest,
                usedBy: update.usedBy,
                composeTargets: update.composeTargets,
              }
            : image;
        }));
      }
      if (result?.message && !(action.kind === "image" && action.operation === "inspect")) setMessage(result.message);
      return result;
    } catch (reason) {
      setError(String(reason));
      return undefined;
    } finally {
      finishOperation(key);
    }
  };

  const refresh = async () => {
    setOpenMenu("");
    await run({ kind: "image", operation: "list" });
  };

  useEffect(() => {
    void refresh();
    // The panel mounts only while the Local images section is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inspectImage = async (image: DockerImageSummary) => {
    setOpenMenu("");
    setDetailTarget(image);
    setDetailContent("");
    const result = await run({ kind: "image", operation: "inspect", reference: imageReference(image) });
    if (result?.message !== undefined) setDetailContent(result.message);
  };

  const pullImage = async () => {
    const reference = pullReference.trim();
    if (!reference) return;
    const result = await run({ kind: "image", operation: "pull", reference });
    if (!result) return;
    setPullOpen(false);
    setPullReference("");
    await refresh();
  };

  const removeImage = async () => {
    const target = removeTarget;
    if (!target) return;
    setRemoveTarget(null);
    const reference = imageReference(target);
    const result = await run({ kind: "image", operation: "remove", reference });
    if (result) {
      removeImageUpdateCache(serverId, reference);
      await refresh();
    }
  };

  const checkUpdates = async () => {
    setOpenMenu("");
    checkBufferRef.current = "";
    setCheckProgress(zhMode ? "正在连接镜像仓库…" : "Connecting to registry…");
    await run({ kind: "image", operation: "check" });
    checkBufferRef.current = "";
    setCheckProgress("");
  };

  const checkImage = async (image: DockerImageSummary) => {
    const reference = imageReference(image);
    setOpenMenu("");
    checkBufferRef.current = "";
    setCheckProgress(zhMode ? `正在检查：${reference}` : `Checking: ${reference}`);
    await run({ kind: "image", operation: "checkOne", reference });
    checkBufferRef.current = "";
    setCheckProgress("");
  };

  const upgradeImage = async () => {
    const target = upgradeTarget;
    if (!target) return;
    const reference = imageReference(target);
    // Close the confirmation modal before the remote pull/rebuild starts. The
    // operation may take a while, but it must not leave a full-screen backdrop
    // blocking the rest of the image panel.
    setUpgradeTarget(null);
    progressBufferRef.current = "";
    layerProgressRef.current.clear();
    setUpgradeProgress({ reference, stage: zhMode ? "连接镜像仓库…" : "Connecting to registry…", layers: [] });
    const result = await run({
      kind: "image",
      operation: "upgrade",
      reference,
      usedBy: target.usedBy,
      composeTargets: target.composeTargets,
    });
    if (!result) {
      setUpgradeProgress(null);
      return;
    }
    const upgrade = result.imageUpgrade;
    const finalMessage = upgrade
      ? zhMode
        ? `镜像升级完成：已重建 ${upgrade.composeServices} 个 Compose 服务；${upgrade.standaloneContainers} 个独立容器保持原状。`
        : `Image upgraded: ${upgrade.composeServices} Compose services recreated; ${upgrade.standaloneContainers} standalone containers left unchanged.`
      : result.message || (zhMode ? "镜像升级完成。" : "Image upgrade completed.");
    setImages((current) => current.map((image) =>
      imageReference(image) === reference
        ? { ...image, updateStatus: "current", remoteDigest: target.remoteDigest }
        : image,
    ));
    writeImageUpdateCache(serverId, [{
      reference,
      updateStatus: "current",
      remoteDigest: target.remoteDigest,
      localDigest: target.digest,
      usedBy: target.usedBy || [],
      composeTargets: target.composeTargets || [],
    }]);
    // The list command does not include update metadata. Refresh the list and
    // immediately run a full check so every image keeps an accurate status,
    // instead of forcing the user to click “检查更新” again.
    await refresh();
    await run({ kind: "image", operation: "check" });
    setUpgradeProgress(null);
    setMessage(finalMessage);
  };

  return (
    <section className="docker-images-panel" aria-label={zhMode ? "本地镜像" : "Local images"}>
      <header className="docker-images-heading">
        <strong>{zhMode ? "本地镜像" : "Local images"}</strong>
        <div>
          <label className="docker-images-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zhMode ? "搜索镜像" : "Search images"} /></label>
          <button className="docker-images-icon-button" type="button" onClick={() => void refresh()} disabled={!onAction || isBusy("image:list")} title={zhMode ? "刷新" : "Refresh"}><RefreshCw size={14} className={isBusy("image:list") ? "is-spinning" : ""} /></button>
          <button className="docker-images-check-button" type="button" onClick={() => void checkUpdates()} disabled={!onAction || isBusy("image:check")} title={zhMode ? "手动连接镜像仓库并检查更新" : "Manually contact registries and check for updates"}><RefreshCw size={14} className={isBusy("image:check") ? "is-spinning" : ""} />{zhMode ? "检查更新" : "Check updates"}</button>
          <button className="docker-images-primary" type="button" onClick={() => setPullOpen(true)} disabled={!onAction || isBusy("image:pull")}><Plus size={14} />{zhMode ? "拉取镜像" : "Pull image"}</button>
        </div>
      </header>

      {error && <div className="docker-images-feedback is-error"><span>{error}</span><button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
      {message && <div className="docker-images-feedback"><span>{message}</span><button type="button" onClick={() => setMessage("")}><X size={13} /></button></div>}
      {checkProgress && <div className="docker-images-feedback" role="status" aria-live="polite"><RefreshCw size={14} className="is-spinning" /><span>{checkProgress}</span></div>}
      {upgradeProgress && <div className="docker-image-progress" role="status" aria-live="polite">
        <div className="docker-image-progress-heading">
          <strong>{zhMode ? "镜像升级中" : "Image upgrade in progress"}</strong>
          <span title={upgradeProgress.reference}>{upgradeProgress.stage}</span>
        </div>
        {upgradeProgress.layers.length ? <div className="docker-image-progress-layers">
          {upgradeProgress.layers.map((layer) => <div className="docker-image-progress-layer" key={layer.id}>
            <div><code>{layer.id.slice(0, 12)}</code><span>{layer.status}{layer.percent !== undefined ? ` · ${layer.percent}%` : ""}</span></div>
            <div className="docker-image-progress-track"><i style={{ width: `${layer.percent ?? 0}%` }} /></div>
            {layer.current && layer.total && <small>{layer.current} / {layer.total}</small>}
          </div>)}
        </div> : <small className="docker-image-progress-empty">{zhMode ? "等待镜像层进度…" : "Waiting for layer progress…"}</small>}
      </div>}

      <div className="docker-images-list">
        {filteredImages.length ? filteredImages.map((image) => {
          const reference = imageReference(image);
          const usedBy = image.usedBy || [];
          return (
            <article className={`docker-image-row${image.updateStatus === "available" ? " has-update" : ""}`} key={`${image.id}-${image.repository}-${image.tag}`}>
              <span className="docker-image-icon"><Box size={18} /></span>
              <div className="docker-image-main">
                <strong title={reference}>{imageDisplayName(image)}</strong>
                <div className="docker-image-subline">
                  <span>{image.id}</span>
                  <b
                    className={`docker-image-usage ${usedBy.length ? "is-used" : "is-unused"}`}
                    title={usedBy.length
                      ? (zhMode ? `使用此镜像的容器：${usedBy.join("、")}` : `Used by: ${usedBy.join(", ")}`)
                      : (zhMode ? "没有容器引用此镜像" : "No containers reference this image")}
                  >
                    {usedBy.length ? (zhMode ? "已使用" : "In use") : (zhMode ? "未使用" : "Unused")}
                  </b>
                </div>
              </div>
              <div className="docker-image-meta"><span>{image.size || "—"}</span><small>{image.createdAt || ""}</small>{image.updateStatus && <b className={`docker-image-update-state is-${image.updateStatus}`}>{image.updateStatus === "available" ? (zhMode ? "有新版本" : "Update available") : image.updateStatus === "current" ? (zhMode ? "已是最新" : "Up to date") : (zhMode ? "无法检查" : "Unavailable")}</b>}</div>
              <div className="docker-image-actions">
                {image.updateStatus === "available" && <button className="docker-image-upgrade-button" type="button" onClick={() => setUpgradeTarget(image)} disabled={isBusy(`image:upgrade:${reference}`)}><Download size={14} />{isBusy(`image:upgrade:${reference}`) ? (zhMode ? "升级中…" : "Upgrading…") : (zhMode ? "升级" : "Upgrade")}</button>}
              <div className="docker-image-menu-wrap">
                <button className="docker-images-icon-button" type="button" onClick={() => setOpenMenu(openMenu === reference ? "" : reference)} title={zhMode ? "更多" : "More"}><MoreHorizontal size={15} /></button>
                {openMenu === reference && <div className="docker-image-menu">
                  <button type="button" onClick={() => void inspectImage(image)}><Info size={14} />{zhMode ? "详情" : "Details"}</button>
                  <button type="button" onClick={() => void checkImage(image)} disabled={isBusy(`image:checkOne:${reference}`)}><RefreshCw size={14} className={isBusy(`image:checkOne:${reference}`) ? "is-spinning" : ""} />{zhMode ? "检查更新" : "Check updates"}</button>
                  {image.updateStatus === "available" && <button type="button" onClick={() => { setOpenMenu(""); setUpgradeTarget(image); }}><Download size={14} />{zhMode ? "升级" : "Upgrade"}</button>}
                  <button className="is-danger" type="button" onClick={() => { setOpenMenu(""); setRemoveTarget(image); }}><Trash2 size={14} />{zhMode ? "删除" : "Remove"}</button>
                </div>}
              </div>
              </div>
            </article>
          );
        }) : <div className="docker-images-empty">{isBusy("image:list") ? (zhMode ? "正在读取镜像…" : "Loading images…") : query ? (zhMode ? "没有匹配的镜像" : "No matching images") : (zhMode ? "暂无本地镜像" : "No local images")}</div>}
      </div>

      {pullOpen && <div className="docker-images-modal-backdrop"><section className="docker-images-modal" role="dialog" aria-modal="true" aria-labelledby="docker-pull-title"><header><strong id="docker-pull-title">{zhMode ? "拉取镜像" : "Pull image"}</strong><button type="button" onClick={() => setPullOpen(false)}><X size={16} /></button></header><label>{zhMode ? "镜像名称" : "Image reference"}<input autoFocus value={pullReference} onChange={(event) => setPullReference(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void pullImage(); }} placeholder="nginx:latest" /></label><footer><button type="button" onClick={() => setPullOpen(false)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-images-primary" type="button" onClick={() => void pullImage()} disabled={!pullReference.trim() || isBusy("image:pull")}><Download size={14} />{isBusy("image:pull") ? (zhMode ? "拉取中…" : "Pulling…") : (zhMode ? "拉取" : "Pull")}</button></footer></section></div>}

      {removeTarget && <div className="docker-images-modal-backdrop"><section className="docker-images-modal" role="dialog" aria-modal="true" aria-labelledby="docker-remove-title"><header><strong id="docker-remove-title">{zhMode ? "确认删除镜像" : "Remove image"}</strong><button type="button" onClick={() => setRemoveTarget(null)}><X size={16} /></button></header><p>{zhMode ? `确定删除“${imageReference(removeTarget)}”？正在被容器使用的镜像会由 Docker 拒绝删除。` : `Remove “${imageReference(removeTarget)}”? Docker will reject images used by containers.`}</p><footer><button type="button" onClick={() => setRemoveTarget(null)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-images-danger" type="button" onClick={() => void removeImage()} disabled={isBusy(`image:remove:${imageReference(removeTarget)}`)}>{isBusy(`image:remove:${imageReference(removeTarget)}`) ? (zhMode ? "删除中…" : "Removing…") : (zhMode ? "删除" : "Remove")}</button></footer></section></div>}

      {upgradeTarget && <div className="docker-images-modal-backdrop"><section className="docker-images-modal docker-image-upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="docker-upgrade-title"><header><strong id="docker-upgrade-title">{zhMode ? "升级镜像" : "Upgrade image"}</strong><button type="button" onClick={() => setUpgradeTarget(null)}><X size={16} /></button></header><strong className="docker-image-upgrade-reference">{imageReference(upgradeTarget)}</strong><div className="docker-image-upgrade-summary"><p><Check size={14} />{zhMode ? `受影响容器：${upgradeTarget.usedBy?.length || 0} 个` : `Affected containers: ${upgradeTarget.usedBy?.length || 0}`}</p><p><Check size={14} />{zhMode ? `自动重建 Compose 服务：${upgradeTarget.composeTargets?.length || 0} 个` : `Compose services to recreate: ${upgradeTarget.composeTargets?.length || 0}`}</p>{(upgradeTarget.usedBy?.length || 0) > (upgradeTarget.composeTargets?.length || 0) && <p className="is-warning"><Info size={14} />{zhMode ? "独立容器只拉取新镜像，不会自动重建，以免丢失运行参数。" : "Standalone containers will not be recreated automatically to protect their runtime settings."}</p>}</div><footer><button type="button" onClick={() => setUpgradeTarget(null)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-images-primary" type="button" onClick={() => void upgradeImage()} disabled={isBusy(`image:upgrade:${imageReference(upgradeTarget)}`)}><Download size={14} />{isBusy(`image:upgrade:${imageReference(upgradeTarget)}`) ? (zhMode ? "升级中…" : "Upgrading…") : (zhMode ? "确认升级" : "Upgrade")}</button></footer></section></div>}

      {detailTarget && <div className="docker-images-modal-backdrop"><section className="docker-images-detail-modal" role="dialog" aria-modal="true" aria-labelledby="docker-image-detail-title"><header><div><strong id="docker-image-detail-title">{imageDisplayName(detailTarget)}</strong><span>{detailTarget.id}</span></div><button type="button" onClick={() => setDetailTarget(null)}><X size={16} /></button></header><pre>{detailContent || (isBusy(`image:inspect:${imageReference(detailTarget)}`) ? (zhMode ? "正在读取详情…" : "Loading details…") : (zhMode ? "未读取到镜像详情" : "Image details unavailable"))}</pre></section></div>}
    </section>
  );
}
