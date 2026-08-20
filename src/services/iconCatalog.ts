export type IconDirectory = "services" | "systems";

// The packed catalog is deliberately SVG-only. Raster artwork is kept in the
// online/runtime icon directories and is resolved through the remote loader;
// this prevents PNGs from silently entering the EXE bundle again.
const packedServiceIcons = import.meta.glob("../../icons/packed/services/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;
const packedSystemIcons = import.meta.glob("../../icons/packed/systems/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

export function iconDirectory(kind: string, name: string): IconDirectory {
  const key = `${kind} ${name}`.toLowerCase();
  // A router's discovery kind may contain "OpenWrt", but the discovered
  // entry can still be an application/service. Resolve those names before
  // the system-directory fallback so their bundled service icons are used.
  if (/docker|container|nginx|apache|caddy|openlist|open-list|alist|lucky|luci|uhttpd|dropbear|grafana|portainer|1panel|mysql|mariadb|postgres|redis|mongo|php|node|python|java/.test(name.toLowerCase()))
    return "services";
  return key.includes("system") || key.includes("linux") || key.includes("debian") || key.includes("ubuntu") || key.includes("windows") || /openwrt|istoreos|immortalwrt|router|路由器|fnos|feiniu|macos|darwin|proxmox/.test(key) ? "systems" : "services";
}

/** V2 keeps the V1 two-directory contract; individual keys live inside a directory. */
export const ICON_CATALOG: Record<IconDirectory, readonly string[]> = {
  services: ["docker", "nginx", "apache", "mysql", "postgres", "redis", "mongodb", "openlist", "alist", "luci", "uhttpd", "web", "port", "generic"],
  systems: ["linux", "debian", "ubuntu", "alibaba", "amazon", "alpine", "istoreos", "openwrt", "fnos", "mac", "proxmox-pve", "nas", "windows", "generic"],
};

export function normalizeIconKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9@.-]/g, "").replace(/-+/g, "-");
}

export function bundledIconUrl(
  directory: IconDirectory,
  candidate: string,
  type: "svg" | "png",
): string | undefined {
  const table = directory === "services" ? packedServiceIcons : packedSystemIcons;
  const suffix = `/${normalizeIconKey(candidate)}.${type}`;
  const path = Object.keys(table).find((entry) => entry.endsWith(suffix));
  return path ? table[path] : undefined;
}

function iconVersionKey(value: string | undefined): string | undefined {
  const match = (value ?? "").match(/(\d+)(?:\.(\d+))?/);
  return match ? `${match[1]}${match[2] ? `.${match[2]}` : ""}` : undefined;
}

/** Version match comes first, then the unversioned key, aliases, and only then generic. */
export function iconCandidates(key: string, version?: string, aliases: string[] = []): string[] {
  const normalized = normalizeIconKey(key);
  const versioned = iconVersionKey(version);
  return [...new Set([
    ...(versioned && normalized ? [`${normalized}@${versioned}`] : []),
    normalized,
    ...aliases.map(normalizeIconKey),
    "generic",
  ].filter(Boolean))];
}

/**
 * Build data-driven icon candidates for arbitrary containers. Runtime names
 * and image repository basenames are expanded with common UI/app suffixes so
 * an online icon can survive harmless container renames without adding a
 * product-specific alias to the application code.
 */
export function containerIconAliases(name: string, imageReference?: string): string[] {
  const imageLeaf = (() => {
    const reference = (imageReference || "").trim().split("@")[0] || "";
    const leaf = reference.slice(reference.lastIndexOf("/") + 1);
    const tagIndex = leaf.lastIndexOf(":");
    return tagIndex > 0 ? leaf.slice(0, tagIndex) : leaf;
  })();
  const candidates: string[] = [];
  for (const seed of [name, imageLeaf].map(normalizeIconKey).filter(Boolean)) {
    const base = seed.replace(/-(?:app|web|ui|server|service)$/, "") || seed;
    candidates.push(seed, base, `${base}-app`, `${base}-web`, `${base}-ui`);
  }
  return [...new Set(candidates)];
}

export function remoteIconUrl(directory: IconDirectory, candidate: string, type: "svg" | "png" = "svg"): string {
  return `https://raw.githubusercontent.com/HANSHOJIN/opsnest/main/icons/${directory}/${encodeURIComponent(candidate)}.${type}`;
}

export type IconResolution = { source: "bundled" | "online" | "generic"; candidate: string; url?: string };

/** Resolution policy shared by server cards and discovered-service entries. */
export function resolveIcon(directory: IconDirectory, key: string, version: string | undefined, bundledKeys: readonly string[] = [], aliases: string[] = []): IconResolution {
  const candidates = iconCandidates(key, version, aliases);
  const bundled = candidates.find((candidate) => bundledKeys.includes(candidate));
  if (bundled) return { source: "bundled", candidate: bundled };
  const online = candidates.find((candidate) => candidate !== "generic");
  if (online) return { source: "online", candidate: online, url: remoteIconUrl(directory, online) };
  return { source: "generic", candidate: "generic" };
}

export function iconCacheKey(directory: IconDirectory, key: string): string {
  return `opsnest-icon:v2:${directory}:${normalizeIconKey(key)}`;
}
