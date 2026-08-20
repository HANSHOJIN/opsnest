import { Info, Network, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DockerNetworkSummary, DockerPanelAction, DockerPanelActionResult } from "./docker-panel";
import "./resources-panel.css";

export function NetworkPanel({
  language,
  onAction,
}: {
  language: "zh-CN" | "en";
  onAction?: (action: DockerPanelAction) => Promise<DockerPanelActionResult | void>;
}) {
  const zhMode = language === "zh-CN";
  const [networks, setNetworks] = useState<DockerNetworkSummary[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [detailNetwork, setDetailNetwork] = useState<DockerNetworkSummary | null>(null);
  const [detailContent, setDetailContent] = useState("");

  const filteredNetworks = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return networks;
    return networks.filter((network) => `${network.name} ${network.id} ${network.driver} ${network.scope}`.toLowerCase().includes(value));
  }, [networks, query]);

  const run = async (action: DockerPanelAction) => {
    if (!onAction || busy) return undefined;
    setBusy(action.kind === "network" ? action.operation : action.kind);
    setError("");
    try {
      const result = await onAction(action);
      if (result?.networks) setNetworks(result.networks);
      return result;
    } catch (reason) {
      setError(String(reason));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    await run({ kind: "network", operation: "list" });
  };

  useEffect(() => {
    void refresh();
    // This panel mounts only while the Network section is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inspectNetwork = async (network: DockerNetworkSummary) => {
    setDetailNetwork(network);
    setDetailContent("");
    const result = await run({ kind: "network", operation: "inspect", name: network.name });
    if (result?.message !== undefined) setDetailContent(result.message);
  };

  return (
    <section className="docker-resource-panel" aria-label={zhMode ? "Docker 网络" : "Docker networks"}>
      <header className="docker-resource-heading"><div><strong>{zhMode ? "网络" : "Networks"}</strong><span>{zhMode ? "Docker 引擎中的网络与驱动" : "Networks and drivers from the Docker engine"}</span></div><div className="docker-resource-toolbar"><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zhMode ? "搜索网络" : "Search networks"} /></label><button type="button" onClick={() => void refresh()} disabled={!onAction || Boolean(busy)} title={zhMode ? "刷新" : "Refresh"}><RefreshCw size={14} className={busy === "list" ? "is-spinning" : ""} /></button></div></header>
      {error && <div className="docker-resource-feedback is-error"><span>{error}</span><button type="button" onClick={() => setError("")}><X size={13} /></button></div>}
      <div className="docker-resource-list">
        {filteredNetworks.length ? filteredNetworks.map((network) => (
          <article className="docker-resource-row" key={network.id || network.name}>
            <span className="docker-resource-icon"><Network size={18} /></span>
            <div className="docker-resource-main"><strong>{network.name}</strong><span>{network.id}</span></div>
            <div className="docker-network-meta"><span>{network.driver || "—"}</span><small>{network.scope || "—"}</small></div>
            <button className="docker-resource-action" type="button" onClick={() => void inspectNetwork(network)} disabled={Boolean(busy)} title={zhMode ? "网络详情" : "Network details"}><Info size={14} /></button>
          </article>
        )) : <div className="docker-resource-empty">{busy === "list" ? (zhMode ? "正在读取网络…" : "Loading networks…") : query ? (zhMode ? "没有匹配的网络" : "No matching networks") : (zhMode ? "暂无 Docker 网络" : "No Docker networks")}</div>}
      </div>
      {detailNetwork && <div className="docker-resource-modal-backdrop"><section className="docker-resource-detail-modal" role="dialog" aria-modal="true" aria-labelledby="docker-network-title"><header><div><strong id="docker-network-title">{detailNetwork.name}</strong><span>{detailNetwork.driver} · {detailNetwork.scope}</span></div><button type="button" onClick={() => setDetailNetwork(null)}><X size={16} /></button></header><pre>{detailContent || (busy === "inspect" ? (zhMode ? "正在读取网络详情…" : "Loading network details…") : (zhMode ? "未读取到网络详情" : "Network details unavailable"))}</pre></section></div>}
    </section>
  );
}
