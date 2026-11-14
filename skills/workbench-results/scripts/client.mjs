#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const help = `工作台个人成果客户端（Node.js 22+）
用法：node client.mjs --config <会话/results-api.json> <命令> [参数]
读取：context | schema | directories | list [--query 文本] [--include-archived] [--limit 30] [--offset 0] | get --id UUID
写入：create --input JSON | update --id UUID --input JSON | move --id UUID --folder-id 目录ID
附件：upload --id UUID --file 路径 [--name 文件名] | download --id UUID --file-id UUID --output 新文件路径 | remove-file --id UUID --file-id UUID
生命周期：archive --id UUID | restore --id UUID | delete --id UUID
目录：directory --input JSON
已有成果写入需 --if-match '"ETag"' 或 --etag-file <get命令输出的JSON文件>。
写入可指定 --request-id ID；网络重试复用原 ID，其他独立操作使用新 ID。`;

let requestId;
async function readJson(file) {
  const bytes = await fs.readFile(file);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le')
    : bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be').decode(bytes.subarray(2))
      : bytes.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}
try {
  const options = {}, values = new Set(['config', 'query', 'limit', 'offset', 'id', 'input', 'if-match', 'etag-file', 'request-id', 'file', 'name', 'file-id', 'output', 'folder-id']);
  let command;
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === '--help' || arg === '-h') { console.log(help); process.exit(0); }
    if (arg === '--include-archived') { options['include-archived'] = true; continue; }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!values.has(name) || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith('--')) throw Error('未知参数或缺少值：' + arg);
      if (options[name] !== undefined) throw Error('参数不能重复：' + arg);
      options[name] = process.argv[++index];
    } else if (!command) command = arg;
    else throw Error('多余参数：' + arg);
  }
  if (!command) { console.log(help); process.exit(0); }
  const required = name => { const value = options[name]; if (typeof value !== 'string' || !value) throw Error('缺少 --' + name); return value; };
  const configPath = options.config || process.env.WORKBENCH_RESULTS_CONFIG;
  if (!configPath) throw Error('请传入工作台当前会话的 --config 路径');
  const config = await readJson(configPath), base = new URL(config.baseUrl);
  if (config.version !== 1 || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.search || base.hash || !/^\/api\/v1\/projects\/[^/]+$/.test(base.pathname) || !/^[a-f0-9]{64}$/.test(config.token)) throw Error('工作台接口配置无效，请重新读取当前会话配置');
  const routeId = () => '/results/' + encodeURIComponent(required('id'));
  let route, method = 'GET', body, upload, output;
  const readInput = async () => readJson(required('input'));
  switch (command) {
    case 'context': route = '/context'; break;
    case 'schema': route = '/openapi.json'; break;
    case 'directories': route = '/directories'; break;
    case 'list': {
      const query = new URLSearchParams();
      if (options.query) query.set('q', options.query);
      if (options['include-archived']) query.set('includeArchived', 'true');
      for (const field of ['limit', 'offset']) if (options[field] !== undefined) query.set(field, options[field]);
      route = '/results' + (query.size ? '?' + query : ''); break;
    }
    case 'get': route = routeId(); break;
    case 'create': route = '/results'; method = 'POST'; body = await readInput(); break;
    case 'update': route = routeId(); method = 'PATCH'; body = await readInput(); break;
    case 'directory': route = '/directories'; method = 'POST'; body = await readInput(); break;
    case 'move': route = routeId() + '/move'; method = 'POST'; body = { folderId: required('folder-id') }; break;
    case 'archive': case 'restore': route = routeId() + '/archive'; method = 'POST'; body = { archived: command === 'archive' }; break;
    case 'delete': route = routeId(); method = 'DELETE'; break;
    case 'remove-file': route = routeId() + '/attachments/' + encodeURIComponent(required('file-id')); method = 'DELETE'; break;
    case 'upload': {
      const file = path.resolve(required('file')), stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw Error('附件必须是最大 2 GiB 的普通文件');
      route = routeId() + '/attachments?name=' + encodeURIComponent(options.name || path.basename(file)); method = 'POST'; upload = { file, size: stat.size }; break;
    }
    case 'download': route = routeId() + '/attachments/' + encodeURIComponent(required('file-id')); output = path.resolve(required('output')); break;
    default: throw Error('未知命令：' + command);
  }
  let etag = options['if-match'];
  if (options['etag-file']) {
    if (etag) throw Error('--if-match 与 --etag-file 只能选择一个');
    const saved = await readJson(options['etag-file']); etag = saved.etag || saved.data?.etag;
    if (!etag) throw Error('ETag 文件没有 etag 字段');
  }
  const mutation = method !== 'GET';
  if (mutation) requestId = options['request-id'] || randomUUID();
  if (mutation && command !== 'create' && command !== 'directory' && !/^"[a-f0-9]{64}"$/.test(etag || '')) throw Error('修改已有成果需完整 --if-match 或 --etag-file；请先 get 读取');
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { authorization: 'Bearer ' + config.token, ...(requestId ? { 'idempotency-key': requestId } : {}), ...(etag ? { 'if-match': etag } : {}),
    ...(upload ? { 'content-type': 'application/octet-stream', 'content-length': upload.size } : bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) };
  const result = await new Promise((resolve, reject) => {
    // node:http talks directly to loopback; machine HTTP(S)_PROXY cannot reroute it.
    const request = http.request(new URL(base.href + route), { method, headers, agent: false }, response => {
      const status = response.statusCode || 500;
      if (output && status < 400) {
        const target = createWriteStream(output, { flags: 'wx' }); let created = false;
        target.once('open', () => { created = true; });
        pipeline(response, target).then(() => resolve({ status, data: { path: output }, etag: response.headers.etag }), async error => { if (created) await fs.rm(output, { force: true }).catch(() => {}); reject(error); });
      } else {
        const chunks = []; let size = 0;
        response.on('data', part => { size += part.length; if (size > 32 * 1024 * 1024) response.destroy(Error('接口响应过大，请缩小查询范围')); else chunks.push(part); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (status >= 400) { const error = new Error(data.error?.message || 'HTTP ' + status); error.api = { status, ...data }; reject(error); }
            else resolve({ status, data, etag: response.headers.etag, replayed: response.headers['idempotency-replayed'] === 'true' });
          } catch (error) { reject(error); }
        });
      }
    });
    request.setTimeout(5 * 60 * 1000, () => request.destroy(Error('本机接口请求超时；核对结果后使用原 requestId 重试')));
    request.on('error', reject);
    if (upload) pipeline(createReadStream(upload.file), request).catch(reject); else request.end(bytes);
  });
  console.log(JSON.stringify({ ...result, ...(requestId ? { requestId } : {}) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ...(error.api || {}), error: error.api?.error || { code: 'client_error', message: error.message }, ...(requestId ? { requestId } : {}) }, null, 2));
  process.exitCode = 1;
}
