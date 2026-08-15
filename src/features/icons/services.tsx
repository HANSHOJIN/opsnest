import { useEffect, useState } from "react";
import type { DiscoveredService } from "../../domain/types";
import { iconCandidates, normalizeIconKey, RemoteIcon } from "./catalog";
import dockerIcon from "../../../icons/packed/services/docker.svg?raw";
import nginxIcon from "../../../icons/packed/services/nginx.svg?raw";
import apacheIcon from "../../../icons/packed/services/apache.svg?raw";
import caddyIcon from "../../../icons/packed/services/caddy.svg?raw";
import grafanaIcon from "../../../icons/packed/services/grafana.svg?raw";
import portainerIcon from "../../../icons/packed/services/portainer.svg?raw";
import onePanelIcon from "../../../icons/packed/services/1panel.svg?raw";
import alistIcon from "../../../icons/packed/services/alist.svg?raw";
import openListImage from "../../../icons/services/openlist.png";
import homeBoxImage from "../../../icons/services/homebox.png";
import luckyImage from "../../../icons/services/lucky.png";
import mysqlIcon from "../../../icons/packed/services/mysql.svg?raw";
import mariadbIcon from "../../../icons/packed/services/mariadb.svg?raw";
import postgresqlIcon from "../../../icons/packed/services/postgresql.svg?raw";
import redisIcon from "../../../icons/packed/services/redis.svg?raw";
import mongodbIcon from "../../../icons/packed/services/mongodb.svg?raw";
import phpIcon from "../../../icons/packed/services/php.svg?raw";
import nodeIcon from "../../../icons/packed/services/node.svg?raw";
import pythonIcon from "../../../icons/packed/services/python.svg?raw";
import javaIcon from "../../../icons/packed/services/java.svg?raw";

type ServiceIconTarget = Pick<DiscoveredService, "id" | "category"> & Partial<Pick<DiscoveredService, "name" | "version" | "port" | "web" | "webPath">>;

let activeServiceServerId = "";
let discoveredServiceUpdateAction: ((serverId: string, serviceId: string, port: number, webPath: string) => void) | undefined;

export function setActiveServiceIconServer(serverId: string) {
  activeServiceServerId = serverId;
}

export function setDiscoveredServiceUpdateAction(action: typeof discoveredServiceUpdateAction) {
  discoveredServiceUpdateAction = action;
}

const serviceIcons: Record<string, string> = {
  docker: dockerIcon, nginx: nginxIcon, apache2: apacheIcon, httpd: apacheIcon, caddy: caddyIcon,
  grafana: grafanaIcon, portainer: portainerIcon, "1panel": onePanelIcon, openlist: alistIcon, lucky: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5a9.5 9.5 0 1 0 9.5 9.5A9.5 9.5 0 0 0 12 2.5Zm0 3.1a6.4 6.4 0 1 1-6.4 6.4A6.4 6.4 0 0 1 12 5.6Zm-1.2 2.1v5.5l4.2 2.5 1.1-1.8-3.1-1.8V7.7Z"/></svg>`, mysql: mysqlIcon,
  mysqld: mysqlIcon, mariadb: mariadbIcon, mariadbd: mariadbIcon, postgres: postgresqlIcon,
  postgresql: postgresqlIcon, redis: redisIcon, "redis-server": redisIcon, mongod: mongodbIcon,
  mongodb: mongodbIcon, php: phpIcon, node: nodeIcon, python: pythonIcon, python3: pythonIcon,
  java: javaIcon,
};

const serviceImageIcons: Record<string, string> = {
  openlist: openListImage,
  homebox: homeBoxImage,
  lucky: luckyImage,
};

export function ServiceIcon({ service, serverId, large = false }: { service: ServiceIconTarget; serverId?: string; large?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [editPort, setEditPort] = useState(service.port ? String(service.port) : "");
  const [editPath, setEditPath] = useState(service.webPath ?? "");

  useEffect(() => {
    setEditPort(service.port ? String(service.port) : "");
    setEditPath(service.webPath ?? "");
  }, [service.port, service.webPath]);

  const id = service.id.toLowerCase();
  const iconKey = Object.keys({ ...serviceIcons, ...serviceImageIcons }).find((key) => id === key || id.includes(key));
  const imageIcon = iconKey ? serviceImageIcons[iconKey] : undefined;
  const icon = iconKey && imageIcon
    ? `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><image href="${imageIcon}" width="200" height="200" preserveAspectRatio="xMidYMid meet"/></svg>`
    : iconKey ? serviceIcons[iconKey] : undefined;
  const remoteKey = iconKey ?? normalizeIconKey(service.id || service.name);
  const candidates = iconCandidates(remoteKey, service.version, remoteKey === "openlist" ? ["alist", "open-list"] : []);
  const ownerId = serverId ?? activeServiceServerId;
  const canEdit = Boolean(ownerId && service.category !== "container" && id !== "docker");
  const save = () => {
    const port = Number.parseInt(editPort.trim(), 10);
    if (!ownerId || !Number.isInteger(port) || port < 1 || port > 65535) return;
    discoveredServiceUpdateAction?.(ownerId, service.id, port, editPath);
    setEditing(false);
  };

  return <span className={`service-entry-icon service-icon-${service.category} ${large ? "service-entry-icon-large" : ""}`}>
    <RemoteIcon directory="services" candidates={candidates} fallback={icon} preferFallback={Boolean(icon)} empty={service.category === "panel" ? "▣" : service.category === "database" ? "●" : "✦"} className="service-svg-icon" />
    {canEdit && <>
      <button className="service-icon-edit" type="button" title="Edit entry" aria-label="Edit entry" onClick={(event) => { event.stopPropagation(); setEditing((value) => !value); }}>✎</button>
      {editing && <span className="service-edit-popover" onClick={(event) => event.stopPropagation()}>
        <strong>Edit entry</strong>
        <input aria-label="Port" inputMode="numeric" value={editPort} onChange={(event) => setEditPort(event.target.value)} placeholder="Port" />
        <input aria-label="Management path" value={editPath} onChange={(event) => setEditPath(event.target.value)} placeholder="Management path (optional)" />
        <button type="button" onClick={save}>Save</button>
      </span>}
    </>}
  </span>;
}
