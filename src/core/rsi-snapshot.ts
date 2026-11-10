import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const rsiSnapshotName = 'rsi-v2.daily-snapshot.json';

function localDay(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function validRsi(value: any) {
  return value && [2, 3].includes(value.version) && value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects);
}

/** One durable, rolling snapshot per account. A damaged source never replaces a valid snapshot. */
export class RsiDailySnapshot {
  private capturedDay?: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(private root: string, private validate: (value: unknown) => unknown = value => {
    if (!validRsi(value)) throw new Error('AI推荐快照来源格式无效');
  }, private prepareSource?: () => Promise<void>) {}

  private validateFile(value: string) { this.validate(JSON.parse(value)); }

  captureIfDue(now = new Date()) {
    const day = localDay(now);
    const next = this.pending.catch(() => {}).then(async () => {
      if (this.capturedDay === day) return;
      const snapshot = path.join(this.root, rsiSnapshotName);
      const prior = await fs.stat(snapshot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (prior && localDay(prior.mtime) === day) {
        try {
          this.validateFile(await fs.readFile(snapshot, 'utf8'));
          this.capturedDay = day; return;
        } catch { /* Replace an invalid snapshot only after the source passes validation. */ }
      }
      const temp = snapshot + '.' + randomUUID() + '.tmp';
      try {
        await this.prepareSource?.();
        await fs.copyFile(path.join(this.root, 'rsi-v2.json'), temp, constants.COPYFILE_EXCL);
        this.validateFile(await fs.readFile(temp, 'utf8'));
        const handle = await fs.open(temp, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.utimes(temp, now, now);
        await fs.rename(temp, snapshot);
        this.capturedDay = day;
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    });
    this.pending = next;
    return next;
  }

  async restoreFromSnapshot<T>(validate: (value: unknown) => T): Promise<{ value: T; snapshotAt: string; archivePath?: string }> {
    const source = path.join(this.root, 'rsi-v2.json'), snapshot = path.join(this.root, rsiSnapshotName);
    const prior = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const snapshotInfo = await fs.stat(snapshot);
    const temp = source + '.restore-' + randomUUID() + '.tmp';
    try {
      await fs.copyFile(snapshot, temp, constants.COPYFILE_EXCL);
      const value = validate(JSON.parse(await fs.readFile(temp, 'utf8')));
      let archivePath: string | undefined;
      if (prior) {
        const recovery = path.join(this.root, 'recovery');
        await fs.mkdir(recovery, { recursive: true });
        archivePath = path.join(recovery, 'rsi-v2.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.json');
        await fs.copyFile(source, archivePath, constants.COPYFILE_EXCL);
        if ((await fs.stat(archivePath)).size !== prior.size) throw new Error('AI推荐损坏原件未能完整保留');
      }
      const handle = await fs.open(temp, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      const current = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!!current !== !!prior || current && prior && (current.size !== prior.size || current.mtimeMs !== prior.mtimeMs)) throw new Error('AI推荐数据在恢复期间发生变化，请重新读取');
      await fs.rename(temp, source);
      validate(JSON.parse(await fs.readFile(source, 'utf8')));
      return { value, snapshotAt: snapshotInfo.mtime.toISOString(), archivePath };
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }

  async settled() { await this.pending.catch(() => {}); }
}
