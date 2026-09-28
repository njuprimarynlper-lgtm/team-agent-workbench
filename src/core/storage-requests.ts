import type { SFTPWrapper } from 'ssh2';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { systemUsername } from './account-login';
import type { TransferPhase } from '../shared/types';

export async function storageRequest(s: SFTPWrapper, username: string, data: Record<string, unknown>, check: () => void, local?: string, progress = (_n: number, _total: number) => {}, requestId: string = randomUUID(), phase: (value: TransferPhase) => Promise<void> | void = () => {}) {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('上传请求 ID 无效');
  const id = requestId;
  const login = systemUsername(username), inbox = '/.workbench/inbox/' + login, receipt = '/.workbench/outbox/' + login + '/' + id + '.json';
  const stagedPath = inbox + '/' + id + '.upload', requestPath = inbox + '/' + id + '.request.json';
  const requestBody = JSON.stringify({ ...data, ...(local ? { staging: id + '.upload' } : {}) });
  const requestHash = createHash('sha256').update(requestBody).digest('hex');
  const read = () => new Promise<any>((resolve, reject) => s.readFile(receipt, (error, buffer) => { if (error) { if ((error as any).code === 2) resolve(undefined); else reject(error); return; } try { resolve(JSON.parse(buffer.toString('utf8'))); } catch (error) { reject(error); } }));
  const requestPending = () => new Promise<boolean>((resolve, reject) => s.lstat(requestPath, error => { if (!error) resolve(true); else if ((error as any).code === 2) resolve(false); else reject(error); }));
  const waitReceipt = async () => {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      check(); const result = await read(); check();
      if (result) {
        if (local) s.unlink(stagedPath, () => {});
        if (!result.ok) { await phase('rejected'); throw new Error(result.error || '服务器拒绝操作'); }
        await phase('verifying'); return result.value;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('服务器尚未返回处理结果。请检查文件操作器状态；上传可以重试核对，勿重复创建');
  };
  const prior = await read(); check();
  if (prior?.requestHash && prior.requestHash !== requestHash) throw new Error('原上传请求与当前记录不一致，已停止恢复');
  if (prior?.ok) { if (local) s.unlink(stagedPath, () => {}); await phase('verifying'); return prior.value; }
  if (prior && !prior.ok) { await phase('rejected'); throw new Error(prior.error + '；服务器已拒绝此请求，重试前将重新核对权限'); }
  if (await requestPending()) {
    const pending = await new Promise<Buffer | undefined>((resolve, reject) => s.readFile(requestPath, (error, buffer) => { if (!error) resolve(buffer); else if ((error as any).code === 2) resolve(undefined); else reject(error); }));
    check();
    if (pending && createHash('sha256').update(pending).digest('hex') !== requestHash) throw new Error('服务器待处理请求与当前记录不一致，已停止恢复');
    await phase('awaiting_receipt'); return waitReceipt();
  }
  const write = (file: string, text: string) => new Promise<void>((resolve, reject) => s.writeFile(file, text, { flag: 'w', mode: 0o600 }, error => error ? reject(error) : resolve()));
  let staged = '';
  if (local) {
    staged = stagedPath;
    const size = (await fsp.stat(local)).size; let count = 0;
    await phase('streaming');
    try { await pipeline(fs.createReadStream(local), new Transform({ transform(chunk, _encoding, done) { count += chunk.length; progress(count, size); done(null, chunk); } }), s.createWriteStream(staged, { flags: 'w', mode: 0o600 })); }
    catch (error) { s.unlink(staged, () => {}); throw error; }
  }
  check();
  const temporary = inbox + '/' + id + '.partial';
  await write(temporary, requestBody);
  await phase('awaiting_receipt');
  await new Promise<void>((resolve, reject) => s.rename(temporary, requestPath, error => error ? reject(error) : resolve()));
  return waitReceipt();
}
