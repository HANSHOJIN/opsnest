import { useState } from "react";
import type { DiscoveredService, Locale, Server } from "../../domain/types";
import { getServiceUrl, openServiceUrl } from "./url";

let servicesByServerId: Record<string, DiscoveredService[]> = {};
let serversById: Record<string, Server> = {};
let deleteShortcutAction: ((serverId: string, serviceId: string) => void) | undefined;

export function configureCustomServiceShortcuts(servers: Server[], onDelete: (serverId: string, serviceId: string) => void) {
  servicesByServerId = Object.fromEntries(servers.map((server) => [server.id, server.customServices ?? []]));
  serversById = Object.fromEntries(servers.map((server) => [server.id, server]));
  deleteShortcutAction = onDelete;
}

function CustomServiceShortcutCard({ serverId, service, language, onDelete }: { serverId: string; service: DiscoveredService; language: Locale; onDelete?: (serverId: string, serviceId: string) => void }) {
  const server = serversById[serverId];
  const url = server ? getServiceUrl(server.host, service) : "";
  const zhMode = language === "zh-CN";
  return <article className="service-entry service-entry-active custom-service-shortcut-entry"><div className="service-entry-icon panel-service">＋</div><div className="service-entry-body"><div><h3>{service.name}</h3><span>{zhMode ? `管理面板 · :${service.port}` : `Management panel · :${service.port}`}</span></div><b>{zhMode ? "已添加" : "Added"}</b></div><div className="custom-service-shortcut-actions"><button className="service-entry-button" onClick={() => url && openServiceUrl(url)} disabled={!url}>{zhMode ? "打开管理页" : "Open panel"}</button><button className="custom-service-delete" onClick={() => (onDelete ?? deleteShortcutAction)?.(serverId, service.id)} aria-label={zhMode ? `删除 ${service.name}` : `Delete ${service.name}`}>×</button></div></article>;
}

export function CustomServiceCard({ serverId, language, services = [], onAdd, onDelete }: { serverId: string; language: Locale; services?: DiscoveredService[]; onAdd?: (serverId: string, name: string, port: number) => void; onDelete?: (serverId: string, serviceId: string) => void }) {
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState("");
  const zhMode = language === "zh-CN";
  const savedServices = services.length ? services : servicesByServerId[serverId] ?? [];
  const submit = () => {
    const parsedPort = Number(port.trim());
    if (!name.trim() || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError(zhMode ? "请输入名称和有效端口" : "Enter a name and valid port");
      return;
    }
    onAdd?.(serverId, name.trim(), parsedPort);
    setName("");
    setPort("");
    setError("");
  };
  return <>{savedServices.map((service) => <CustomServiceShortcutCard key={service.id} serverId={serverId} service={service} language={language} onDelete={onDelete} />)}<article className="service-entry custom-service-entry"><div className="service-entry-icon panel-service">＋</div><div className="service-entry-body"><div><h3>{zhMode ? "自定义入口" : "Custom entry"}</h3><span>{zhMode ? "填写名称和端口，用浏览器打开" : "Add a browser shortcut by name and port"}</span></div></div><div className="custom-service-fields"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={zhMode ? "名称" : "Name"} /><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder={zhMode ? "端口" : "Port"} /></div>{error && <small className="custom-service-error">{error}</small>}<button className="service-entry-button" onClick={submit}>{zhMode ? "添加入口" : "Add shortcut"}</button></article></>;
}
