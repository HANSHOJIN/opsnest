export type TerminalDispatchContext = {
  writeCommand: (command: string) => void;
  askAi: (prompt: string) => void;
  approve: (command: string) => void;
  pendingCommand: () => string | null;
  isBusy?: () => boolean;
  onBusy?: () => void;
  looksLikeCommand: (value: string) => boolean;
  probeCommand?: (value: string) => Promise<boolean>;
  isRiskyCommand: (value: string) => boolean;
  confirmRisky: (command: string) => boolean | Promise<boolean>;
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
    const forcedAi = trimmed.startsWith("/ai ");
    const command = trimmed.startsWith("/cmd ") ? trimmed.slice(5).trim() : trimmed;
    if (!forcedAi && (this.context.looksLikeCommand(trimmed) || (this.context.probeCommand && await this.context.probeCommand(trimmed)))) {
      if (this.context.isRiskyCommand(command) && !await this.context.confirmRisky(command)) return;
      this.context.onCommand(command);
      this.context.writeCommand(command);
      return;
    }
    this.context.askAi(forcedAi ? trimmed.slice(4).trim() : trimmed);
  }
}
