export type EgressUpstreamMode = 'direct' | 'http' | 'socks5';

export interface AdminEgressConfig {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  publicHost: string;
  upstreamMode: EgressUpstreamMode;
  upstreamHost: string;
  upstreamPort: number;
  upstreamUsername: string;
  codex: boolean;
  cursor: boolean;
  claude: boolean;
}

export interface EgressConnectionEvent {
  id: string;
  at: string;
  username: string;
  provider: 'codex' | 'cursor' | 'claude' | 'control';
  target: string;
  status: 'connected' | 'closed' | 'rejected' | 'error';
  bytesUp: number;
  bytesDown: number;
  detail?: string;
  clientAddress?: string;
  endedAt?: string;
}

export interface EgressTrafficSample {
  at: string;
  upPerSecond: number;
  downPerSecond: number;
}

export interface EgressMonitor {
  startedAt: string;
  sampledAt: string;
  bytesUp: number;
  bytesDown: number;
  upPerSecond: number;
  downPerSecond: number;
  connections: number;
  failures: number;
  rejections: number;
  activeTunnels: number;
  members: { username: string; address: string; connections: number; bytesUp: number; bytesDown: number; targets: string[] }[];
  history: EgressTrafficSample[];
  cliReports: import('./cli-connection').CliConnectionReport[];
  process?: { pid: number; cpuPercent: number; memoryBytes: number; heapBytes: number };
}

export type EgressRelaySnapshot = { running: boolean; activeConnections: number; lastError?: string; events: EgressConnectionEvent[]; fingerprint: string; monitor?: EgressMonitor };

export interface AdminEgressSnapshot {
  config: AdminEgressConfig;
  running: boolean;
  fingerprint: string;
  inviteCode: string;
  hasUpstreamPassword: boolean;
  activeConnections: number;
  lastError?: string;
  events: EgressConnectionEvent[];
  monitor?: EgressMonitor;
}

export interface UserEgressSettings {
  enabled: boolean;
  host: string;
  port: number;
  certificateFingerprint: string;
}

export interface UserEgressStatus {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  available?: boolean;
  endpoint?: string;
  checkedAt?: string;
  detail: string;
  hasAccessCode: boolean;
}

export interface EgressInvite {
  version: 1;
  host: string;
  port: number;
  fingerprint: string;
  accessCode: string;
}
