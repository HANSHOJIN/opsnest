import React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  ArrowDown,
  ArrowRight,
  FilePenLine,
  Files as FilesGlyph,
  LoaderCircle,
  Save,
  X,
} from "lucide-react";
import type { ServerSummary } from "../../components/ShellLayout";
import { ensureWorkspace, writeWorkspaceText } from "../../services/portableStorage";

export type EditorPlacement = "right" | "bottom";

export type RemoteEditorTab = {
  id: string;
  serverId: string;
  path: string;
  name: string;
};

type RemoteEditorDocument = {
  content: string;
  original: string;
  status: "loading" | "ready" | "error";
  error?: string;
};

// Keep a small document cache as a safety net for route remounts. The active
// editor itself is a single React instance and is portaled between the right
// and bottom hosts, so ordinary placement changes do not start another read.
const remoteEditorDocumentCache = new Map<string, RemoteEditorDocument>();

export function clearRemoteEditorDocumentCache(tabId: string) {
  remoteEditorDocumentCache.delete(tabId);
}

type RemoteEditorPanelProps = {
  language: "zh-CN" | "en";
  server: ServerSummary;
  tabs: RemoteEditorTab[];
  activeTabId: string | null;
  placement: EditorPlacement;
  onCloseTab: (id: string, dirty: boolean) => void;
  onBackToFiles: () => void;
  onMove: (placement: EditorPlacement) => void;
  onConnectionState?: (
    serverId: string,
    connected: boolean,
    connectionError?: boolean,
  ) => void;
  /** Bottom mode shares the SSH tab strip, so do not render a second file tab strip. */
  showTabs?: boolean;
};

const EDITOR_LIMIT = 2 * 1024 * 1024;

function comparableEditorContent(content: string) {
  // CodeMirror stores document lines with LF separators while remote files
  // may arrive as CRLF. Compare the logical text so undoing back to the
  // original content correctly clears the dirty state.
  return content.replace(/\r\n?/g, "\n");
}

// A file operation can fail for ordinary reasons (missing path, permissions,
// or a read-only file) without meaning that the SSH/SFTP connection itself is
// down. Only transport/authentication failures should turn the server badge red.
function isRemoteConnectionFailure(error: unknown) {
  const message = String(error).toLowerCase();
  if (
    /(permission denied|not found|no such file|not a directory|directory not empty|read-only|already exists)/.test(
      message,
    )
  )
    return false;
  return /(ssh|sftp|connection|connect|handshake|login|authenticat|timeout|timed out|network|socket|refused|unreachable|host key|credential|channel|subsystem|protocol|resolve|dns|no route|reset by peer|broken pipe|closed)/.test(
    message,
  );
}

function languageForPath(path: string) {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return null;
  if (name.endsWith(".json") || name.endsWith(".jsonc")) return json();
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return yaml();
  if (name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs"))
    return javascript({ jsx: name.endsWith(".jsx") });
  if (name.endsWith(".ts") || name.endsWith(".tsx"))
    return javascript({ typescript: true, jsx: name.endsWith(".tsx") });
  if (name.endsWith(".py")) return python();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return markdown();
  if (name.endsWith(".html") || name.endsWith(".htm")) return html();
  if (name.endsWith(".css") || name.endsWith(".scss")) return css();
  if (name.endsWith(".rs")) return rust();
  if (name.endsWith(".sql")) return sql();
  return null;
}

function editorTheme() {
  return EditorView.theme(
    {
      "&": {
        color: "var(--text)",
        backgroundColor: "var(--surface-1)",
        height: "100%",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "var(--mono-font, ui-monospace, SFMono-Regular, Consolas, monospace)",
        fontSize: "12px",
        lineHeight: "1.55",
      },
      ".cm-content": { caretColor: "var(--accent)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      ".cm-gutters": {
        backgroundColor: "var(--surface-1)",
        color: "var(--text-subtle)",
        border: "0",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--control-hover) 45%, transparent)",
      },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
      },
      ".cm-foldGutter .cm-gutterElement": { color: "var(--text-subtle)" },
    },
    { dark: true },
  );
}

function buildConnectionRequest(server: ServerSummary) {
  const at = server.host.indexOf("@");
  const username = at > 0 ? server.host.slice(0, at) : "root";
  const host = at > 0 ? server.host.slice(at + 1) : server.host;
  return { host, username, port: server.port };
}

export function RemoteEditorPanel({
  language,
  server,
  tabs,
  activeTabId,
  placement,
  onCloseTab,
  onBackToFiles,
  onMove,
  onConnectionState,
  showTabs = true,
}: RemoteEditorPanelProps) {
  const isEnglish = language === "en";
  const [documents, setDocuments] = React.useState<
    Record<string, RemoteEditorDocument>
  >({});
  const [saving, setSaving] = React.useState(false);
  const editorHost = React.useRef<HTMLDivElement | null>(null);
  const editorView = React.useRef<EditorView | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeDocument = activeTabId ? documents[activeTabId] : undefined;
  const activeContentRef = React.useRef("");
  const onChangeRef = React.useRef<(content: string) => void>(() => undefined);
  const draftTimerRef = React.useRef<number | null>(null);
  const workspaceId = server.id;
  const markRemoteConnection = React.useCallback(
    (connected: boolean, connectionError = false) => {
      onConnectionState?.(server.id, connected, connectionError);
    },
    [onConnectionState, server.id],
  );
  const [bottomPortalTarget, setBottomPortalTarget] = React.useState<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    if (placement !== "bottom") {
      setBottomPortalTarget(null);
      return;
    }
    let disposed = false;
    const syncTarget = () => {
      if (disposed) return;
      setBottomPortalTarget(
        document.querySelector<HTMLElement>(
          '.bottom-panel.is-open [data-opsnest-bottom-editor-host="true"]',
        ),
      );
    };
    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    const frame = window.requestAnimationFrame(syncTarget);
    return () => {
      disposed = true;
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [placement]);

  React.useEffect(() => {
    void ensureWorkspace(workspaceId, server.name).catch(() => undefined);
    return () => {
      if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    };
  }, [workspaceId]);

  const requestForServer = React.useCallback(async () => {
    const base = buildConnectionRequest(server);
    const password =
      server.password ??
      (await invoke<string | null>("load_server_credential", {
        serverId: server.id,
      }).catch(() => null));
    return {
      ...base,
      authMethod: server.authMethod ?? "password",
      password,
      privateKeyPath: server.privateKeyPath ?? null,
      passphrase: null,
    };
  }, [
    server.authMethod,
    server.host,
    server.id,
    server.password,
    server.port,
    server.privateKeyPath,
  ]);

  React.useEffect(() => {
    if (!activeTab || documents[activeTab.id]) return;
    const cached = remoteEditorDocumentCache.get(activeTab.id);
    if (cached?.status === "ready") {
      setDocuments((current) => ({ ...current, [activeTab.id]: cached }));
      return;
    }
    let cancelled = false;
    setDocuments((current) => ({
      ...current,
      [activeTab.id]: { content: "", original: "", status: "loading" },
    }));
    void (async () => {
      try {
        const content = await invoke<string>("read_remote_text_file", {
          request: await requestForServer(),
          remotePath: activeTab.path,
          maxBytes: EDITOR_LIMIT,
        });
        if (cancelled) return;
        const document = { content, original: content, status: "ready" as const };
        remoteEditorDocumentCache.set(activeTab.id, document);
        setDocuments((current) => ({ ...current, [activeTab.id]: document }));
        markRemoteConnection(true);
      } catch (error) {
        if (cancelled) return;
        if (isRemoteConnectionFailure(error)) markRemoteConnection(false, true);
        setDocuments((current) => ({
          ...current,
          [activeTab.id]: {
            content: "",
            original: "",
            status: "error",
            error: String(error),
          },
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  // Do not depend on the documents map here. Setting the initial loading
  // record changes that map; depending on it would clean up the in-flight
  // request immediately and leave the document stuck in "loading" forever.
  }, [activeTab, markRemoteConnection, requestForServer]);

  React.useEffect(() => {
    const host = editorHost.current;
    if (!host || !activeTab || !activeDocument || activeDocument.status !== "ready")
      return;
    editorView.current?.destroy();
    activeContentRef.current = activeDocument.content;
    const view = new EditorView({
      state: EditorState.create({
        doc: activeDocument.content,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          drawSelection(),
          history(),
          bracketMatching(),
          indentOnInput(),
          foldGutter(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          editorTheme(),
          ...(languageForPath(activeTab.path)
            ? [languageForPath(activeTab.path)!]
            : []),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const content = update.state.doc.toString();
            activeContentRef.current = content;
            onChangeRef.current(content);
          }),
        ],
      }),
      parent: host,
    });
    editorView.current = view;
    return () => {
      view.destroy();
      if (editorView.current === view) editorView.current = null;
    };
  // Moving the single editor through a React portal can replace the DOM host
  // while preserving the document state. Recreate CodeMirror in the new host
  // so the text remains visible without issuing another remote read.
  }, [activeTab, activeDocument?.status, placement, bottomPortalTarget]);

  onChangeRef.current = (content) => {
    if (!activeTabId) return;
    setDocuments((current) => {
      const document = current[activeTabId];
      if (!document) return current;
      const nextDocument = {
        ...document,
        content,
        status: "ready" as const,
      };
      remoteEditorDocumentCache.set(activeTabId, nextDocument);
      return {
        ...current,
        [activeTabId]: nextDocument,
      };
    });
    const tab = tabs.find((item) => item.id === activeTabId);
    if (tab) {
      if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
      const draftName = encodeURIComponent(tab.path).slice(-180);
      draftTimerRef.current = window.setTimeout(() => {
        void writeWorkspaceText(
          workspaceId,
          `drafts/${draftName}.draft`,
          content,
        ).catch(() => undefined);
      }, 500);
    }
  };

  const save = async () => {
    if (!activeTab || !activeDocument || activeDocument.status !== "ready" || saving)
      return;
    const content = editorView.current?.state.doc.toString() ?? activeContentRef.current;
    setSaving(true);
    try {
      try {
        const snapshotName = encodeURIComponent(activeTab.path).slice(-180);
        await writeWorkspaceText(
          workspaceId,
          `snapshots/${Date.now()}-${snapshotName}.bak`,
          activeDocument.original,
        );
      } catch {
        // A local snapshot is best effort; a workspace write must not block
        // an explicitly requested remote save.
      }
      await invoke("write_remote_text_file", {
        request: await requestForServer(),
        remotePath: activeTab.path,
        content,
      });
      markRemoteConnection(true);
      setDocuments((current) => {
        const nextDocument = {
          ...current[activeTab.id],
          content,
          original: content,
          status: "ready" as const,
        };
        remoteEditorDocumentCache.set(activeTab.id, nextDocument);
        return { ...current, [activeTab.id]: nextDocument };
      });
    } catch (error) {
      if (isRemoteConnectionFailure(error)) markRemoteConnection(false, true);
      setDocuments((current) => ({
        ...current,
        [activeTab.id]: { ...current[activeTab.id], error: String(error) },
      }));
    } finally {
      setSaving(false);
    }
  };

  const dirty = Boolean(
    activeDocument &&
      activeDocument.status === "ready" &&
      comparableEditorContent(
        editorView.current?.state.doc.toString() ?? activeDocument.content,
      ) !== comparableEditorContent(activeDocument.original),
  );
  const closeActive = () => {
    if (!activeTab) return;
    onCloseTab(activeTab.id, dirty);
  };
  React.useEffect(() => {
    const closeRequested = () => closeActive();
    window.addEventListener("opsnest-close-active-editor", closeRequested);
    return () => window.removeEventListener("opsnest-close-active-editor", closeRequested);
  });

  const panel = (
    <section className="remote-editor-panel" aria-label={isEnglish ? "Remote editor" : "远程文件编辑器"}>
      {showTabs && <div className="file-manager-tabs remote-editor-tabs">
        <div className="file-manager-tab">
          <button className="file-manager-tab-select" type="button" onClick={onBackToFiles} title={isEnglish ? `Back to ${server.name} files` : `返回 ${server.name} 文件栏`}>
            <FilesGlyph className="file-manager-tab-icon" size={14} strokeWidth={1.8} />
            <span className="file-manager-tab-label">{server.name}</span>
          </button>
        </div>
        <div className="file-manager-tab is-active">
          <button className="file-manager-tab-select" type="button" title={activeTab?.name ?? ""}>
            <FilePenLine className="file-manager-tab-icon" size={14} strokeWidth={1.8} />
            <span className="file-manager-tab-label">{activeTab?.name ?? ""}</span>
          </button>
          <button className="file-manager-tab-close" type="button" onClick={closeActive} aria-label={isEnglish ? "Close file editor" : "关闭文件编辑器"}>
            <X size={12} />
          </button>
        </div>
      </div>}
      <div className="remote-editor-toolbar">
        <div className="remote-editor-location" title={activeTab?.path}>{activeTab?.path ?? ""}</div>
        <div className="remote-editor-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => void save()}
            disabled={!dirty || saving || activeDocument?.status !== "ready"}
            title={isEnglish ? "Save file" : "保存文件"}
            aria-label={isEnglish ? "Save file" : "保存文件"}
          >
            {saving ? <LoaderCircle className="is-spinning" size={13} /> : <Save size={13} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => onMove(placement === "right" ? "bottom" : "right")}
            disabled={saving || activeDocument?.status !== "ready"}
            title={
              placement === "right"
                ? isEnglish
                  ? "Move editor to bottom panel"
                  : "移动编辑器到下栏"
                : isEnglish
                  ? "Move editor to right panel"
                  : "移动编辑器到右栏"
            }
            aria-label={
              placement === "right"
                ? isEnglish
                  ? "Move editor to bottom panel"
                  : "移动编辑器到下栏"
                : isEnglish
                  ? "Move editor to right panel"
                  : "移动编辑器到右栏"
            }
          >
            {placement === "right" ? <ArrowDown size={13} /> : <ArrowRight size={13} />}
          </button>
          <button type="button" className="icon-button" onClick={closeActive} title={isEnglish ? "Close editor" : "关闭编辑器"} aria-label={isEnglish ? "Close editor" : "关闭编辑器"}><X size={14} /></button>
        </div>
      </div>
      {activeDocument?.status === "loading" && <div className="remote-editor-message"><LoaderCircle className="is-spinning" size={18} /><span>{isEnglish ? "Loading file…" : "正在读取文件…"}</span></div>}
      {activeDocument?.status === "error" && <div className="remote-editor-message is-error"><strong>{isEnglish ? "Unable to open file" : "无法打开文件"}</strong><span>{activeDocument.error}</span></div>}
      {activeDocument?.status === "ready" && <div ref={editorHost} className="remote-editor-host" />}
    </section>
  );

  if (placement === "bottom" && bottomPortalTarget) {
    return createPortal(panel, bottomPortalTarget);
  }
  return panel;
}
