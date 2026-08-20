import { Box, Check, Download, Info, MoreHorizontal, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DockerImageSummary, DockerPanelAction, DockerPanelActionResult } from "./docker-panel";
import "./images-panel.css";

export function ImagesPanel({
  language,
  onAction,
}: {
  language: "zh-CN" | "en";
  onAction?: (action: DockerPanelAction) => Promise<DockerPanelActionResult | void>;
}) {
  const zhMode = language === "zh-CN";
  const [images, setImages] = useState<DockerImageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [openMenu, setOpenMenu] = useState("");
  const [pullOpen, setPullOpen] = useState(false);
  const [pullReference, setPullReference] = useState("");
  const [removeTarget, setRemoveTarget] = useState<DockerImageSummary | null>(null);
  const [upgradeTarget, setUpgradeTarget] = useState<DockerImageSummary | null>(null);
  const [detailTarget, setDetailTarget] = useState<DockerImageSummary | null>(null);
  const [detailContent, setDetailContent] = useState("");

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

  const filteredImages = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return images;
    return images.filter((image) => `${image.repository} ${image.tag} ${image.id} ${image.digest || ""} ${(image.usedBy || []).join(" ")}`.toLowerCase().includes(value));
  }, [images, query]);

  const run = async (action: DockerPanelAction) => {
    if (!onAction || busy) return undefined;
    setBusy(action.kind === "image" ? action.operation : action.kind);
    setError("");
    setMessage("");
    try {
      const result = await onAction(action);
      if (result?.images) setImages(result.images);
      if (result?.imageUpdates) {
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
      setBusy(null);
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
    const result = await run({ kind: "image", operation: "remove", reference: imageReference(target) });
    if (result) await refresh();
  };

  const checkUpdates = async () => {
    setOpenMenu("");
    await run({ kind: "image", operation: "check" });
  };

  const upgradeImage = async () => {
    const target = upgradeTarget;
    if (!target) return;
    const reference = imageReference(target);
    const result = await run({
      kind: "image",
      operation: "upgrade",
      reference,
      usedBy: target.usedBy,
      composeTargets: target.composeTargets,
    });
    if (!result) return;
    const upgrade = result.imageUpgrade;
    const finalMessage = upgrade
      ? zhMode
        ? `镜像升级完成：已重建 ${upgrade.composeServices} 个 Compose 服务；${upgrade.standaloneContainers} 个独立容器保持原状。`
        : `Image upgraded: ${upgrade.composeServices} Compose services recreated; ${upgrade.standaloneContainers} standalone containers left unchanged.`
      : result.message || (zhMode ? "镜像升级完成。" : "Image upgrade completed.");
    setUpgradeTarget(null);
    await refresh();
    setImages((current) => current.map((image) =>
      imageReference(image) === reference
        ? { ...image, updateStatus: "current", remoteDigest: target.remoteDigest }
        : image,
    ));
    setMessage(finalMessage);
  };

  return (
    <section className="docker-images-panel" aria-label={zhMode ? "本地镜像" : "Local images"}>
      <header className="docker-images-heading">
        <strong>{zhMode ? "本地镜像" : "Local images"}</strong>
        <div>
          <label className="docker-images-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zhMode ? "搜索镜像" : "Search images"} /></label>
          <button className="docker-images-icon-button" type="button" onClick={() => void refresh()} disabled={!onAction || Boolean(busy)} title={zhMode ? "刷新" : "Refresh"}><RefreshCw size={14} className={busy === "list" ? "is-spinning" : ""} /></button>
          <button className="docker-images-check-button" type="button" onClick={() => void checkUpdates()} disabled={!onAction || Boolean(busy)} title={zhMode ? "手动连接镜像仓库并检查更新" : "Manually contact registries and check for updates"}><RefreshCw size={14} className={busy === "check" ? "is-spinning" : ""} />{zhMode ? "检查更新" : "Check updates"}</button>
          <button className="docker-images-primary" type="button" onClick={() => setPullOpen(true)} disabled={!onAction || Boolean(busy)}><Plus size={14} />{zhMode ? "拉取镜像" : "Pull image"}</button>
        </div>
      </header>

      {error && <div className="docker-images-feedback is-error"><span>{error}</span><button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
      {message && <div className="docker-images-feedback"><span>{message}</span><button type="button" onClick={() => setMessage("")}><X size={13} /></button></div>}

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
                {image.updateStatus === "available" && <button className="docker-image-upgrade-button" type="button" onClick={() => setUpgradeTarget(image)} disabled={Boolean(busy)}><Download size={14} />{zhMode ? "升级" : "Upgrade"}</button>}
              <div className="docker-image-menu-wrap">
                <button className="docker-images-icon-button" type="button" onClick={() => setOpenMenu(openMenu === reference ? "" : reference)} title={zhMode ? "更多" : "More"}><MoreHorizontal size={15} /></button>
                {openMenu === reference && <div className="docker-image-menu">
                  <button type="button" onClick={() => void inspectImage(image)}><Info size={14} />{zhMode ? "详情" : "Details"}</button>
                  {image.updateStatus === "available" && <button type="button" onClick={() => { setOpenMenu(""); setUpgradeTarget(image); }}><Download size={14} />{zhMode ? "升级" : "Upgrade"}</button>}
                  <button className="is-danger" type="button" onClick={() => { setOpenMenu(""); setRemoveTarget(image); }}><Trash2 size={14} />{zhMode ? "删除" : "Remove"}</button>
                </div>}
              </div>
              </div>
            </article>
          );
        }) : <div className="docker-images-empty">{busy === "list" ? (zhMode ? "正在读取镜像…" : "Loading images…") : query ? (zhMode ? "没有匹配的镜像" : "No matching images") : (zhMode ? "暂无本地镜像" : "No local images")}</div>}
      </div>

      {pullOpen && <div className="docker-images-modal-backdrop"><section className="docker-images-modal" role="dialog" aria-modal="true" aria-labelledby="docker-pull-title"><header><strong id="docker-pull-title">{zhMode ? "拉取镜像" : "Pull image"}</strong><button type="button" onClick={() => setPullOpen(false)}><X size={16} /></button></header><label>{zhMode ? "镜像名称" : "Image reference"}<input autoFocus value={pullReference} onChange={(event) => setPullReference(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void pullImage(); }} placeholder="nginx:latest" /></label><footer><button type="button" onClick={() => setPullOpen(false)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-images-primary" type="button" onClick={() => void pullImage()} disabled={!pullReference.trim() || Boolean(busy)}><Download size={14} />{zhMode ? "拉取" : "Pull"}</button></footer></section></div>}

      {removeTarget && <div className="docker-images-modal-backdrop"><section className="docker-images-modal" role="dialog" aria-modal="true" aria-labelledby="docker-remove-title"><header><strong id="docker-remove-title">{zhMode ? "确认删除镜像" : "Remove image"}</strong><button type="button" onClick={() => setRemoveTarget(null)}><X size={16} /></button></header><p>{zhMode ? `确定删除“${imageReference(removeTarget)}”？正在被容器使用的镜像会由 Docker 拒绝删除。` : `Remove “${imageReference(removeTarget)}”? Docker will reject images used by containers.`}</p><footer><button type="button" onClick={() => setRemoveTarget(null)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-images-danger" type="button" onClick={() => void removeImage()} disabled={Boolean(busy)}>{zhMode ? "删除" : "Remove"}</button></footer></section></div>}

      {upgradeTarget && <div className="docker-images-modal-backdrop"><section className="docker-images-modal docker-image-upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="docker-upgrade-title"><header><strong id="docker-upgrade-title">{zhMode ? "升级镜像" : "Upgrade image"}</strong><button type="button" onClick={() => setUpgradeTarget(null)}><X size={16} /></button></header><strong className="docker-image-upgrade-reference">{imageReference(upgradeTarget)}</strong><div className="docker-image-upgrade-summary"><p><Check size={14} />{zhMode ? `受影响容器：${upgradeTarget.usedBy?.length || 0} 个` : `Affected containers: ${upgradeTarget.usedBy?.length || 0}`}</p><p><Check size={14} />{zhMode ? `自动重建 Compose 服务：${upgradeTarget.composeTargets?.length || 0} 个` : `Compose services to recreate: ${upgradeTarget.composeTargets?.length || 0}`}</p>{(upgradeTarget.usedBy?.length || 0) > (upgradeTarget.composeTargets?.length || 0) && <p className="is-warning"><Info size={14} />{zhMode ? "独立容器只拉取新镜像，不会自动重建，以免丢失运行参数。" : "Standalone containers will not be recreated automatically to protect their runtime settings."}</p>}</div><footer><button type="button" onClick={() => setUpgradeTarget(null)}>{zhMode ? "取消" : "Cancel"}</button><button className="docker-images-primary" type="button" onClick={() => void upgradeImage()} disabled={Boolean(busy)}><Download size={14} />{busy === "upgrade" ? (zhMode ? "升级中…" : "Upgrading…") : (zhMode ? "确认升级" : "Upgrade")}</button></footer></section></div>}

      {detailTarget && <div className="docker-images-modal-backdrop"><section className="docker-images-detail-modal" role="dialog" aria-modal="true" aria-labelledby="docker-image-detail-title"><header><div><strong id="docker-image-detail-title">{imageDisplayName(detailTarget)}</strong><span>{detailTarget.id}</span></div><button type="button" onClick={() => setDetailTarget(null)}><X size={16} /></button></header><pre>{detailContent || (busy === "inspect" ? (zhMode ? "正在读取详情…" : "Loading details…") : (zhMode ? "未读取到镜像详情" : "Image details unavailable"))}</pre></section></div>}
    </section>
  );
}
