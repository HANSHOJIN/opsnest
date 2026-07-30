import type { Locale, Server } from "../../domain/types";

export type ServerDetailText = {
  system: string;
  hostname: string;
  cpu: string;
  memory: string;
  disk: string;
  docker: string;
  connected: string;
  notConnected: string;
  installedRunning: (count: string) => string;
  notInstalled: string;
};

export type ServerDetailActions = {
  onBack: () => void;
  onOpen: () => void;
  onConnect: () => void;
  onScan: () => void;
  isScanning: boolean;
  onDiscover: () => void;
  isDiscovering: boolean;
  onEdit: () => void;
  onManager: () => void;
  onCron: () => void;
  onAddCustomService: (serverId: string, name: string, port: number) => void;
  onDeleteCustomService: (serverId: string, serviceId: string) => void;
};

export type ServerDetailProps = ServerDetailActions & {
  server: Server;
  text: ServerDetailText;
  language: Locale;
};
