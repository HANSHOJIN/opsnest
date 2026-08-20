const shellCommandNames = new Set([
  "alias", "apt", "awk", "cat", "cd", "chmod", "chown", "clear", "cp", "curl", "df", "docker", "du", "echo", "env", "find", "git", "grep", "head", "hostname", "journalctl", "kill", "less", "ls", "mkdir", "mv", "nginx", "ping", "ps", "pwd", "rm", "sed", "ss", "ssh", "systemctl", "tail", "tar", "top", "touch", "uname", "uptime", "whoami",
]);

export function isLikelyShellCommand(input: string) {
  const trimmed = input.trim();
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (shellCommandNames.has(firstWord)) return true;
  // Bash users commonly type directory changes as `cd..`, `cd.` or `cd/`.
  // These are still raw shell input (even when the remote shell later reports
  // that the exact spelling is invalid), so never send them through the AI
  // task/chat pipeline where an older task could influence the result.
  if (/^cd(?:\s|[.~\/])/i.test(trimmed)) return true;
  if (/^(sudo|doas)\s+\S+/.test(trimmed) || /^[.\/][\w./-]+/.test(trimmed) || /\|\s*[a-z][\w-]*|&&|;\s*[a-z][\w-]*/i.test(trimmed)) return true;
  // Unknown third-party CLI commands such as hermes update stay raw SSH commands.
  return /^[a-z_][\w.-]*\s+[\w./:@%+=~-]+(?:\s|$)/i.test(trimmed);
}

export function isInteractiveShellCommand(input: string) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(?:vim|vi|nvim|nano|emacs|top|htop|btop|less|more|man|watch|fzf|dialog|whiptail|mysql|mariadb|psql|python|python3|ipython|node|bash|zsh|fish|sftp|ftp)\b/.test(normalized)) return true;
  const words = normalized.split(/\s+/);
  if (words[0] !== "sudo" && words[0] !== "doas") return false;
  let index = 1;
  let interactiveOption = false;
  let command = "";
  while (index < words.length) {
    const word = words[index];
    if (word === "--") {
      index += 1;
      command = words[index] || "";
      break;
    }
    if (word === "-n" || word === "--non-interactive") return false;
    if (word === "-i" || word === "--login" || word === "-s" || word === "--shell") {
      interactiveOption = true;
      index += 1;
      continue;
    }
    if (word.startsWith("-")) {
      // Skip the argument of the common sudo options that take one. This
      // keeps `sudo -u root -i` and `sudo -u root bash` on the PTY path.
      if (/^-([ugRPC])$/.test(word) && index + 1 < words.length) index += 2;
      else index += 1;
      continue;
    }
    command = word;
    break;
  }
  if (interactiveOption) return true;
  return new Set(["su", "bash", "sh", "zsh", "fish", "tmux", "screen"]).has(command);
}
