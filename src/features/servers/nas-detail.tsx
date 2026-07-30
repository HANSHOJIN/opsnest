import { DockerContainersPanel } from "../docker/containers-panel";
import { ServiceIcon, setActiveServiceIconServer } from "../icons/services";
import { CustomServiceCard } from "../services/custom-shortcuts";
import { getServiceUrl, openServiceUrl } from "../services/url";
import { ServerDetailActionBar, ServerDetailHeader } from "./detail-chrome";
import type { ServerDetailProps } from "./detail-contract";
import { getDockerService, getServiceStatusLabel } from "./detail-helpers";
import { buildNasDetailMetrics } from "./detail-metrics";

export function NasServerDetailView({ server, text, language, onBack, onOpen, onConnect, onScan, isScanning, onDiscover, isDiscovering, onEdit, onManager, onCron, onAddCustomService }: ServerDetailProps) {
  setActiveServiceIconServer(server.id);
  const zhMode = language === "zh-CN";
  const profile = server.profile ? { ...server.profile } : undefined;
  const connected = server.status === "connected";
  const allServices = [...(server.services ?? []), ...(server.customServices ?? [])];
  const services = allServices.filter((service) => service.web && service.port);
  const dockerService = getDockerService(allServices);
  const dockerInstalled = Boolean(profile?.dockerInstalled || dockerService);
  if (profile && dockerInstalled) profile.dockerInstalled = true;
  const detailMetrics = buildNasDetailMetrics(server, text);
  const displayName = profile?.nas?.kind === "fnos" ? "Feiniu fnOS" : "NAS";
  const statusLabel = (status: string) => getServiceStatusLabel(status, zhMode);

  return <section className="server-detail-view nas-detail-view">{isDiscovering && <div className="discovery-progress-banner">{zhMode ? "正在发现服务…" : "Discovering services…"}</div>}
    <ServerDetailHeader server={server} text={text} language={language} eyebrow={displayName} onBack={onBack} />
    <ServerDetailActionBar connected={connected} language={language} onOpen={onOpen} onConnect={onConnect} onManager={onManager} onEdit={onEdit} />
    <section className="nas-overview-card"><div className="nas-overview-heading"><div><p className="eyebrow">{displayName}</p><h2>{zhMode ? "存储与服务" : "Storage and services"}</h2><span>{profile?.nas?.version && profile.nas.version !== "unknown" ? profile.nas.version : (zhMode ? "连接后读取系统与应用服务" : "System and app services read after connection")}</span></div><button className="text-button" onClick={onScan} disabled={!connected || isScanning}>{isScanning ? (zhMode ? "扫描中…" : "Scanning…") : (zhMode ? "重新扫描" : "Rescan") }</button></div><div className="detail-metric-grid">{detailMetrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section>
    {profile?.dockerInstalled && <section className="docker-overview-card"><div className="docker-card-heading"><div className="docker-brand"><ServiceIcon service={{ id: "docker", category: "container" }} large /><div><p className="eyebrow">Docker</p><h2>{zhMode ? "容器概览" : "Container overview"}</h2><span>{zhMode ? "NAS 上的容器与端口入口" : "Containers and web entry points on this NAS"}</span></div></div><span className="connected-badge">● {dockerService?.status === "running" ? (zhMode ? "运行中" : "Running") : (zhMode ? "已安装" : "Installed")}</span></div><div className="docker-card-stats"><div><span>{zhMode ? "运行中容器" : "Running containers"}</span><strong>{profile.dockerContainers}</strong></div><div><span>{zhMode ? "Docker 版本" : "Docker version"}</span><strong>{dockerService?.version || "—"}</strong></div><div><span>{zhMode ? "管理方式" : "Management"}</span><strong>SSH</strong></div><div><span>{zhMode ? "数据来源" : "Source"}</span><strong>{zhMode ? "服务器扫描" : "Server scan"}</strong></div></div><DockerContainersPanel server={server} containers={profile.dockerItems ?? []} language={language} /></section>}
    <section className="detail-section nas-services-section"><div className="detail-section-heading"><div><p className="eyebrow">{zhMode ? "服务入口" : "Service entry points"}</p><h2>{zhMode ? "NAS 应用" : "NAS applications"}</h2><span>{zhMode ? "自动识别管理页面和可访问端口。" : "Management pages and reachable ports discovered automatically."}</span></div><button className="text-button" onClick={onDiscover} disabled={!connected}>{zhMode ? "重新发现" : "Discover again"}</button></div>{services.length ? <div className="router-service-grid">{services.map((service) => { const url = getServiceUrl(server.host, service); return <article className={`router-service-card ${service.status === "running" ? "router-service-running" : ""}`} key={service.id}><div className="router-service-card-top"><ServiceIcon service={service} serverId={server.id} large /><span className="router-service-status">● {statusLabel(service.status)}</span></div><h3>{service.name}</h3><p>{service.version || (zhMode ? "NAS 服务" : "NAS service")}</p><small>{zhMode ? "端口" : "Port"} :{service.port}</small><button className="service-entry-button" onClick={() => openServiceUrl(url)}>{zhMode ? "打开管理页" : "Open panel"}</button></article>; })}<CustomServiceCard serverId={server.id} language={language} onAdd={onAddCustomService} /></div> : <div className="service-discovery-empty"><strong>{zhMode ? "尚未发现应用入口" : "No application entry points yet"}</strong><span>{zhMode ? "点击重新发现，OpsNest 会扫描 fnOS、Docker 和常见管理端口。" : "Run discovery to scan fnOS, Docker and common management ports."}</span><button className="secondary" onClick={onDiscover} disabled={!connected}>{zhMode ? "立即发现" : "Discover now"}</button></div>}</section>
    <div className="router-bottom-grid"><button className="quick-action" onClick={onOpen}><span>⌁</span><div><strong>{zhMode ? "原生 SSH 终端" : "Native SSH terminal"}</strong><small>{zhMode ? "进入 NAS 命令行" : "Open the NAS shell"}</small></div></button><button className="quick-action" onClick={onCron}><span>▦</span><div><strong>{zhMode ? "定时任务" : "Scheduled tasks"}</strong><small>{zhMode ? "管理服务器上的 Cron" : "Manage server-side Cron"}</small></div></button></div>
  </section>;
}
