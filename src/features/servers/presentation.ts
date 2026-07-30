export function formatLatency(latency: number | undefined, _language: string) {
  return latency === undefined ? "—" : `${latency}ms`;
}

export function getLatencyClass(latency: number | undefined) {
  if (latency === undefined) return "empty";
  if (latency <= 100) return "good";
  if (latency <= 200) return "warn";
  return "bad";
}

export function getNetworkScope(host: string): "lan" | "wan" {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1" || /\.(local|lan|internal|home)$/.test(value)) return "lan";
  if (value.includes(":")) return /^(fc|fd|fe80:)/.test(value) ? "lan" : "wan";

  const octets = value.split(".").map(Number);
  if (octets.length === 4 && octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    const [first, second] = octets;
    if (first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254)) return "lan";
  }

  return "wan";
}
