import type { EgressConnectionEvent, EgressMonitor as MonitorSnapshot, EgressTrafficSample } from '../shared/egress';
import type { CliConnectionReport } from '../shared/cli-connection';

// Counts opaque tunnel payload once per direction. No prompts, responses or credentials.
export class EgressMonitor {
  private active = new Map<string, EgressConnectionEvent>();
  private recent: EgressConnectionEvent[] = [];
  private bytesUp = 0;
  private bytesDown = 0;
  private connections = 0;
  private failures = 0;
  private rejections = 0;
  private previousUp = 0;
  private previousDown = 0;
  private previousTime: number;
  private history: EgressTrafficSample[] = [];
  private startedAt: string;
  private reports = new Map<string, CliConnectionReport>();
  constructor(private clock = () => performance.now(), private date = () => new Date().toISOString()) {
    this.previousTime = clock(); this.startedAt = date();
  }
  connected(event: EgressConnectionEvent) { this.connections++; this.active.set(event.id, event); }
  transfer(event: EgressConnectionEvent, up: number, down: number) {
    event.bytesUp += up; event.bytesDown += down; this.bytesUp += up; this.bytesDown += down;
  }
  finished(event: EgressConnectionEvent) {
    this.active.delete(event.id); event.endedAt = this.date();
    if (event.status === 'error') this.failures++;
    if (event.status === 'rejected') this.rejections++;
    this.recent.unshift(event); this.recent.length = Math.min(100, this.recent.length);
  }
  events() { return structuredClone([...this.active.values(), ...this.recent].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)); }
  report(value: CliConnectionReport) {
    const key = JSON.stringify([value.username, value.address, value.clientId, value.sessionId]);
    this.reports.delete(key); this.reports.set(key, value);
    while (this.reports.size > 100) this.reports.delete(this.reports.keys().next().value!);
  }
  sample(): MonitorSnapshot {
    const now = this.clock(), seconds = (now - this.previousTime) / 1000;
    if (seconds > 0) {
      this.history.push({ at: this.date(), upPerSecond: (this.bytesUp - this.previousUp) / seconds, downPerSecond: (this.bytesDown - this.previousDown) / seconds });
      this.history = this.history.slice(-60); this.previousTime = now; this.previousUp = this.bytesUp; this.previousDown = this.bytesDown;
    }
    return this.snapshot();
  }
  snapshot(): MonitorSnapshot {
    const members = new Map<string, MonitorSnapshot['members'][number]>();
    for (const event of this.active.values()) {
      const address = event.clientAddress || '', key = JSON.stringify([event.username, address]);
      let member = members.get(key);
      if (!member) { member = { username: event.username, address, connections: 0, bytesUp: 0, bytesDown: 0, targets: [] }; members.set(key, member); }
      member.connections++; member.bytesUp += event.bytesUp; member.bytesDown += event.bytesDown;
      if (!member.targets.includes(event.target)) member.targets.push(event.target);
    }
    const latest = this.history.at(-1);
    return { startedAt: this.startedAt, sampledAt: latest?.at || this.startedAt, bytesUp: this.bytesUp, bytesDown: this.bytesDown,
      upPerSecond: latest?.upPerSecond || 0, downPerSecond: latest?.downPerSecond || 0,
      connections: this.connections, failures: this.failures, rejections: this.rejections, activeTunnels: this.active.size,
      members: [...members.values()], history: [...this.history], cliReports: structuredClone([...this.reports.values()].reverse()) };
  }
}
