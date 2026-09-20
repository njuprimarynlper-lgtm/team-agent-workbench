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
}

export interface EgressConnectionEvent {
  id: string;
  at: string;
  username: string;
  provider: 'codex' | 'cursor' | 'control';
  target: string;
  status: 'connected' | 'closed' | 'rejected' | 'error';
  bytesUp: number;
  bytesDown: number;
  detail?: string;
}

export interface AdminEgressSnapshot {
  config: AdminEgressConfig;
  running: boolean;
  fingerprint: string;
  inviteCode: string;
  hasUpstreamPassword: boolean;
  activeConnections: number;
  lastError?: string;
  events: EgressConnectionEvent[];
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

