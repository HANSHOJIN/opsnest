import { useEffect, useState } from "react";

export type IconDirectory = "services" | "systems";

const ICON_CATALOG_RAW_BASE = "https://raw.githubusercontent.com/HANSHOJIN/opsnest/main/icons";

/** Build the online icon URL used for raster assets that are not packed into
 * the desktop executable. Keep this in one place so services and systems use
 * the same repository layout and cache-busting behavior. */
export function remoteIconUrl(directory: IconDirectory, candidate: string, type: "svg" | "png" = "svg") {
  return `${ICON_CATALOG_RAW_BASE}/${directory}/${encodeURIComponent(candidate)}.${type}`;
}
const iconMemoryCache = new Map<string, string | null>();
const iconRequests = new Map<string, Promise<string | null>>();

export function normalizeIconKey(value: string | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9@.-]/g, "").replace(/-+/g, "-");
}

function iconVersionKey(value: string | undefined) {
  const match = (value ?? "").match(/(\d+)(?:\.(\d+))?/);
  return match ? `${match[1]}${match[2] ? `.${match[2]}` : ""}` : undefined;
}

function iconCacheKey(directory: IconDirectory, key: string) {
  return `opsnest-icon:v2:${directory}:${key}`;
}

function validSvg(value: string | null) {
  return Boolean(value && /<svg(?:\s|>)/i.test(value));
}

function validIcon(value: string | null) {
  return Boolean(value && (validSvg(value) || value.startsWith("data:image/")));
}

function readCachedIcon(directory: IconDirectory, key: string) {
  const memoryKey = `${directory}/${key}`;
  if (iconMemoryCache.has(memoryKey)) return iconMemoryCache.get(memoryKey) ?? null;
  try {
    const cached = window.localStorage.getItem(iconCacheKey(directory, key));
    if (validIcon(cached)) {
      iconMemoryCache.set(memoryKey, cached);
      return cached;
    }
  } catch {
    // The cache is optional when the webview storage is unavailable.
  }
  return undefined;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function iconDataUri(value: string, type: "svg" | "png") {
  return type === "svg" ? svgDataUri(value) : `data:image/png;base64,${value}`;
}

async function fetchIconCatalog(directory: IconDirectory, candidates: string[]) {
  for (const candidate of candidates) {
    const key = `${directory}/${candidate}`;
    const cached = readCachedIcon(directory, candidate);
    if (cached) return cached;
    if (iconMemoryCache.has(key)) continue;
    if (iconRequests.has(key)) {
      const result = await iconRequests.get(key);
      if (result) return result;
      continue;
    }

    const request = (async () => {
      const readRemoteFile = async (remote: { file: string; type: "svg" | "png" }) => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 2800);
        try {
          const response = await fetch(`${ICON_CATALOG_RAW_BASE}/${remote.file.split("/").map(encodeURIComponent).join("/")}`, { signal: controller.signal });
          if (!response.ok) return null;
          const icon = remote.type === "svg"
            ? await response.text()
            : bytesToBase64(new Uint8Array(await response.arrayBuffer()));
          const value = remote.type === "svg" ? icon : iconDataUri(icon, "png");
          if (!validIcon(value)) return null;
          iconMemoryCache.set(key, value);
          try { window.localStorage.setItem(iconCacheKey(directory, candidate), value); } catch { /* optional cache */ }
          return value;
        } catch {
          return null;
        } finally {
          window.clearTimeout(timeout);
        }
      };

      for (const remote of [
        { file: `${directory}/${candidate}.svg`, type: "svg" as const },
        { file: `${directory}/${candidate}.png`, type: "png" as const },
      ]) {
        const value = await readRemoteFile(remote);
        if (value) return value;
      }

      return null;
    })();
    iconRequests.set(key, request);
    const result = await request;
    iconRequests.delete(key);
    if (result) return result;
    iconMemoryCache.set(key, null);
  }
  return null;
}

export function iconCandidates(key: string, version?: string, aliases: string[] = []) {
  const normalized = normalizeIconKey(key);
  const versioned = iconVersionKey(version);
  return [...new Set([
    ...(versioned && normalized ? [`${normalized}@${versioned}`] : []),
    normalized,
    ...aliases.map(normalizeIconKey),
  ].filter(Boolean))];
}

function svgDataUri(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function RemoteIcon({ directory, candidates, fallback, preferFallback = false, empty = "?", className = "" }: { directory: IconDirectory; candidates: string[]; fallback?: string; preferFallback?: boolean; empty?: string; className?: string }) {
  const useBundled = preferFallback && Boolean(fallback);
  const cacheCandidate = useBundled ? null : candidates.map((candidate) => readCachedIcon(directory, candidate)).find((value): value is string => Boolean(value));
  const [remoteSvg, setRemoteSvg] = useState<string | null>(cacheCandidate ?? null);

  useEffect(() => {
    let cancelled = false;
    if (useBundled || cacheCandidate) return () => { cancelled = true; };
    void fetchIconCatalog(directory, candidates).then((svg) => { if (!cancelled && svg) setRemoteSvg(svg); });
    return () => { cancelled = true; };
  }, [directory, candidates.join("|"), useBundled, cacheCandidate]);

  if (useBundled && fallback) return <span className={className} dangerouslySetInnerHTML={{ __html: fallback }} />;
  if (remoteSvg) return <img className={className} src={remoteSvg.startsWith("data:image/") ? remoteSvg : svgDataUri(remoteSvg)} alt="" aria-hidden="true" />;
  if (fallback) return <span className={className} dangerouslySetInnerHTML={{ __html: fallback }} />;
  return <span className={className} aria-hidden="true">{empty}</span>;
}
