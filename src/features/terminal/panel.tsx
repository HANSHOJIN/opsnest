import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AiInterventionMode, InteractiveCommand, Locale, ShellContext, Server, SshRequest, TerminalLine } from "../../domain/types";
import { desktopInvoke as invoke, listenDesktopEvent as listen } from "../../services/desktop";
import { displayServerHostname } from "../servers/profile";

export type TerminalText = { terminalExit: string; terminalConnecting: string; connected: string };

export function TerminalPanel({ server, request, text, language, interventionMode, lines, executing, agentStatus, interactiveCommand, onInputChange, onSubmit, onStop, onExit, onInteractiveComplete, onInteractiveError }: { server: Server; request: SshRequest | null; text: TerminalText; language: Locale; interventionMode: AiInterventionMode; lines: TerminalLine[]; executing: boolean; agentStatus: string; interactiveCommand: InteractiveCommand | null; onInputChange: (value: string) => void; onSubmit: (rawInput?: string) => void; onStop: () => void; onExit: () => void; onInteractiveComplete: (id: string, output: string) => void; onInteractiveError: (id: string, message: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lineCountRef = useRef(0);
  const inputBufferRef = useRef("");
  const lastSubmittedRef = useRef("");
  const previousExecutingRef = useRef(false);
  const executingRef = useRef(executing);
  const shellContextRef = useRef<ShellContext>({ cwd: "~", virtualEnv: "" });
  const onSubmitRef = useRef(onSubmit);
  const onInteractiveCompleteRef = useRef(onInteractiveComplete);
  const onInteractiveErrorRef = useRef(onInteractiveError);
  const interactiveCommandRef = useRef(interactiveCommand);
  const handoffRef = useRef<{ id: string; command: string; marker: string; output: string } | null>(null);
  const modeRef = useRef(interventionMode);
  const [shellContext, setShellContext] = useState<ShellContext>({ cwd: "~", virtualEnv: "" });
  onSubmitRef.current = onSubmit;
  onInteractiveCompleteRef.current = onInteractiveComplete;
  onInteractiveErrorRef.current = onInteractiveError;
  interactiveCommandRef.current = interactiveCommand;
  modeRef.current = interventionMode;
  executingRef.current = executing;
  shellContextRef.current = shellContext;

  const refreshShellContext = async (): Promise<ShellContext | null> => {
    if (!request) return null;
    try {
      const context = await invoke<string>("execute_ssh_command", {
        request: { ...request, sessionId: server.id },
        command: "printf '__OPSNEST_CONTEXT__%s\\t%s\\n' \"$PWD\" \"${VIRTUAL_ENV_PROMPT:-${VIRTUAL_ENV##*/}}\"",
      });
      const line = context.split(/\r?\n/).find((item) => item.includes("__OPSNEST_CONTEXT__"));
      if (!line) return null;
      const [cwd, virtualEnv] = line.slice(line.indexOf("__OPSNEST_CONTEXT__") + "__OPSNEST_CONTEXT__".length).split("\t");
      const next = { cwd: cwd?.trim() || "~", virtualEnv: virtualEnv?.trim() || "" };
      setShellContext(next);
      return next;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    setShellContext({ cwd: "~", virtualEnv: "" });
    void refreshShellContext();
    // The context probe follows the same persistent shell as command execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, request]);

  useEffect(() => {
    if (!interactiveCommand || !request) return;
    const marker = `__OPSNEST_INTERACTIVE_END_${interactiveCommand.id}__`;
    handoffRef.current = { id: interactiveCommand.id, command: interactiveCommand.command, marker, output: "" };
    void invoke("write_ssh_terminal", {
      sessionId: server.id,
      data: `${interactiveCommand.command}\nprintf '\\n${marker}\\n'\r`,
    }).catch((error) => {
      handoffRef.current = null;
      onInteractiveErrorRef.current(interactiveCommand.id, String(error));
    });
    return () => {
      if (handoffRef.current?.id === interactiveCommand.id) handoffRef.current = null;
    };
  }, [interactiveCommand, request, server.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
      fontSize: 13,
      lineHeight: 1.35,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      theme: { background: "#101214", foreground: "#d5deeb", cursor: "#65d995", selectionBackground: "#2c4166", black: "#101214", brightBlack: "#667383", green: "#65d995", brightGreen: "#8cf1b0", cyan: "#80dce8", brightCyan: "#a9e8ee", blue: "#8ea4ff", brightBlue: "#b9c8ff" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminalRef.current = terminal;

    const writeLine = (line: TerminalLine) => {
      const prefix = line.kind === "command" ? "$ " : line.kind === "ai" ? "✦ " : line.kind === "system" ? "• " : "";
      const value = line.text.replace(/\r?\n/g, "\r\n");
      const colorStart = line.kind === "ai" ? "\x1b[38;5;114m" : "";
      const colorEnd = line.kind === "ai" ? "\x1b[0m" : "";
      terminal.write(`${colorStart}${prefix}${value}${colorEnd}${value.endsWith("\r\n") ? "" : "\r\n"}`);
    };
    lines.forEach(writeLine);
    lineCountRef.current = lines.length;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let reconnectAttempted = false;
    void listen<{ sessionId: string; data: string; closed: boolean }>("ssh-terminal-output", (event) => {
      if (event.payload.sessionId !== server.id) return;
      let data = event.payload.data;
      const handoff = handoffRef.current;
      if (handoff && data) {
        handoff.output += data;
        const markerIndex = handoff.output.indexOf(handoff.marker);
        if (markerIndex >= 0) {
          const output = handoff.output.slice(0, markerIndex);
          handoffRef.current = null;
          data = data.replace(handoff.marker, "");
          onInteractiveCompleteRef.current(handoff.id, output);
        }
        if (handoff.command && data.includes(handoff.command)) data = data.replace(handoff.command, "");
      }
      if (data) terminal.write(data.replace(/\r?\n/g, "\r\n"));
      if (event.payload.closed) {
        const pendingHandoff = handoffRef.current;
        if (pendingHandoff) {
          handoffRef.current = null;
          onInteractiveErrorRef.current(pendingHandoff.id, language === "zh-CN" ? "SSH 连接在交互式命令完成前断开。" : "The SSH connection closed before the interactive command completed.");
        }
        terminal.write("\r\n[SSH connection closed]");
        if (request && !reconnectAttempted && !cancelled) {
          reconnectAttempted = true;
          // Normal command/chat mode uses a separate persistent shell. Drop
          // that stale shell before reconnecting the visible PTY, otherwise
          // the first command after reconnect is sent to a dead channel.
          void invoke("close_ssh_shell", { sessionId: server.id }).catch(() => undefined);
          terminal.write("\r\n[reconnecting...]");
          window.setTimeout(() => {
            if (!cancelled) void invoke("open_ssh_terminal", { request: { ...request, sessionId: server.id }, sessionId: server.id }).catch((error) => terminal.write(`\r\n[SSH reconnect failed] ${String(error)}\r\n`));
          }, 350);
        } else terminal.write("\r\n");
      }
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop; });

    if (request) {
      void invoke("open_ssh_terminal", { request: { ...request, sessionId: server.id }, sessionId: server.id }).catch((error) => terminal.write(`\r\n[SSH connection failed] ${String(error)}\r\n`));
    }

    const resize = () => {
      fit.fit();
      const dimensions = fit.proposeDimensions();
      if (dimensions) void invoke("resize_ssh_terminal", { sessionId: server.id, columns: dimensions.cols, rows: dimensions.rows }).catch(() => undefined);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const pasteClipboard = async () => {
      try {
        const pasted = await navigator.clipboard.readText();
        if (!pasted) return;
        if (modeRef.current === "none" || interactiveCommandRef.current) {
          await invoke("write_ssh_terminal", { sessionId: server.id, data: pasted });
          return;
        }
        const normalized = pasted.replace(/\r\n/g, "\n");
        inputBufferRef.current += normalized;
        terminal.write(normalized.replace(/\n/g, "\r\n"));
        onInputChange(inputBufferRef.current);
      } catch (error) {
        terminal.write(`\r\n[Clipboard paste failed] ${String(error)}\r\n`);
        terminal.focus();
      }
    };
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") { void pasteClipboard(); return false; }
      if (event.shiftKey && event.key === "Insert") { void pasteClipboard(); return false; }
      return true;
    });

    const dataDisposable = terminal.onData((data) => {
      if (data === "\u0003" && terminal.getSelection()) {
        const selection = terminal.getSelection();
        if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined);
        return;
      }
      if (modeRef.current === "none" || interactiveCommandRef.current) {
        void invoke("write_ssh_terminal", { sessionId: server.id, data }).catch((error) => terminal.write(`\r\n[SSH write failed] ${String(error)}\r\n`));
        return;
      }
      if (data === "\u0003") {
        inputBufferRef.current = "";
        terminal.write("^C\r\n");
        onInputChange("");
        if (executingRef.current) onStop();
        else writePrompt();
        return;
      }
      if (data === "\r" || data === "\n") {
        const value = inputBufferRef.current;
        if (!value.trim()) { terminal.write("\r\n"); writePrompt(); terminal.focus(); return; }
        lastSubmittedRef.current = value.trim();
        inputBufferRef.current = "";
        terminal.write("\r\n");
        onInputChange("");
        onSubmitRef.current(value);
        return;
      }
      if (data === "\u007f" || data === "\b") {
        if (inputBufferRef.current.length) { inputBufferRef.current = inputBufferRef.current.slice(0, -1); terminal.write("\b \b"); onInputChange(inputBufferRef.current); }
        return;
      }
      if (!data.includes("\u001b")) { inputBufferRef.current += data; terminal.write(data); onInputChange(inputBufferRef.current); }
    });

    return () => {
      cancelled = true;
      unlisten?.();
      dataDisposable.dispose();
      observer.disconnect();
      // Do not close the remote PTY when this panel becomes hidden. The main
      // window keeps one mounted panel per opened server so sessions continue
      // receiving output while the user works elsewhere.
      terminal.dispose();
      terminalRef.current = null;
    };
    // The terminal session is intentionally recreated only when the server changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, request]);

  const writePrompt = (context: ShellContext = shellContextRef.current) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const hostname = displayServerHostname(server);
    const home = server.username === "root" ? "/root" : `/home/${server.username}`;
    const cwd = context.cwd === home ? "~" : context.cwd.startsWith(`${home}/`) ? `~${context.cwd.slice(home.length)}` : context.cwd;
    const virtualEnv = context.virtualEnv ? `(${context.virtualEnv.replace(/^\(|\)$/g, "")}) ` : "";
    const promptSymbol = server.username === "root" ? "#" : "$";
    terminal.write(`${virtualEnv}${server.username}@${hostname}:${cwd}${promptSymbol} `);
  };

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || lines.length <= lineCountRef.current) return;
    for (const line of lines.slice(lineCountRef.current)) {
      if (line.kind === "command" && line.text.trim() === lastSubmittedRef.current) { lastSubmittedRef.current = ""; continue; }
      if (line.kind === "ai" && line.text.trim() === lastSubmittedRef.current) { lastSubmittedRef.current = ""; continue; }
      const prefix = line.kind === "command" ? "$ " : line.kind === "ai" ? "✦ " : line.kind === "system" ? "• " : "";
      const value = line.text.replace(/\r?\n/g, "\r\n");
      const colorStart = line.kind === "ai" ? "\x1b[38;5;114m" : "";
      const colorEnd = line.kind === "ai" ? "\x1b[0m" : "";
      terminal.write(`${colorStart}${prefix}${value}${colorEnd}${value.endsWith("\r\n") ? "" : "\r\n"}`);
    }
    lineCountRef.current = lines.length;
  }, [lines]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (previousExecutingRef.current && !executing) {
      void refreshShellContext().then((nextContext) => {
        terminal.write("\r\n");
        writePrompt(nextContext ?? shellContext);
      });
    }
    previousExecutingRef.current = executing;
    if (!executing) terminal.focus();
    // The prompt is redrawn only after a command completes; context itself is read from the persistent shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executing, server, shellContext]);

  return <section className="terminal-view">
    <div className="terminal-header"><div><p className="eyebrow">SSH</p><h1>{server.name}</h1><span>{server.username}@{server.host}:{server.port}</span></div><button className="secondary terminal-exit" onClick={onExit}>{text.terminalExit}</button></div>
    <div className="terminal-toolbar">{executing && <button className="terminal-stop terminal-toolbar-stop" type="button" onClick={onStop}>停止</button>}<span className="terminal-status">● {agentStatus || (executing ? text.terminalConnecting : text.connected)}</span></div>
    <div className="terminal-xterm-host" ref={hostRef} aria-label="SSH terminal" />
  </section>;
}
