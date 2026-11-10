import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardHash, type ResponseBody } from './codex-guard-history';

export interface CompactWorkspace { cwd: string; id: string }
export interface ToolReceipt { index: number; file: string; content: string; bytes: number; replacement: string | object[] }

// Only a returned result paired with its actual call can become a file reference.
// Leave unknown formats, pending executions and provider items intact.
export function compactToolReceipts(body: ResponseBody, workspace: CompactWorkspace): ToolReceipt[] {
  if (!path.isAbsolute(workspace.cwd) || !/^[a-z0-9_-]{1,128}$/i.test(workspace.id) || !Array.isArray(body.input)) return [];
  const calls = new Map<string, string>();
  const receipts: ToolReceipt[] = [];
  for (const [index, item] of body.input.entries()) {
    if (!item || typeof item.call_id !== 'string') continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      calls.set(item.call_id, item.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output');
      continue;
    }
    if (!calls.has(item.call_id) || item.type !== calls.get(item.call_id)) continue;
    const output = item.output;
    const parts = Array.isArray(output);
    if (typeof output !== 'string' && !(parts && output.every(p => p && (
      ['input_text', 'output_text', 'text'].includes(p.type) && typeof p.text === 'string' ||
      p.type === 'input_image' && typeof p.image_url === 'string')))) continue;
    const content = parts ? JSON.stringify(output) : output;
    const bytes = Buffer.byteLength(content);
    if (bytes < 4096 || (item.status && !['completed', 'failed'].includes(item.status))) continue;
    const display = parts ? output.filter(p => typeof p.text === 'string').map(p => p.text).join('\n') : content;
    // exec_command / write_stdin may return an output while their process still runs.
    if (/Process running with session ID/i.test(display.slice(0, 2048))) continue;
    const exit = /(?:Process exited with code|Exit code:)\s*(-?\d+)/i.exec(display.slice(0, 2048));
    const status = exit ? '退出码 ' + exit[1] : item.status === 'failed' ? '工具报告失败' : '工具已返回，未提供退出码';
    const file = guardHash(content) + (parts ? '.json' : '.txt');
    const relative = path.join('.workbench', 'sessions', workspace.id, 'tool-results', file);
    const excerpt = display.length <= 900 ? display : display.slice(0, 400) + '\n…\n' + display.slice(-500);
    const reference = `[工具结果已保存] ${status}，${bytes} 字节。按需读取工作目录中的文件：${relative}\n完整路径：${path.join(workspace.cwd, relative)}\n${excerpt}`;
    receipts.push({ index, file, content, bytes, replacement: parts ? [{ type: 'input_text', text: reference }] : reference });
  }
  return receipts.sort((a, b) => b.bytes - a.bytes);
}

export async function saveCompactReceipts(workspace: CompactWorkspace, receipts: ToolReceipt[], signal: AbortSignal) {
  // As with session handoffs, the workspace may expose .workbench via a
  // junction. Anchor there, and forbid further directory redirects.
  const metadata = path.join(workspace.cwd, '.workbench');
  await fs.mkdir(metadata, { recursive: true });
  let directory = await fs.realpath(metadata);
  for (const part of ['sessions', workspace.id, 'tool-results']) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('工具结果目录存在不安全的路径');
  }
  for (const receipt of receipts) {
    signal.throwIfAborted();
    const file = path.join(directory, receipt.file);
    const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== receipt.bytes ||
          !(await fs.readFile(file)).equals(Buffer.from(receipt.content))) throw new Error('已保存的工具结果无法校验');
      continue;
    }
    const temp = path.join(directory, randomUUID() + '.tmp');
    try {
      await fs.writeFile(temp, receipt.content, { mode: 0o600, flag: 'wx', signal });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  }
}
