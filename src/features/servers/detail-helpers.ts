import type { DiscoveredService } from "../../domain/types";

export function getDockerService(services: DiscoveredService[]) {
  return services.find((service) => service.id.toLowerCase() === "docker");
}

export function getVisibleWebServices(services: DiscoveredService[]) {
  return services.filter((service) => service.id.toLowerCase() !== "docker" && !service.id.startsWith("custom-") && service.web && service.port);
}

export function getServiceCategoryLabel(category: string, zhMode: boolean) {
  return ({ panel: zhMode ? "管理面板" : "Panel", container: "Container", web: "Web server", runtime: "Runtime", database: "Database" }[category] ?? category);
}

export function getServiceStatusLabel(status: string, zhMode: boolean) {
  return status === "running" ? (zhMode ? "运行中" : "Running") : status === "installed" ? (zhMode ? "已安装" : "Installed") : (zhMode ? "已发现" : "Detected");
}

export function getRouterServiceStatusLabel(status: string, zhMode: boolean) {
  return status === "running" ? (zhMode ? "运行中" : "Running") : (zhMode ? "已安装" : "Installed");
}

export function displayRouterValue(value: string | undefined, fallback: string) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return value && normalized !== "unknown" && !normalized.includes("default string") && !normalized.includes("to be filled by o.e.m") && normalized !== "system product name" ? value : fallback;
}
