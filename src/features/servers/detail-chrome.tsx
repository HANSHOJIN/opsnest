import type { Locale, Server } from "../../domain/types";
import { SystemIcon } from "../icons/systems";
import { getServerStatusLabel } from "./dashboard";
import type { ServerDetailText } from "./detail-contract";

type DetailHeaderProps = {
  server: Server;
  text: ServerDetailText;
  language: Locale;
  eyebrow: string;
  onBack: () => void;
  router?: boolean;
};

export function ServerDetailHeader({ server, text, language, eyebrow, onBack, router = false }: DetailHeaderProps) {
  const zhMode = language === "zh-CN";

  return <header className="server-detail-header"><div><button className="back-link" onClick={onBack}>← {zhMode ? "返回我的服务器" : "Back to my servers"}</button><p className="eyebrow">{eyebrow}</p><div className="server-detail-title"><SystemIcon profile={server.profile} system={server.system} /><div><h1>{server.name}</h1><p>{server.username}@{server.host}:{server.port}</p></div></div></div>{router ? <div className="router-status-group"><span className="network-badge network-badge-lan network-badge-active">● {zhMode ? "内网" : "LAN"}</span><span className="network-badge network-badge-wan network-badge-active">● {zhMode ? "外网" : "WAN"}</span><span className={`connected-badge ${server.status}-badge`}>● {getServerStatusLabel(server.status, language, text)}</span></div> : <span className={`connected-badge ${server.status}-badge`}>● {getServerStatusLabel(server.status, language, text)}</span>}</header>;
}

type DetailActionBarProps = {
  connected: boolean;
  language: Locale;
  onOpen: () => void;
  onConnect: () => void;
  onManager: () => void;
  onEdit: () => void;
};

export function ServerDetailActionBar({ connected, language, onOpen, onConnect, onManager, onEdit }: DetailActionBarProps) {
  const zhMode = language === "zh-CN";

  return <div className="server-detail-actions"><button className="primary" onClick={connected ? onOpen : onConnect}>{connected ? (zhMode ? "打开 SSH 终端" : "Open SSH terminal") : (zhMode ? "连接服务器" : "Connect server")}</button><button className="secondary" onClick={onManager}>{zhMode ? "与服务器总管对话" : "Talk to Butler"}</button><button className="text-button" onClick={onEdit}>{zhMode ? "编辑服务器" : "Edit server"}</button></div>;
}
