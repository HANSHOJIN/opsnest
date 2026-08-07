export class ImeGate {
  private composing = false;
  private pending = "";
  private flushPending() {
    if (!this.pending) return;
    const value = this.pending;
    this.pending = "";
    this.onCommit(value);
  }
  private readonly onStart = () => { this.composing = true; };
  private readonly onEnd = () => {
    this.composing = false;
    this.flushPending();
  };

  constructor(private readonly host: HTMLElement, private readonly onCommit: (data: string) => void) {
    host.addEventListener("compositionstart", this.onStart, true);
    host.addEventListener("compositionend", this.onEnd, true);
  }

  handleKeyEvent(event: KeyboardEvent) {
    // `isComposing` is only a per-key hint. Some Windows IMEs leave it set on
    // later key events, so do not use it to suppress ordinary terminal keys.
    // The actual composition gate is owned by compositionstart/end below.
    if (this.composing && !event.isComposing && event.type === "keydown") {
      // Recovery for IMEs that omit compositionend: release the gate as soon
      // as a normal key arrives instead of freezing the terminal forever.
      this.composing = false;
      this.flushPending();
    }
    // 229 is an IME keydown hint, not proof that composition has started.
    // Some Windows input methods emit it without a matching compositionend;
    // do not latch the gate on that hint or all later terminal input freezes.
    if (event.keyCode === 229) return false;
    return true;
  }

  accept(data: string) {
    if (!this.composing) return data;
    this.pending += data;
    return null;
  }

  dispose() {
    this.host.removeEventListener("compositionstart", this.onStart, true);
    this.host.removeEventListener("compositionend", this.onEnd, true);
    this.pending = "";
  }
}
