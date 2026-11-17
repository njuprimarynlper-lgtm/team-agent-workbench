'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createGzip, createGunzip } = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
// Reserve 4 MiB inside the 30 MiB diagnostic budget for bounded pre-Node
// startup staging. It is imported into this store, never retained as a second log.
const limits = { diagnostic: { days: 14, bytes: 26 * 1024 ** 2, rotate: 4 * 1024 ** 2 }, workflow: { days: 90, bytes: 20 * 1024 ** 2, rotate: 2 * 1024 ** 2 } };
const managed = /^(diagnostic|workflow)-(\d{13})-([a-f0-9-]+)\.jsonl(?:\.gz)?$/;
const segment = /^events-(\d{8})\.jsonl(?:\.gz)?$/;
const queryLimits = { files: 256, bytes: 32 * 1024 ** 2, line: 16384, rows: 100000, milliseconds: 5000 };
const logKey = row => row.at + ':' + row.id;
const queryFingerprint = (input, scope) => createHash('sha256').update(JSON.stringify({ scope, category: input.category || 'diagnostic', from: input.from, to: input.to, id: input.id, operationId: input.operationId, projectId: input.projectId, sessionId: input.sessionId, code: input.code, level: input.level })).digest('hex');
class LogStorage {
  constructor(root, options = {}) { this.root = path.resolve(root); this.directory = path.join(this.root, 'logs'); this.limits = options.limits || limits; this.now = options.now || Date.now; this.active = {}; this.traceSizes = new Map(); this.lastCleanup = 0; }
  async safe(directory) {
    const relative = path.relative(this.root, path.resolve(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('日志路径越界');
    await fsp.mkdir(this.root, { recursive: true });
    let current = this.root;
    for (const name of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (name) current = path.join(current, name);
      await fsp.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fsp.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('日志目录不能使用符号链接');
    }
  }
  async files() {
    const names = await fsp.readdir(this.directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const result = [];
    for (const entry of names) if (entry.isFile() && !entry.isSymbolicLink() && managed.test(entry.name)) {
      const match = managed.exec(entry.name), file = path.join(this.directory, entry.name), stat = await fsp.stat(file);
      result.push({ file, name: entry.name, category: match[1], at: Number(match[2]), bytes: stat.size });
    }
    return result.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  }
  async query(input, scope, detail = false) {
    if (!scope || typeof scope.account !== 'string' || !/^[\w.:-]{1,128}$/.test(scope.account)) throw Error('日志查询范围无效');
    const limit = Math.max(1, Math.min(100, Number.isInteger(input.limit) ? input.limit : 30));
    const fingerprint = queryFingerprint(input, scope), coverage = { malformed: 0, missingFiles: 0, legacyScopeSkipped: 0, scannedBytes: 0, truncated: false };
    let through = new Date(this.now()).toISOString(), before;
    if (input.cursor) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error();
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (cursor.fingerprint !== fingerprint || typeof cursor.through !== 'string' || !Number.isFinite(Date.parse(cursor.through)) || typeof cursor.before !== 'string' || cursor.before.length > 180) throw Error();
        through = cursor.through; before = cursor.before;
      } catch { throw Error('日志分页已失效，请重新查询'); }
    }
    // Do not follow a substituted logs directory, even for a read-only request.
    const directory = await fsp.lstat(this.directory).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (!directory) return detail ? { coverage } : { items: [], coverage };
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('日志目录不可读取');
    const candidates = (await this.files()).filter(file => file.category === (input.category || 'diagnostic')).reverse();
    if (candidates.length > queryLimits.files) coverage.truncated = true;
    const rows = [], seen = new Set(), started = Date.now(); let scannedRows = 0;
    const consume = line => {
      if (!line.length) return;
      let row; try { row = JSON.parse(line.toString('utf8')); } catch { coverage.malformed++; return; }
      if (!row || row.schema !== 1 || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.id) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || row.category !== (input.category || 'diagnostic') || typeof row.name !== 'string') { coverage.malformed++; return; }
      if (row.account !== scope.account) { if (!row.account) coverage.legacyScopeSkipped++; return; }
      if (row.centralId !== scope.centralId) { if (!row.centralId) coverage.legacyScopeSkipped++; return; }
      if (scope.projectId && row.projectId !== scope.projectId || scope.sessionId && row.sessionId !== scope.sessionId) return;
      if (input.projectId && row.projectId !== input.projectId || input.sessionId && row.sessionId !== input.sessionId || input.operationId && row.operationId !== input.operationId || input.id && row.id !== input.id || input.code && row.code !== input.code) return;
      if (!detail && (input.level ? row.level !== input.level : !['warning', 'error'].includes(row.level))) return;
      if (row.at > through || input.from && row.at < input.from || input.to && row.at > input.to || before && logKey(row) >= before || seen.has(row.id)) return;
      rows.push(row); rows.sort((a, b) => logKey(a) < logKey(b) ? 1 : logKey(a) > logKey(b) ? -1 : 0);
      seen.add(row.id);
      if (rows.length > limit + 1) { const removed = rows.pop(); seen.delete(removed.id); }
    };
    for (const file of candidates.slice(0, queryLimits.files)) {
      if (coverage.scannedBytes >= queryLimits.bytes || scannedRows >= queryLimits.rows || Date.now() - started > queryLimits.milliseconds) { coverage.truncated = true; break; }
      let handle, source, reader;
      try {
        const info = await fsp.lstat(file.file); if (!info.isFile() || info.isSymbolicLink()) { coverage.missingFiles++; continue; }
        handle = await fsp.open(file.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = await handle.stat(); if (!stat.isFile() || !stat.size) continue;
        source = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false });
        reader = file.file.endsWith('.gz') ? source.pipe(createGunzip()) : source;
        if (reader !== source) source.on('error', error => reader.destroy(error));
        let pending = Buffer.alloc(0), skipping = false;
        for await (const chunk of reader) {
          coverage.scannedBytes += chunk.length;
          if (coverage.scannedBytes > queryLimits.bytes || Date.now() - started > queryLimits.milliseconds) { coverage.truncated = true; break; }
          let offset = 0, end;
          while ((end = chunk.indexOf(10, offset)) >= 0) {
            const piece = chunk.subarray(offset, end);
            if (!skipping && pending.length + piece.length <= queryLimits.line) consume(pending.length ? Buffer.concat([pending, piece]) : piece);
            else coverage.malformed++;
            pending = Buffer.alloc(0); skipping = false; offset = end + 1;
            if (++scannedRows >= queryLimits.rows) { coverage.truncated = true; break; }
          }
          if (coverage.truncated && scannedRows >= queryLimits.rows) break;
          const tail = chunk.subarray(offset);
          if (!skipping && pending.length + tail.length <= queryLimits.line) pending = Buffer.concat([pending, tail]);
          else { pending = Buffer.alloc(0); skipping = true; }
        }
        // An incomplete crash tail is not a complete record.
        if (pending.length || skipping) coverage.malformed++;
      } catch (error) {
        if (error.code === 'ENOENT') coverage.missingFiles++;
        else if (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR') coverage.malformed++;
        else throw error;
      } finally { reader?.destroy(); source?.destroy(); await handle?.close(); }
    }
    if (detail) return { record: rows[0], coverage };
    const hasMore = rows.length > limit, selected = rows.slice(0, limit);
    return { items: selected, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ through, before: logKey(selected.at(-1)), fingerprint })).toString('base64url') } : {}), coverage };
  }
  async cleanup(clear = false) {
    for (const entry of await fsp.readdir(this.directory, { withFileTypes: true }).catch(() => [])) if (entry.isFile() && !entry.isSymbolicLink() && /^(diagnostic|workflow)-\d{13}-[a-f0-9-]+\.jsonl\.gz\.[a-f0-9-]+\.tmp$/.test(entry.name)) await fsp.rm(path.join(this.directory, entry.name));
    if (!clear) for (const file of await this.files()) if (!file.file.endsWith('.gz') && this.active[file.category] !== file.file) {
      if (await fsp.stat(file.file).catch(error => { if (error.code === 'ENOENT') return; throw error; })) await this.compress(file.file, file.file + '.gz');
    }
    const files = await this.files();
    for (const category of Object.keys(this.limits)) {
      const entries = files.filter(file => file.category === category), policy = this.limits[category]; let total = entries.reduce((sum, file) => sum + file.bytes, 0);
      for (const entry of entries) {
        if (!clear && entry.at >= this.now() - policy.days * 86400000 && total <= policy.bytes) continue;
        await fsp.rm(entry.file); total -= entry.bytes;
        if (this.active[category] === entry.file) delete this.active[category];
      }
    }
    this.lastCleanup = this.now();
  }
  async compress(source, target) {
    const category = managed.exec(path.basename(source))?.[1];
    if (category) {
      const files = (await this.files()).filter(file => file.category === category), extra = (await fsp.stat(source)).size;
      let total = files.reduce((sum, file) => sum + file.bytes, 0);
      for (const file of files) if (total + extra > this.limits[category].bytes && file.file !== source && file.file !== this.active[category]) { await fsp.rm(file.file); total -= file.bytes; }
    }
    const pending = target + '.' + randomUUID() + '.tmp';
    try {
      const inputHash = createHash('sha256'), outputHash = createHash('sha256');
      await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, _, done) { inputHash.update(chunk); done(null, chunk); } }), createGzip(), fs.createWriteStream(pending, { flags: 'wx', mode: 0o600 }));
      await pipeline(fs.createReadStream(pending), createGunzip(), new Transform({ transform(chunk, _, done) { outputHash.update(chunk); done(); } }));
      if (inputHash.digest('hex') !== outputHash.digest('hex')) throw Error('日志无损压缩校验失败，原件已保留');
      await fsp.rename(pending, target); await fsp.rm(source);
    } finally { await fsp.rm(pending, { force: true }).catch(() => {}); }
  }
  async append(records) {
    await this.safe(this.directory);
    if (!this.lastCleanup || this.now() - this.lastCleanup >= 3600000) await this.cleanup();
    for (const record of records) {
      const category = record.category; if (!this.limits[category]) throw Error('未知日志类型');
      const line = JSON.stringify(record) + '\n'; if (Buffer.byteLength(line) > 16384) throw Error('日志记录超长');
      let file = this.active[category], stat = file && await fsp.stat(file).catch(() => undefined);
      if (stat && (stat.size + Buffer.byteLength(line) > this.limits[category].rotate || new Date(stat.birthtimeMs).toDateString() !== new Date(this.now()).toDateString())) {
        await this.compress(file, file + '.gz'); delete this.active[category]; file = undefined; await this.cleanup();
      }
      if (!file) file = this.active[category] = path.join(this.directory, `${category}-${this.now()}-${randomUUID()}.jsonl`);
      await fsp.appendFile(file, line, { mode: 0o600 });
    }
    await this.cleanup();
  }
  async sealTrace(directory) {
    let recoveredIncomplete = false;
    this.traceSizes.delete(directory);
    await this.safe(directory);
    for (const name of await fsp.readdir(directory)) if (/^events-\d{8}\.jsonl\.gz\.[a-f0-9-]+\.tmp$/.test(name)) {
      const base = name.replace(/\.gz\.[a-f0-9-]+\.tmp$/, '');
      if (await fsp.stat(path.join(directory, base)).catch(() => undefined) || await fsp.stat(path.join(directory, base + '.gz')).catch(() => undefined)) await fsp.rm(path.join(directory, name));
    }
    const source = path.join(directory, 'events.jsonl'); const stat = await fsp.lstat(source).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (stat?.isSymbolicLink()) throw Error('轨迹文件不能使用符号链接');
    if (stat?.size) {
      const names = await fsp.readdir(directory), last = Math.max(0, ...names.map(name => Number(segment.exec(name)?.[1] || 0)));
      if (last >= 99999999) throw Error('轨迹分段数量超限');
      await fsp.rename(source, path.join(directory, `events-${String(last + 1).padStart(8, '0')}.jsonl`));
    }
    for (const name of await fsp.readdir(directory)) if (/^events-\d{8}\.jsonl$/.test(name)) {
      const plain = path.join(directory, name), compressed = plain + '.gz';
      const handle = await fsp.open(plain, 'r'), stat = await handle.stat(), tail = Buffer.alloc(1);
      try { if (stat.size) await handle.read(tail, 0, 1, stat.size - 1); } finally { await handle.close(); }
      if (stat.size && tail[0] !== 10) { await fsp.appendFile(plain, '\n'); recoveredIncomplete = true; }
      // Re-verify after a crash; never discard a source merely because a target exists.
      await this.compress(plain, compressed);
    }
    return { recoveredIncomplete };
  }
  async trace(directory, line) {
    const relative = path.relative(this.root, directory);
    if (!/(^|[\\/])sessions[\\/][a-f0-9-]{36}$/.test(relative)) throw Error('无效轨迹目录');
    await this.safe(directory);
    const file = path.join(directory, 'events.jsonl'), cached = this.traceSizes.get(directory), stat = cached === undefined ? await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return; throw error; }) : { size: cached, isSymbolicLink: () => false };
    if (stat?.isSymbolicLink()) throw Error('轨迹文件不能使用符号链接');
    let recoveredIncomplete = false;
    if (cached === undefined && stat?.size) {
      const handle = await fsp.open(file, 'r'), tail = Buffer.alloc(1);
      try { await handle.read(tail, 0, 1, stat.size - 1); } finally { await handle.close(); }
      if (tail[0] !== 10) { await fsp.appendFile(file, '\n'); recoveredIncomplete = true; }
    }
    let bytes = (stat?.size || 0) + (recoveredIncomplete ? 1 : 0);
    if (bytes >= 4 * 1024 ** 2) { await this.sealTrace(directory); bytes = 0; }
    await fsp.appendFile(file, line, { mode: 0o600 });
    this.traceSizes.set(directory, bytes + Buffer.byteLength(line));
    if (this.traceSizes.size > 256) this.traceSizes.delete(this.traceSizes.keys().next().value);
    return { recoveredIncomplete };
  }
  async usage(traceRoots = []) {
    const files = await this.files(), usage = {};
    for (const category of Object.keys(this.limits)) {
      const entries = files.filter(file => file.category === category), policy = this.limits[category];
      usage[category] = { bytes: entries.reduce((sum, file) => sum + file.bytes, 0), files: entries.length, limit: policy.bytes, days: policy.days, oldest: entries.length ? new Date(entries[0].at).toISOString() : undefined, newest: entries.length ? new Date(entries.at(-1).at).toISOString() : undefined };
    }
    let bytes = 0, sessions = 0;
    for (const root of traceRoots) {
      const relative = path.relative(this.root, root); if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      for (const entry of await fsp.readdir(path.join(root, 'sessions'), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9-]{36}$/.test(entry.name)) {
        let found = false;
        for (const item of await fsp.readdir(path.join(root, 'sessions', entry.name), { withFileTypes: true })) if (item.isFile() && !item.isSymbolicLink() && (item.name === 'events.jsonl' || segment.test(item.name))) { bytes += (await fsp.stat(path.join(root, 'sessions', entry.name, item.name))).size; found = true; }
        if (found) sessions++;
      }
    }
    return { ...usage, traces: { bytes, sessions } };
  }
}
module.exports = { LogStorage, limits, managed };
if (parentPort) {
  const storage = new LogStorage(workerData.root); let queue = Promise.resolve();
  parentPort.on('message', message => {
    queue = queue.catch(() => {}).then(async () => {
      try {
        const value = message.action === 'append' ? await storage.append(message.records) : message.action === 'trace' ? await storage.trace(message.directory, message.line) : message.action === 'seal' ? await storage.sealTrace(message.directory) : message.action === 'cleanup' ? await storage.cleanup(message.clear) : message.action === 'status' ? await storage.usage(message.roots) : message.action === 'files' ? await storage.files() : message.action === 'query' ? await storage.query(message.input, message.scope) : message.action === 'get' ? await storage.query({ id: message.recordId, category: 'diagnostic', limit: 1 }, message.scope, true) : undefined;
        parentPort.postMessage({ id: message.id, value });
      } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
    });
  });
}
