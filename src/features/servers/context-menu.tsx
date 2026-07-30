import type { Server } from "../../domain/types";

export function ServerContextMenu({
  state,
  connectLabel,
  terminalLabel,
  editLabel,
  onConnect,
  onTerminal,
  onEdit,
}: {
  state: { server: Server; x: number; y: number };
  connectLabel: string;
  terminalLabel: string;
  editLabel: string;
  onConnect: () => void;
  onTerminal: () => void;
  onEdit: () => void;
}) {
  return <div className="server-context-menu" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    <strong>{state.server.name}</strong>
    <button onClick={onConnect}>↻ {connectLabel}</button>
    <button onClick={onTerminal}>〉 {terminalLabel}</button>
    <button onClick={onEdit}>✎ {editLabel}</button>
  </div>;
}
