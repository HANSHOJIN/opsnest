import type { Server, ServerProfile } from "../../domain/types";
import type { ServerDetailText } from "./detail-contract";

export type DetailMetric = readonly [label: string, value: string];

export function buildStandardDetailMetrics(server: Server, text: ServerDetailText, zhMode: boolean): DetailMetric[] {
  const profile = server.profile;

  return [
    [text.system, profile?.osName ?? server.system],
    [text.hostname, profile?.hostname ?? (zhMode ? "尚未读取" : "Not scanned")],
    [text.cpu, profile?.cpuCores ? `${profile.cpuCores} ${zhMode ? "核" : "cores"}` : "—"],
    [text.memory, profile?.memory ?? "—"],
    [text.disk, profile?.disk ?? "—"],
    [text.docker, profile?.dockerInstalled ? text.installedRunning(profile.dockerContainers) : profile ? text.notInstalled : "—"],
  ];
}

export function buildNasDetailMetrics(server: Server, text: ServerDetailText): DetailMetric[] {
  const profile = server.profile;

  return [
    [text.system, profile?.osName ?? server.system],
    [text.hostname, profile?.hostname ?? "—"],
    [text.cpu, profile?.cpuModel || profile?.cpuCores || "—"],
    [text.memory, profile?.memory ?? "—"],
    [text.disk, profile?.disk ?? "—"],
    [text.docker, profile?.dockerInstalled ? text.installedRunning(profile.dockerContainers) : profile ? text.notInstalled : "—"],
  ];
}

export function buildRouterOverviewFooter(server: Server, profile: ServerProfile | undefined, zhMode: boolean) {
  const cpuSummary = [profile?.cpuCores, profile?.cpuModel]
    .filter((value) => value && value !== "未知" && value !== "unknown")
    .join(" · ") || "—";

  if (zhMode) {
    return `系统：${profile?.osName ?? server.system} · CPU：${cpuSummary} · 内存：${profile?.memory ?? "—"} · 磁盘：${profile?.disk ?? "—"}`;
  }

  return `System: ${profile?.osName ?? server.system} · CPU: ${cpuSummary} · Memory: ${profile?.memory ?? "—"} · Disk: ${profile?.disk ?? "—"}`;
}
