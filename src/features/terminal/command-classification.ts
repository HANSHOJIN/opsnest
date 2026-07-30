const shellCommandNames = new Set([
  "alias", "apt", "awk", "cat", "cd", "chmod", "chown", "clear", "cp", "curl", "df", "docker", "du", "echo", "env", "find", "git", "grep", "head", "hostname", "journalctl", "kill", "less", "ls", "mkdir", "mv", "nginx", "ping", "ps", "pwd", "rm", "sed", "ss", "ssh", "systemctl", "tail", "tar", "top", "touch", "uname", "uptime", "whoami",
]);

export function isLikelyShellCommand(input: string) {
  const trimmed = input.trim();
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (shellCommandNames.has(firstWord)) return true;
  if (/^(sudo|doas)\s+\S+/.test(trimmed) || /^[.\/][\w./-]+/.test(trimmed) || /\|\s*[a-z][\w-]*|&&|;\s*[a-z][\w-]*/i.test(trimmed)) return true;
  // Unknown third-party CLI commands such as hermes update stay raw SSH commands.
  return /^[a-z_][\w.-]*\s+[\w./:@%+=~-]+(?:\s|$)/i.test(trimmed);
}

export function isInteractiveShellCommand(input: string) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(?:vim|vi|nvim|nano|emacs|top|htop|btop|less|more|man|watch|fzf|dialog|whiptail|mysql|mariadb|psql|python|python3|ipython|node|bash|zsh|fish|sftp|ftp)\b/.test(normalized)) return true;
  return /^(?:sudo|doas)(?:\s+[^\s-][^\s]*)?\s+/.test(normalized) && !/^(?:sudo|doas)\s+-n\b/.test(normalized);
}
