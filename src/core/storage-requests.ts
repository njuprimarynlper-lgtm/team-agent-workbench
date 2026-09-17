import type { SFTPWrapper } from 'ssh2';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { systemUsername } from './account-login';

export async function storageRequest(s: SFTPWrapper, username: string, data: Record<string, unknown>, check: () => void, local?: string, progress = (_n: number, _total: number) => {}) {
  const id = randomUUID();
  const login = systemUsername(username), inbox = '/.workbench/inbox/' + login, receipt = '/.workbench/outbox/' + login + '/' + id + '.json';
  const read = () => new Promise<any>((resolve, reject) => s.readFile(receipt, (error, buffer) => { if (error) { if ((error as any).code === 2) resolve(undefined); else reject(error); return; } try { resolve(JSON.parse(buffer.toString('utf8'))); } catch (error) { reject(error); } }));
  const prior = await read(); check();
  if (prior?.ok) return prior.value;
  if (prior && !prior.ok) throw new Error(prior.error + '；请重新提交形成新的请求');
  const write = (file: string, text: string) => new Promise<void>((resolve, reject) => s.writeFile(file, text, { flag: 'w', mode: 0o600 }, error => error ? reject(error) : resolve()));
  let staged = '';
  if (local) {
    staged = inbox + '/' + id + '.upload';
    const size = (await fsp.stat(local)).size; let count = 0;
    await pipeline(fs.createReadStream(local), new Transform({ transform(chunk, _encoding, done) { count += chunk.length; progress(count, size); done(null, chunk); } }), s.createWriteStream(staged, { flags: 'w', mode: 0o600 }));
  }
  check();
  const temporary = inbox + '/' + id + '.partial';
  await write(temporary, JSON.stringify({ ...data, ...(local ? { staging: id + '.upload' } : {}) }));
  await new Promise<void>((resolve, reject) => s.rename(temporary, inbox + '/' + id + '.request.json', error => error ? reject(error) : resolve()));
  const started = Date.now();
  while (Date.now() - started < 120000) {
    check(); const result = await read();
    if (result) {
      if (staged) s.unlink(staged, () => {});
      if (!result.ok) throw new Error(result.error || '服务器拒绝操作');
      return result.value;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('服务器尚未返回处理结果。请检查文件操作器状态；上传可以重试核对，勿重复创建');
}
