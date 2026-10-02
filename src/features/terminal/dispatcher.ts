export type TerminalDispatchContext = {
  writeCommand: (command: string) => void | Promise<void>;
  askAi: (prompt: string) => void;
  approve: (command: string) => void;
  pendingCommand: () => string | null;
  isBusy?: () => boolean;
  onBusy?: () => void;
  looksLikeCommand: (value: string) => boolean;
  resolveUnknownCommand?: (value: string) => Promise<"command" | "ai" | "cancel">;
  onCommand: (command: string) => void;
};

export class TerminalDispatcher {
  private resolving = false;
  constructor(private readonly context: TerminalDispatchContext) {}

  async dispatch(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const pending = this.context.pendingCommand();
    if (pending && /^(approve|yes|y|确认|执行)$/i.test(trimmed)) {
      this.context.approve(pending);
      return;
    }
    if (this.resolving || this.context.isBusy?.()) {
      this.context.onBusy?.();
      return;
    }
    const forcedAi = trimmed === "/ai" || trimmed.startsWith("/ai ");
    const forcedCommand = trimmed === "/cmd" || trimmed.startsWith("/cmd ");
    const command = forcedCommand ? trimmed.slice(4).trim() : trimmed;
    if (forcedCommand) {
      if (command) {
        this.context.onCommand(command);
        await this.context.writeCommand(command);
      }
      return;
    }
    if (!forcedAi && this.context.looksLikeCommand(trimmed)) {
      this.context.onCommand(command);
      await this.context.writeCommand(command);
      return;
    }
    if (!forcedAi && this.context.resolveUnknownCommand) {
      this.resolving = true;
      try {
        const route = await this.context.resolveUnknownCommand(trimmed);
        if (route === "cancel") return;
        if (route === "command") {
          this.context.onCommand(command);
          await this.context.writeCommand(command);
          return;
        }
      } finally { this.resolving = false; }
    }
    const prompt = forcedAi ? trimmed.slice(3).trim() : trimmed;
    if (prompt) this.context.askAi(prompt);
  }
}
