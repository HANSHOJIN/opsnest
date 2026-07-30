import { useState } from "react";
import type { DockerContainer, Locale, Server } from "../../domain/types";
import { ServiceIcon } from "../icons/services";
import { openServiceUrl } from "../services/url";

function getHostPort(container: DockerContainer) {
  const mappings: Array<{ host: string; container: string }> = [];
  const mappingPattern = /(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::):?(\d+)->(\d+)\/(?:tcp|udp)/gi;
  let match: RegExpExecArray | null;
  while ((match = mappingPattern.exec(container.ports)) !== null) {
    mappings.push({ host: match[1], container: match[2] });
  }
  const mediaHelper = /(?:^|[-_])(mediahelper|mediahelp|mh-private)(?:$|[-_:])/i.test(`${container.name}-${container.image}`);
  if (mediaHelper) return mappings.find((mapping) => mapping.container === "80")?.host ?? "3300";
  return mappings[0]?.host ?? "";
}

export function DockerContainersPanel({ server, containers, language }: { server: Server; containers: DockerContainer[]; language: Locale }) {
  const [expanded, setExpanded] = useState(containers.length > 0);
  const zhMode = language === "zh-CN";
  return <div className="docker-containers-panel">
    <button className="docker-expand-button" onClick={() => setExpanded((value) => !value)}>{expanded ? (zhMode ? "收起容器" : "Collapse containers") : (zhMode ? "展开全部容器（" : "Show all containers (") + containers.length + (zhMode ? "）" : ")")}</button>
    {expanded && <div className="docker-container-list">{containers.length ? <>
      <div className="docker-container-list-heading"><div><strong>{zhMode ? "容器" : "Containers"}</strong><span>{zhMode ? "服务器上的全部 Docker 容器" : "All Docker containers on this server"}</span></div><b>{containers.length}</b></div>
      {containers.map((container) => {
        const hostPort = getHostPort(container);
        const url = hostPort ? `http://${server.host}:${hostPort}` : "";
        const running = /^(?:up|running)\b/i.test(container.status);
        return <article className="docker-container-row" key={container.id}><div className="docker-container-identity"><span className="docker-container-icon"><ServiceIcon service={{ id: "docker", category: "container" }} /></span><div className="docker-container-main"><strong>{container.name}</strong><span>{container.image}</span></div></div><div className="docker-container-details"><span className={`docker-container-status ${running ? "running" : "stopped"}`}>● {running ? (zhMode ? "运行中" : "Running") : (zhMode ? "已停止" : "Stopped")}</span><small>{container.status}</small><small>{container.ports || (zhMode ? "未映射端口" : "No published ports")}</small></div><div className="docker-container-actions">{url ? <button className="docker-port-button" onClick={() => openServiceUrl(url)}>{zhMode ? `打开 ${hostPort}` : `Open ${hostPort}`}</button> : <span className="docker-no-port">{zhMode ? "无端口" : "No port"}</span>}</div></article>;
      })}</> : <span className="docker-empty-text">{zhMode ? "尚未读取容器明细，请刷新状态。" : "Container details are not available yet. Refresh the scan."}</span>}</div>}
  </div>;
}
