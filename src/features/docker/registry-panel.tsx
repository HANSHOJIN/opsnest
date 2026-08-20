import { Database, RefreshCw, ShieldCheck, ShieldOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DockerPanelAction, DockerPanelActionResult, DockerRegistrySummary } from "./docker-panel";
import "./resources-panel.css";

export function RegistryPanel({
  language,
  onAction,
}: {
  language: "zh-CN" | "en";
  onAction?: (action: DockerPanelAction) => Promise<DockerPanelActionResult | void>;
}) {
  const zhMode = language === "zh-CN";
  const [registries, setRegistries] = useState<DockerRegistrySummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!onAction || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onAction({ kind: "registry", operation: "list" });
      setRegistries(result?.registries || []);
    } catch (reason) {
      setError(String(reason));
      setRegistries([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // This panel mounts only while the Registry section is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="docker-resource-panel" aria-label={zhMode ? "镜像仓库" : "Registry"}>
      <header className="docker-resource-heading"><div><strong>{zhMode ? "镜像仓库" : "Registry"}</strong><span>{zhMode ? "来自 Docker 引擎的仓库与镜像加速配置" : "Registry and mirror configuration from the Docker engine"}</span></div><button type="button" onClick={() => void refresh()} disabled={!onAction || busy} title={zhMode ? "刷新" : "Refresh"}><RefreshCw size={14} className={busy ? "is-spinning" : ""} /></button></header>
      {error && <div className="docker-resource-feedback is-error"><span>{error}</span><button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
      <div className="docker-resource-list">
        {registries.length ? registries.map((registry) => (
          <article className="docker-resource-row" key={registry.name}>
            <span className="docker-resource-icon"><Database size={18} /></span>
            <div className="docker-resource-main"><strong>{registry.name}</strong><span>{registry.mirrors.length ? registry.mirrors.join(" · ") : (zhMode ? "默认仓库端点" : "Default registry endpoint")}</span></div>
            <span className={registry.secure ? "docker-resource-badge is-secure" : "docker-resource-badge is-insecure"}>{registry.secure ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}{registry.secure ? (zhMode ? "安全" : "Secure") : (zhMode ? "非安全" : "Insecure")}</span>
          </article>
        )) : <div className="docker-resource-empty">{busy ? (zhMode ? "正在读取镜像仓库…" : "Loading registries…") : (zhMode ? "未读取到仓库配置" : "No registry configuration found")}</div>}
      </div>
    </section>
  );
}
