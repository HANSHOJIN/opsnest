import type { Locale, Server, ServerStatus } from "../../domain/types";
import { SystemIcon } from "../icons/systems";
import { formatLatency, getLatencyClass } from "./presentation";

export type DashboardText = {
  hosts: string;
  addServer: string;
  cpu: string;
  memory: string;
  disk: string;
  docker: string;
  installedRunning: (count: string) => string;
  notInstalled: string;
  connectFirst: string;
  startConnect: string;
};

export type ServerStatusText = { connected: string; notConnected: string };

export function getServerStatusLabel(status: ServerStatus, language: Locale, text: ServerStatusText) {
  if (status === "connecting") return language === "zh-CN" ? "连接中" : "Connecting";
  if (status === "failed") return language === "zh-CN" ? "连接失败" : "Connection failed";
  return status === "connected" ? text.connected : text.notConnected;
}

export function ServerDashboard({ servers, text, language, modelStatusClass, modelStatusLabel, onAdd, onOpen, onConnect, onEdit }: { servers: Server[]; text: DashboardText; language: Locale; modelStatusClass: string; modelStatusLabel: string; onAdd: () => void; onOpen: (server: Server) => void; onConnect: (server: Server) => void; onEdit: (server: Server) => void }) {
  return <section className="dashboard-view">
    <header className="dashboard-header"><div><p className="eyebrow">OpsNest</p><h1>{text.hosts}</h1><span>{servers.length ? (language === "zh-CN" ? `${servers.length} 台服务器` : `${servers.length} server${servers.length === 1 ? "" : "s"}`) : (language === "zh-CN" ? "还没有服务器" : "No servers yet")}</span></div><div className="dashboard-header-actions"><span className={`status-pill ${modelStatusClass}`}>{modelStatusLabel}</span><button className="primary" onClick={onAdd}>＋ {text.addServer}</button></div></header>
    {servers.length ? <div className="dashboard-grid">{servers.map((item) => {
      const profile = item.profile;
      const primaryLabel = item.status === "connected" ? (language === "zh-CN" ? "打开 SSH" : "Open SSH") : item.status === "connecting" ? (language === "zh-CN" ? "连接中…" : "Connecting…") : (language === "zh-CN" ? "连接服务器" : "Connect");
      return <article className="dashboard-card" key={item.id} onDoubleClick={() => onOpen(item)}>
        <div className="dashboard-card-header"><div className="dashboard-card-title"><SystemIcon profile={profile} system={item.system} /><div><h2>{item.name}</h2><p>{item.username}@{item.host}:{item.port}</p></div></div><span className={`connected-badge ${item.status}-badge`}>● {getServerStatusLabel(item.status, language, { connected: language === "zh-CN" ? "已连接" : "Connected", notConnected: language === "zh-CN" ? "未连接" : "Offline" })}</span></div>
        <div className="dashboard-meta"><span className={`latency-badge ${getLatencyClass(item.latency)}`}>{formatLatency(item.latency, language)}</span><span>{profile?.osName ?? item.system}</span></div>
        {profile ? <div className="dashboard-metrics"><div><span>{text.cpu}</span><strong>{profile.cpuCores} {language === "zh-CN" ? "核" : "cores"}</strong></div><div><span>{text.memory}</span><strong>{profile.memory}</strong></div><div><span>{text.disk}</span><strong>{profile.disk}</strong></div><div><span>{text.docker}</span><strong>{profile.dockerInstalled ? text.installedRunning(String(profile.dockerContainers)) : text.notInstalled}</strong></div></div> : <div className="dashboard-unscanned">{language === "zh-CN" ? "连接后可读取服务器资源信息" : "Connect to read server resources"}</div>}
        <div className="dashboard-actions"><button className="primary small-button" onClick={(event) => { event.stopPropagation(); item.status === "connected" ? onOpen(item) : onConnect(item); }} disabled={item.status === "connecting"}>{primaryLabel}</button><button className="text-button" onClick={(event) => { event.stopPropagation(); onEdit(item); }}>{language === "zh-CN" ? "编辑" : "Edit"}</button></div>
      </article>;
    })}</div> : <div className="dashboard-empty"><div className="dashboard-empty-icon">⌁</div><h2>{text.connectFirst}</h2><p>{language === "zh-CN" ? "添加服务器后，这里会显示它的运行状态和资源概览。" : "Add a server to see its status and resource overview here."}</p><button className="primary" onClick={onAdd}>{text.startConnect}</button></div>}
  </section>;
}
