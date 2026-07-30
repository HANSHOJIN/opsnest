import type { DiscoveredService } from "../../domain/types";
import { desktopInvoke } from "../../services/desktop";

export function getServiceUrl(host: string, service: DiscoveredService) {
  if (!service.web || !service.port) return "";
  const path = service.webPath?.trim() ?? "";
  const normalizedPath = path ? (path.startsWith("/") ? path : `/${path}`) : "";
  const scheme = service.webScheme ?? "http";
  return `${scheme}://${host}:${service.port}${normalizedPath}`;
}

export function openServiceUrl(url: string) {
  const fallback = () => void desktopInvoke("open_external_url", { url }).catch(() => window.open(url, "_blank", "noopener,noreferrer"));

  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return fallback();

    void desktopInvoke<string>("resolve_service_url", { host: parsed.hostname, port, preferredScheme: null })
      .then((baseUrl) => {
        const suffix = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
        return desktopInvoke("open_external_url", { url: `${baseUrl.replace(/\/$/, "")}${suffix}` });
      })
      .catch(fallback);
  } catch {
    fallback();
  }
}
