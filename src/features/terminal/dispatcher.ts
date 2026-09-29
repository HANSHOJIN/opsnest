export type TerminalDispatchContext = {
  writeCommand: (command: string) => void;
  askAi: (prompt: string) => void;
  approve: (command: string) => void;
  pendingCommand: () => string | null;
  isBusy?: () => boolean;
  onBusy?: () => void;
  looksLikeCommand: (value: string) => boolean;
  onCommand: (command: string) => void;
};

export class TerminalDispatcher {
  constructor(private readonly context: TerminalDispatchContext) {}

  async dispatch(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const pending = this.context.pendingCommand();
    if (pending && /^(approve|yes|y|确认|执行)$/i.test(trimmed)) {
      this.context.approve(pending);
      return;
    }
    if (this.context.isBusy?.()) {
      this.context.onBusy?.();
      return;
    }
    const forcedAi = trimmed === "/ai" || trimmed.startsWith("/ai ");
    const forcedCommand = trimmed === "/cmd" || trimmed.startsWith("/cmd ");
    const command = forcedCommand ? trimmed.slice(4).trim() : trimmed;
    if (forcedCommand) {
      if (command) {
        this.context.onCommand(command);
        this.context.writeCommand(command);
      }
      return;
    }
    if (!forcedAi && this.context.looksLikeCommand(trimmed)) {
      this.context.onCommand(command);
      this.context.writeCommand(command);
      return;
    }
    const prompt = forcedAi ? trimmed.slice(3).trim() : trimmed;
    if (prompt) this.context.askAi(prompt);
  }
}
