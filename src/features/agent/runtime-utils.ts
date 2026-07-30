import type { ShellPlan } from "../../domain/types";

export function redactLogText(value: string) {
  return value
    .replace(/(password|passwd|api[_-]?key|authorization|bearer|token|secret|密码|口令)\s*[:=：]?\s*[^\s,;，；]+/gi, "$1=***")
    .replace(/\b(?:sk|gsk|xai)-[A-Za-z0-9_-]{12,}\b/g, "***")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "***")
    .slice(0, 12000);
}

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function isHighRiskCommand(command: string) {
  return /\brm\s+-rf\b|\bmkfs(?:\.|\s)|\bdd\s+if=|\bdrop\s+(?:database|table)|\bshutdown\b|\breboot\b|\bpoweroff\b|\biptables\b|\bufw\s+delete|:\s*>\s*\/|\bchmod\s+777\b/i.test(command);
}

export function isReadOnlyPlan(command: string, risk?: ShellPlan["risk"]) {
  if (isHighRiskCommand(command)) return false;
  if (risk === "low") return true;
  return /^(?:apt(?:-get)?\s+(?:list|show|policy|search)|dpkg\s+-l|rpm\s+-qa|dnf\s+(?:list|info)|yum\s+(?:list|info)|pacman\s+-Q|command\s+-v|which\s+|type\s+|systemctl\s+(?:status|is-active|is-enabled|list-units|list-sockets|list-timers)|docker\s+(?:ps|images|info|inspect|version)|ss\s|netstat\s|df\s|du\s|free\s|uname\s|uptime\b|hostname\b|whoami\b|id\b|ps\s|cat\s|grep\s|head\s|tail\s|find\s)/i.test(command.trim());
}

export function isRecoverableAgentFailure(output: string) {
  return /command not found|not found|no such file or directory|unknown command|cannot execute/i.test(output);
}
