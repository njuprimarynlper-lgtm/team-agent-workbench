import os from 'node:os';
import { EgressRelay } from '../core/egress';

const parent = process.parentPort;
if (!parent) throw new Error('网络出口必须由管理端启动');
let relay: EgressRelay | undefined;
let timer: NodeJS.Timeout | undefined;
let previousCpu = process.cpuUsage(), previousTime = performance.now();
let resources: { pid: number; cpuPercent: number; memoryBytes: number; heapBytes: number } | undefined;
const publish = () => {
  if (!relay) return;
  const snapshot = relay.snapshot(); snapshot.monitor.process = resources;
  parent.postMessage({ type: 'snapshot', value: snapshot });
};
const sample = () => {
  const now = performance.now(), cpu = process.cpuUsage(), seconds = (now - previousTime) / 1000;
  const memory = process.memoryUsage();
  resources = { pid: process.pid, cpuPercent: seconds > 0 ? Math.max(0, (cpu.user + cpu.system - previousCpu.user - previousCpu.system) / 1e6 / seconds / os.cpus().length * 100) : 0, memoryBytes: memory.rss, heapBytes: memory.heapUsed };
  previousCpu = cpu; previousTime = now; relay?.monitor.sample(); publish();
};
let work: Promise<void> = Promise.resolve();
parent.on('message', ({ data }) => {
  work = work.then(async () => {
    try {
      if (data.action === 'start') {
        if (relay) throw new Error('代理进程已经启动');
        const { config, secret, certificate } = data.payload;
        relay = new EgressRelay(config, secret, { ...certificate, pfx: Buffer.from(certificate.pfx) });
        relay.on('changed', publish); await relay.start(); sample(); timer = setInterval(sample, 2000);
      } else if (data.action === 'stop') { clearInterval(timer); await relay?.stop(); }
      else if (data.action === 'probe') { if (!relay) throw new Error('代理尚未启动'); await relay.probe(data.payload.provider); }
      else throw new Error('不支持的代理操作');
      parent.postMessage({ type: 'response', id: data.id, value: true });
    } catch (error) { parent.postMessage({ type: 'response', id: data.id, error: error instanceof Error ? error.message : '代理操作失败' }); }
  });
});
