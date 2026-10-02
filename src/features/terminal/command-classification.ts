const shellCommandNames = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ash",
  "cd",
  "ls",
  "pwd",
  "cat",
  "echo",
  "printf",
  "clear",
  "history",
  "find",
  "grep",
  "sed",
  "awk",
  "head",
  "tail",
  "less",
  "more",
  "sort",
  "uniq",
  "cut",
  "xargs",
  "tee",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "chown",
  "sudo",
  "apt",
  "apt-get",
  "apk",
  "yum",
  "dnf",
  "pacman",
  "brew",
  "docker",
  "podman",
  "systemctl",
  "service",
  "journalctl",
  "ps",
  "top",
  "htop",
  "kill",
  "df",
  "du",
  "free",
  "uname",
  "hostname",
  "whoami",
  "id",
  "env",
  "export",
  "source",
  "set",
  "ssh",
  "scp",
  "curl",
  "wget",
  "tar",
  "zip",
  "unzip",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "python",
  "python3",
  "node",
  "go",
  "cargo",
  "make",
  "cmake",
  "java",
  "php",
  "ruby",
  "perl",
  "openssl",
  "vim",
  "vi",
  "nano",
  "tmux",
  "screen",
  "hermes",
  "openclaw",
  "opencode",
  "reboot",
  "shutdown",
]);

export function isLikelyShellCommand(input: string) {
  const value = input.trim();
  if (!value) return false;
  if (value.startsWith("/cmd ")) return true;
  // A pasted shell block must stay on the PTY path.  In particular, brace
  // groups and control structures are valid commands even when their first
  // line is only `{`, `if`, or `for` and therefore cannot be recognized by a
  // single-token command whitelist.
  if (value.includes("\n")) {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      lines.some((line) => /^(?:\{|\}|\(|\)|if\b|then\b|elif\b|else\b|fi\b|for\b|while\b|until\b|do\b|done\b|case\b|esac\b)/.test(line))
    )
      return true;
    const commandLines = lines.filter((line) => !/^(?:#|[{}()])/.test(line));
    if (
      commandLines.length > 1 &&
      commandLines.every((line) => {
        const first = line.split(/\s+/, 1)[0].toLowerCase();
        return shellCommandNames.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(line);
      })
    )
      return true;
    // Do not let punctuation in arbitrary pasted prose (for example a
    // Markdown table, quoted text, or a tab-indented document) route the whole
    // block into the remote shell. A multiline block is a command only when
    // its structure or each executable-looking line positively identifies it.
    return false;
  }
  if (/^(?:[.!/~$][^\s]*|[A-Za-z]:\\[^\s]*)/.test(value)) return true;
  if (/[|;&<>`]|	/.test(value)) return true;
  const first = value.split(/\s+/, 1)[0].toLowerCase();
  return shellCommandNames.has(first);
}

export function executableName(input: string): string | null {
  const name = input.trim().split(/\s+/, 1)[0] ?? "";
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name) ? name : null;
}

// Native input does not depend on the executable's name. This only selects
// whether a nested persistent shell should retain keyboard ownership.
export function shouldAutoReturnToAi(input: string): boolean {
  const words = input.trim().split(/\s+/);
  let index = 0;
  const base = (word: string) => word.split("/").at(-1) ?? word;
  if (["sudo", "doas", "env", "command", "exec"].includes(base(words[0] ?? ""))) {
    index = 1;
    while (index < words.length) {
      const word = words[index];
      if (["-u", "-g", "-r", "-R", "-C"].includes(word)) { index += 2; continue; }
      if (word.startsWith("-") || /^[A-Za-z_]\w*=/.test(word)) { index++; continue; }
      break;
    }
    if (index >= words.length) return false;
  }
  const name = base(words[index] ?? "");
  if (["tmux", "screen", "su"].includes(name)) return false;
  if (!["bash", "sh", "zsh", "fish", "dash", "ash"].includes(name)) return true;
  const args = words.slice(index + 1);
  if (args.some(arg => /^-[^-]*c/.test(arg) || arg === "--command")) return true;
  return args.some(arg => !arg.startsWith("-"));
}
