import type { ServerProfile } from "../../domain/types";

export function isOpenWrtProfile(profile?: ServerProfile) {
  const value = `${profile?.osId || ""} ${profile?.osName || ""} ${profile?.hostname || ""}`;
  return /openwrt|istoreos|immortalwrt/i.test(value);
}

export function isNasProfile(profile?: ServerProfile, label = "") {
  const value = `${profile?.osId ?? ""} ${profile?.osName ?? ""} ${profile?.hostname ?? ""} ${label}`.toLowerCase();
  return profile?.nas?.kind === "fnos" || /fnos|fnnas|feiniu|飞牛|truenas|freenas|synology|qnap|openmediavault/.test(value);
}
