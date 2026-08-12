/**
 * Runtime primitives for the OpsNest terminal emulator.
 *
 * xterm.js is the only visible surface.  This module deliberately contains no
 * DOM or React code: it owns the small amount of protocol state needed to keep
 * PTY output, AI annotations and user input in one ordered transcript.
 */
export type TranscriptSource = "pty" | "ai" | "system";

export class TranscriptRuntime {
  private endsWithLineBreak = false;

  constructor(private readonly write: (data: string) => void) {}

  writePty(data: string, preserveBoundary = false) {
    this.write(this.normalize(data, preserveBoundary));
  }

  writeAi(text: string, color = "38;5;114") {
    if (!text.trim()) return;
    this.write(this.normalize(`\r\n\x1b[${color}m• ${text}\x1b[0m\r\n`));
  }

  writeSystem(text: string, color = "31") {
    if (!text.trim()) return;
    this.write(this.normalize(`\r\n\x1b[${color}m${text}\x1b[0m\r\n`));
  }

  /** Collapse only duplicate transport line breaks at a chunk boundary. */
  private normalize(data: string, preserveBoundary = false) {
    if (!data) return "";
    let value = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!preserveBoundary && this.endsWithLineBreak && value.startsWith("\n"))
      value = value.slice(1);
    this.endsWithLineBreak = value.endsWith("\n");
    return value.replace(/\n/g, "\r\n");
  }

  reset() { this.endsWithLineBreak = false; }
}

export function isImeCompositionKey(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229;
}
