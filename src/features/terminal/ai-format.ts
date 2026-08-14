export type AiConclusionTone = "success" | "error" | "stopped";

const RESET = "\x1b[0m";
const HEADING = "\x1b[1;38;5;117m";
const MUTED = "\x1b[38;5;245m";
const CODE = "\x1b[38;5;221m";
const SUCCESS = "\x1b[38;5;114m";
const ERROR = "\x1b[38;5;203m";
const STOPPED = "\x1b[38;5;220m";

function isCombining(codePoint: number) {
  return (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function characterWidth(character: string) {
  const codePoint = character.codePointAt(0) ?? 0;
  if (isCombining(codePoint) || codePoint === 0x200b || codePoint === 0x200d)
    return 0;
  return codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
    ? 2
    : 1;
}

function visibleWidth(value: string) {
  let width = 0;
  for (const character of value) width += characterWidth(character);
  return width;
}

function stripTerminalControl(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g, "")
    // A model response is text, not a PTY stream. Expand tabs so the
    // width-aware wrapper agrees with xterm's visual columns.
    .replace(/\t/g, "    ");
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~|\*|_)([^*_~]+)\1/g, "$2")
    .replace(/\\([\\`*_{}\[\]()#+.!\-|>])/g, "$1")
    .trim();
}

function padRight(value: string, width: number) {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function wrapLine(value: string, width: number) {
  if (!value || visibleWidth(value) <= width) return [value];
  const result: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const character of value) {
    const nextWidth = characterWidth(character);
    if (current && currentWidth + nextWidth > width) {
      result.push(current.trimEnd());
      current = "";
      currentWidth = 0;
    }
    current += character;
    currentWidth += nextWidth;
  }
  if (current) result.push(current.trimEnd());
  return result.length ? result : [""];
}

function splitTableRow(value: string) {
  const source = value.trim().replace(/^\|/, "").replace(/\|$/, "");
  return source
    .split(/(?<!\\)\|/u)
    .map((cell) => stripInlineMarkdown(cell).replace(/\\\|/g, "|"));
}

function isTableSeparator(value: string) {
  const cells = splitTableRow(value);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function formatTable(rows: string[], width: number) {
  const parsed = rows.map(splitTableRow);
  const columns = Math.max(...parsed.map((row) => row.length));
  const header = Array.from({ length: columns }, (_, index) => parsed[0]?.[index] ?? "");
  const body = parsed.slice(2).map((row) =>
    Array.from({ length: columns }, (_, index) => row[index] ?? ""),
  );
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(1, header[index].length ? visibleWidth(header[index]) : 1, ...body.map((row) => visibleWidth(row[index]))),
  );
  const naturalWidth = widths.reduce((sum, item) => sum + item, 0) + columns * 3 + 1;
  if (naturalWidth > width) {
    const rowsToDescribe = body.length ? body : [header];
    return rowsToDescribe.flatMap((row) => {
      const values = row
        .map((cell, index) => `${header[index] || `列 ${index + 1}`}: ${cell}`)
        .filter((item) => !/:\s*$/.test(item));
      return wrapLine(values.join(" · "), width).map((line) => `• ${line}`);
    });
  }
  const horizontal = `├${widths.map((item) => "─".repeat(item + 2)).join("┼")}┤`;
  const renderRow = (row: string[]) =>
    `│ ${row.map((cell, index) => padRight(cell, widths[index])).join(" │ ")} │`;
  return [
    `┌${widths.map((item) => "─".repeat(item + 2)).join("┬")}┐`,
    renderRow(header),
    horizontal,
    ...body.map(renderRow),
    `└${widths.map((item) => "─".repeat(item + 2)).join("┴")}┘`,
  ];
}

function toneColor(tone: AiConclusionTone) {
  return tone === "error" ? ERROR : tone === "stopped" ? STOPPED : SUCCESS;
}

/**
 * Convert model Markdown into safe, width-aware terminal text. The returned
 * value contains only ANSI sequences generated here; model-provided terminal
 * control bytes are removed so a reply cannot move or clear the user's PTY.
 */
export function formatAiConclusion(
  input: string,
  columns: number,
  tone: AiConclusionTone = "success",
) {
  const source = stripTerminalControl(input).replace(/\r\n?/g, "\n").trim();
  if (!source) return "";
  // Leave two terminal columns as breathing room. Do not use a large minimum:
  // a split/side panel can legitimately be only a few dozen columns wide.
  const width = Math.max(16, Math.min(120, Math.max(16, columns - 2)));
  const output: string[] = [];
  let inCode = false;
  let codeLanguage = "";
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = line.trim().match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      inCode = !inCode;
      codeLanguage = inCode ? (fence[1] ?? "").slice(0, Math.max(0, width - 12)) : "";
      if (inCode) {
        const codeHeader = `┌─ code${codeLanguage ? ` · ${codeLanguage}` : ""} ─`;
        output.push(`${MUTED}${wrapLine(codeHeader, width).join(`\n${MUTED}`)}${RESET}`);
      }
      else output.push(`${MUTED}└─ code ─${RESET}`);
      continue;
    }
    if (inCode) {
      const codeLine = stripTerminalControl(line);
      output.push(`${CODE}│ ${wrapLine(codeLine, width - 2).join(`\n${CODE}│ `)}${RESET}`);
      continue;
    }
    if (/^\s{4}\S/.test(line)) {
      const codeLine = line.replace(/^\s{4}/, "");
      output.push(`${CODE}│ ${wrapLine(codeLine, width - 2).join(`\n${CODE}│ `)}${RESET}`);
      continue;
    }
    if (line.trim() && index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const tableRows = [line, lines[index + 1] ?? ""];
      index += 1;
      while (index + 1 < lines.length && (lines[index + 1] ?? "").includes("|")) {
        tableRows.push(lines[index + 1] ?? "");
        index += 1;
      }
      output.push(...formatTable(tableRows, width));
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(
        ...wrapLine(stripInlineMarkdown(heading[1] ?? ""), width).map(
          (part) => `${HEADING}${part}${RESET}`,
        ),
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      output.push(...wrapLine(`• ${stripInlineMarkdown(bullet[1] ?? "")}`, width));
      continue;
    }
    const numbered = line.match(/^\s*(\d+[.)])\s+(.+)$/);
    if (numbered) {
      output.push(...wrapLine(`${numbered[1]} ${stripInlineMarkdown(numbered[2] ?? "")}`, width));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      output.push(
        ...wrapLine(`│ ${stripInlineMarkdown(quote[1] ?? "")}`, width),
      );
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      output.push(`${MUTED}${"─".repeat(Math.max(3, width))}${RESET}`);
      continue;
    }
    if (!line.trim()) {
      if (output.at(-1) !== "") output.push("");
      continue;
    }
    output.push(...wrapLine(stripInlineMarkdown(line), width));
  }
  if (inCode) output.push(`${MUTED}└─ code ─${RESET}`);
  while (output.at(-1) === "") output.pop();
  const label = tone === "error" ? "AI 错误" : tone === "stopped" ? "AI 已停止" : "AI";
  const headerText = `┌─ ${label} `;
  const header = `${headerText}${"─".repeat(Math.max(3, width - visibleWidth(headerText) - 1))}┐`;
  const footer = `└${"─".repeat(Math.max(3, width - 2))}┘`;
  return `\r\n${toneColor(tone)}${header}${RESET}\r\n${output.join("\r\n")}\r\n${toneColor(tone)}${footer}${RESET}\r\n`;
}
