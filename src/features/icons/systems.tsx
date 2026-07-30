import type { ServerProfile } from "../../domain/types";
import { iconCandidates, RemoteIcon } from "./catalog";
import debianIcon from "../../../icons/packed/systems/debian.svg?raw";
import ubuntuIcon from "../../../icons/packed/systems/ubuntu.svg?raw";
import openwrtIcon from "../../../icons/packed/systems/openwrt.svg?raw";
import alpineIcon from "../../../icons/packed/systems/alpine.svg?raw";
import archIcon from "../../../icons/packed/systems/arch.svg?raw";
import fedoraIcon from "../../../icons/packed/systems/fedora.svg?raw";
import centosIcon from "../../../icons/packed/systems/centos.svg?raw";
import rockyIcon from "../../../icons/packed/systems/rocky.svg?raw";
import almaIcon from "../../../icons/packed/systems/alma.svg?raw";
import nixosIcon from "../../../icons/packed/systems/nixos.svg?raw";
import kaliIcon from "../../../icons/packed/systems/kali.svg?raw";
import gentooIcon from "../../../icons/packed/systems/gentoo.svg?raw";
import linuxIcon from "../../../icons/packed/systems/linux.svg?raw";
import freenasIcon from "../../../icons/packed/systems/freenas.svg?raw";
import fnosImage from "../../../icons/packed/systems/fnos.png";

const systemIconMarkup: Record<string, string> = {
  debian: debianIcon,
  ubuntu: ubuntuIcon,
  openwrt: openwrtIcon,
  fnos: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><image href="${fnosImage}" width="1024" height="1024" preserveAspectRatio="xMidYMid meet"/></svg>`,
  nas: freenasIcon,
  alpine: alpineIcon,
  arch: archIcon,
  fedora: fedoraIcon,
  centos: centosIcon,
  rocky: rockyIcon,
  alma: almaIcon,
  nixos: nixosIcon,
  kali: kaliIcon,
  gentoo: gentooIcon,
  linux: linuxIcon,
};

export function getSystemIconKey(profile?: ServerProfile, system?: string) {
  const value = `${profile?.osId ?? ""} ${profile?.osName ?? ""} ${profile?.hostname ?? ""} ${system ?? ""}`.toLowerCase();
  if (profile?.nas?.kind === "fnos" || /fnos|fnnas|feiniu|飞牛/.test(value)) return "fnos";
  if (/truenas|freenas|synology|qnap|openmediavault/.test(value)) return "nas";
  if (/istoreos|immortalwrt|openwrt/.test(value)) return "openwrt";
  if (/debian/.test(value)) return "debian";
  if (/ubuntu|kubuntu|lubuntu/.test(value)) return "ubuntu";
  if (/alpine/.test(value)) return "alpine";
  if (/arch/.test(value)) return "arch";
  if (/fedora/.test(value)) return "fedora";
  if (/centos/.test(value)) return "centos";
  if (/rocky/.test(value)) return "rocky";
  if (/alma/.test(value)) return "alma";
  if (/nixos/.test(value)) return "nixos";
  if (/kali/.test(value)) return "kali";
  if (/gentoo/.test(value)) return "gentoo";
  return "linux";
}

export function SystemIcon({ profile, system }: { profile?: ServerProfile; system?: string }) {
  const iconKey = getSystemIconKey(profile, system);
  const aliases = iconKey === "fnos" ? ["feiniu", "fnos"] : iconKey === "nas" ? ["truenas", "freenas"] : [];
  const candidates = iconCandidates(iconKey, profile?.osVersion ?? profile?.openwrt?.firmware, aliases);
  return <div className={`server-orb system-orb system-${iconKey}`} aria-label={profile?.osName ?? system ?? "Linux"}><RemoteIcon directory="systems" candidates={candidates} fallback={systemIconMarkup[iconKey]} preferFallback className="system-icon-image" /></div>;
}
