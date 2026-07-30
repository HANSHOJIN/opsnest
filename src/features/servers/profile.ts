import type { Server, ServerProfile } from "../../domain/types";

export function hasUsefulServerProfileValue(
  profile: ServerProfile | undefined,
  isUnknownValue: (value: string | undefined) => boolean,
) {
  if (!profile) return false;
  const osName = profile.osName.trim().toLowerCase();
  const osVersion = profile.osVersion?.trim().toLowerCase() ?? "";
  const hasResources = [profile.cpuCores, profile.cpuModel, profile.memory, profile.disk]
    .some((value) => !isUnknownValue(value));
  const hasContainerData = profile.dockerInstalled || Boolean(profile.dockerItems?.length);
  const hasSpecificIdentity = Boolean(osVersion && !isUnknownValue(osVersion))
    || (osName !== "linux" && !isUnknownValue(osName));

  return hasResources || hasContainerData || hasSpecificIdentity;
}

export function normalizeServerProfileValue(
  profile: ServerProfile,
  fallbackHost: string,
  isPlaceholderHostname: (value: string | undefined) => boolean,
): ServerProfile {
  const systemIdentity = `${profile.osId ?? ""} ${profile.osName ?? ""}`.toLowerCase();
  const isOpenWrt = /openwrt|istoreos|immortalwrt/.test(systemIdentity);

  return {
    ...profile,
    openwrt: isOpenWrt ? profile.openwrt : undefined,
    hostname: isPlaceholderHostname(profile.hostname) ? fallbackHost : profile.hostname.trim(),
  };
}

export function buildMachineIdentityValue(server: Server) {
  const profile = server.profile;
  const systemIdentity = `${server.system} ${profile?.osId ?? ""} ${profile?.osName ?? ""}`.toLowerCase();
  const isRouter = /openwrt|istoreos|immortalwrt/.test(systemIdentity);
  const role = isRouter ? "router / gateway" : "Linux server";
  const facts = profile
    ? `OS=${profile.osName}; hostname=${profile.hostname}; CPU=${profile.cpuModel ? `${profile.cpuModel}, ` : ""}${profile.cpuCores}; memory=${profile.memory}; disk=${profile.disk}; Docker=${profile.dockerInstalled ? `${profile.dockerContainers} running` : "not installed"}`
    : `OS=${server.system}; profile not scanned`;
  const routerFacts = isRouter
    ? `Router profile: iStoreOS/OpenWrt family; role=${role}; configuration model=UCI; firewall model=firewall4/nftables when available; network concepts=WAN, LAN, DHCP, NAT and port forwarding. ${profile?.openwrt ? `firmware=${profile.openwrt.firmware}; kernel=${profile.openwrt.kernel}; WAN=${profile.openwrt.wanIp}; LAN=${profile.openwrt.lanIp}; LAN clients=${profile.openwrt.lanClients}` : "Router details still need to be explored."}`
    : `Machine role=${role}; do not assume router-specific configuration unless evidence confirms it.`;
  const nasFacts = profile?.nas ? `NAS profile: ${profile.nas.kind}; management port=${profile.nas.managementPort}; use NAS application, Docker and storage context when interpreting requests.` : "";
  const services = [...(server.services ?? []), ...(server.customServices ?? [])]
    .map((service) => `${service.name}${service.port ? `:${service.port}` : ""}`)
    .join(", ");

  return `Machine identity: ${server.name} (${server.username}@${server.host}:${server.port})\n${facts}\n${routerFacts}\n${nasFacts}\nDiscovered services: ${services || "not scanned"}`;
}
