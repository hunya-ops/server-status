export interface DiskMetrics {
  mount: string;
  device: string;
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface Report {
  version: 1;
  serverId: string;
  collectedAt: number;
  hostname: string;
  os: string;
  kernel: string;
  architecture: string;
  cpu: {
    usagePercent: number;
    cores: number;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    usagePercent: number;
  };
  disks: DiskMetrics[];
  uptimeSeconds: number;
}

export interface ServerNetwork {
  ip: string;
  country: string | null;
  city: string | null;
}

export interface ServerSnapshot {
  id: string;
  name: string;
  recovering?: boolean;
  offline?: boolean;
  lastSeen: number | null;
  report: Report | null;
  network?: ServerNetwork | null;
  enabled?: boolean;
  intervalSeconds?: number;
  warningPercent?: number;
  sortOrder?: number;
}

export interface Settings {
  siteName: string;
  warningPercent: number;
  retentionDays: number;
}
export const DEFAULT_SETTINGS: Settings = {
  siteName: "Status",
  warningPercent: 90,
  retentionDays: 7,
};

export interface Overview {
  servers: ServerSnapshot[];
  generatedAt: number;
  settings: Settings;
}
export interface HistoryPoint {
  time: number;
  cpu: number;
  memory: number;
  disk: number;
}
export type ServerState =
  "online" | "warning" | "offline" | "stale" | "pending" | "disabled";
export const STALE_SECONDS = 15;
export const offlineSeconds = (interval = 5) =>
  Math.max(STALE_SECONDS, interval * 3);

export function serverState(server: ServerSnapshot, now: number): ServerState {
  if (server.enabled === false) return "disabled";
  if (server.offline) return "offline";
  if (server.recovering) return "stale";
  if (!server.report || server.lastSeen === null) return "pending";
  if (now - server.lastSeen >= offlineSeconds(server.intervalSeconds))
    return "offline";
  if (now - server.lastSeen >= (server.intervalSeconds ?? 5) * 2)
    return "stale";
  const warning = server.warningPercent ?? 90;
  if (
    server.report.cpu.usagePercent >= warning ||
    server.report.memory.usagePercent >= warning ||
    server.report.disks.some((disk) => disk.usagePercent >= warning)
  )
    return "warning";
  return "online";
}

export function maxDiskUsage(report: Report): number {
  return Math.max(0, ...report.disks.map((disk) => disk.usagePercent));
}
