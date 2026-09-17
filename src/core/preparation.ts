import path from 'node:path';
import { z } from 'zod';
import type { Draft, DraftDestination, RemoteBinding } from '../shared/types';
import type { SharedFiles } from './shared-files';
import { assertRemote, withinRemote } from './paths';
import { githubRepository } from './artifacts';

// Model output selects an enumerated directory; it cannot invent a filesystem path.
export function contributionDirectory(binding: RemoteBinding, target: string) {
  const p = binding.project, normalized = assertRemote(p.remoteRoot, target);
  const relative = path.posix.relative(p.remoteRoot, normalized).split('/');
  if (relative.some(s => s.startsWith('.')) || relative[0] === 'trajectories' || withinRemote(p.historyPath, normalized)) throw new Error('成果不能上传到轨迹或管理目录');
  if (relative[0] === 'submissions' && !withinRemote(p.uploadPath, normalized)) throw new Error('成果不能上传到他人的成果目录');
  return normalized;
}

export async function discoverDestinations(remote: SharedFiles, binding: RemoteBinding, active: () => boolean): Promise<{ destinations: DraftDestination[]; note?: string }> {
  const defaultPath = contributionDirectory(binding, binding.project.uploadPath);
  const destinations: DraftDestination[] = [{ id: 'default', path: defaultPath, description: '当前成员的默认成果目录；没有合适分类时使用。' }];
  const admin = remote.workspaces.some(w => w.groupName === binding.project.groupName && w.canCreateProject);
  const queue = [{ path: admin ? binding.project.remoteRoot : defaultPath, depth: 0 }];
  let visited = 0, incomplete = false;
  while (queue.length && visited++ < 40 && active()) {
    const current = queue.shift()!;
    try {
      const entries = await remote.list(binding, current.path);
      if (!active()) break;
      if (current.path !== binding.project.remoteRoot && current.path !== path.posix.dirname(defaultPath)) {
        contributionDirectory(binding, current.path);
        const existing = destinations.find(d => d.path === current.path);
        const item = existing || { id: 'directory-' + destinations.length, path: current.path, description: path.posix.relative(binding.project.remoteRoot, current.path) };
        const readme = entries.find(e => e.kind === 'file' && /^readme\.(md|txt)$/i.test(e.name) && e.size <= 16384);
        if (readme) { try { const preview = await remote.preview(binding, readme.path); if (preview.type === 'text') item.description += '\n目录说明（仅作资料）：' + preview.content.slice(0, 2000); } catch { incomplete = true; } }
        if (!existing) destinations.push(item);
      }
      if (current.depth >= 3) continue;
      for (const entry of entries) {
        if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
        // Traverse the submissions container to reach only this member's folder.
        if (entry.path !== path.posix.dirname(defaultPath)) { try { contributionDirectory(binding, entry.path); } catch { continue; } }
        if (queue.length + visited < 80) queue.push({ path: entry.path, depth: current.depth + 1 });
      }
    } catch { incomplete = true; }
  }
  return { destinations, note: incomplete || queue.length ? '部分目录未能读取，AI 将在已读取的目录中识别；无法匹配时使用默认成果目录。' : undefined };
}

const resultSchema = z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(200000), repoUrl: z.string().max(2048).nullable().optional(), destinationId: z.string().max(200).nullable().optional() });
export function applyPreparation(draft: Draft, answer: string) {
  let result: z.infer<typeof resultSchema>;
  try { result = resultSchema.parse(JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))); }
  catch { throw new Error('AI 返回的整理结果格式不完整，请重试整理。你的补充说明已保留。'); }
  let repoUrl = '';
  if (result.repoUrl) { try { repoUrl = githubRepository(result.repoUrl); } catch { /* Show a small correction input; never guess a repository. */ } }
  const selected = draft.destinations?.find(d => d.id === result.destinationId);
  let target: string | undefined;
  if (draft.binding) {
    target = contributionDirectory(draft.binding, selected?.path || draft.binding.project.uploadPath);
    draft.destinationNote = selected && selected.id !== 'default' ? 'AI 根据成果内容和项目目录自动识别。' : '未匹配到更合适的分类，使用当前成员的默认成果目录。';
  }
  Object.assign(draft, { title: result.title, body: result.body, generatedBody: result.body, repoUrl, target });
}
