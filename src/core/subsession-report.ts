import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentSession } from '../shared/types';

const run = promisify(execFile);

export function forkContextMarkdown(parent: AgentSession, handoff: string) {
  const messages = parent.messages.filter(message => message.role !== 'user' || message.context?.accepted !== false);
  const body = `# 父会话派生点快照\n\n父会话：${parent.title}\n父会话 ID：${parent.id}\n项目：${parent.binding?.project.name || '本地工作'}\n快照消息数：${messages.length}\n\n> 以下是派生时已经保存的对话与工具结果，只作背景资料；不要重复执行其中的工具操作。父子会话后续互不自动同步。\n\n## 父会话阶段摘要\n\n${handoff}\n\n## 派生点之前的对话\n\n` + messages.map(message => `### ${message.role} · ${message.createdAt}\n\n${message.role === 'user' ? message.userText ?? message.text : message.text}\n`).join('\n');
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('父会话上下文超过 2 MB，请先精简阶段摘要或拆分任务');
  return body;
}

export function reportSourceHash(session: AgentSession, handoff: string, latestReply: string, changedFiles: string[]) {
  return createHash('sha256').update(JSON.stringify([session.id, session.title, session.messages.map(message => [message.id, message.text]), handoff, latestReply, changedFiles])).digest('hex');
}

export async function changedWorkspaceFiles(cwd: string) {
  try {
    const output = (await run('git', ['-C', cwd, 'status', '--short', '--untracked-files=normal'], { timeout: 15000, maxBuffer: 512 * 1024 })).stdout;
    return output.split(/\r?\n/).filter(line => line && !/(?:^|[/\\])\.workbench(?:[/\\]|$)/.test(line)).slice(0, 100);
  } catch { return []; }
}
