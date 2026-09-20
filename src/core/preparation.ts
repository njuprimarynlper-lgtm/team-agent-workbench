import path from 'node:path';
import { z } from 'zod';
import type { Draft, DraftDestination, RemoteBinding } from '../shared/types';
import { contributionCategories, contributionCategoryFields, contributionCategoryInfo, contributionCategorySchema, type ContributionCategory } from '../shared/content';
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

export function contributionCategoryDirectory(binding: RemoteBinding, category: ContributionCategory) {
  return contributionDirectory(binding, path.posix.join(binding.project.uploadPath, contributionCategoryInfo[category].folder));
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

const fieldLabels: Record<string, string> = { objective: '目标', change: '本次变化', environment: '环境与口径', baseline: '对照基线', result: '结果', evidence: '依据', scope: '适用范围', limitations: '限制', nextSteps: '下一步', approach: '尝试方法', failure: '未奏效表现', likelyCause: '可能原因', avoidWhen: '不建议使用的条件', reusableInsight: '可复用经验', statement: '结论', uncertainty: '不确定项', problem: '问题', trigger: '触发条件', impact: '影响', reproduction: '复现方式', workaround: '临时处理', nextAction: '建议动作', baselineItem: '拟变更项目项', currentValue: '当前内容', proposedValue: '建议内容', rationale: '理由', validationNeeded: '采纳前验证' };
const artifactSchema = z.object({ category: contributionCategorySchema, title: z.string().trim().min(1).max(120), fields: z.record(z.string(), z.string().trim().max(200000)).default({}), repoUrl: z.string().max(2048).nullable().optional() });
const batchResultSchema = z.object({ artifacts: z.array(artifactSchema).min(1).max(8) });
const legacyResultSchema = z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(200000), repoUrl: z.string().max(2048).nullable().optional(), destinationId: z.string().max(200).nullable().optional() });

export function artifactMarkdown(category: ContributionCategory, fields: Record<string, string>) {
  return contributionCategoryFields[category].filter(key => fields[key]?.trim()).map(key => `## ${fieldLabels[key] || key}\n\n${fields[key].trim()}`).join('\n\n');
}

export function preparationFieldContract() {
  return Object.fromEntries(contributionCategories.map(category => [category, contributionCategoryFields[category]]));
}

export function applyPreparation(draft: Draft, answer: string) {
  let raw: unknown;
  try { raw = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('AI 返回的整理结果格式不完整，请重试整理。你的补充说明已保留。'); }
  const parsed = batchResultSchema.safeParse(raw);
  if (parsed.success) {
    if (!draft.binding) throw new Error('当前会话没有绑定项目，无法确定分类目录。');
    const artifacts = parsed.data.artifacts.map((item, index) => {
      const allowed = new Set(contributionCategoryFields[item.category]);
      const fields = Object.fromEntries(Object.entries(item.fields).filter(([key, value]) => allowed.has(key) && value.trim()));
      const body = artifactMarkdown(item.category, fields);
      if (!body) throw new Error(`“${item.title}”没有可提交的${contributionCategoryInfo[item.category].label}字段。`);
      let repoUrl = '';
      if (item.repoUrl) { try { repoUrl = githubRepository(item.repoUrl); } catch { /* Never guess or retain an invalid repository URL. */ } }
      return { id: `${draft.id}-${index + 1}`, category: item.category, title: item.title, fields, body, repoUrl, target: contributionCategoryDirectory(draft.binding!, item.category), selected: true };
    });
    const first = artifacts[0];
    Object.assign(draft, { artifacts, title: artifacts.length === 1 ? first.title : `${artifacts.length} 项候选成果`, body: first.body, generatedBody: first.body, repoUrl: first.repoUrl, target: first.target, destinationNote: '已按成果类别分开存放。' });
    return;
  }
  // Existing unfinished jobs may still return the version-2 shape. Preserve them as one finding.
  let result: z.infer<typeof legacyResultSchema>;
  try { result = legacyResultSchema.parse(raw); } catch { throw new Error('AI 返回的整理结果格式不完整，请重试整理。你的补充说明已保留。'); }
  let repoUrl = ''; if (result.repoUrl) { try { repoUrl = githubRepository(result.repoUrl); } catch {} }
  const body = result.body.replace(/^#\s+(.+)\r?\n+/u, (full, heading) => heading.trim() === result.title.trim() ? '' : full);
  const target = draft.binding ? contributionCategoryDirectory(draft.binding, 'finding') : undefined;
  const artifact = target ? { id: `${draft.id}-1`, category: 'finding' as const, title: result.title, fields: { statement: body }, body, repoUrl, target, selected: true } : undefined;
  Object.assign(draft, { artifacts: artifact ? [artifact] : [], title: result.title, body, generatedBody: body, repoUrl, target, destinationNote: '旧版整理结果已归入“结论与发现”。' });
}
