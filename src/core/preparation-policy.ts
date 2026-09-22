import { z } from 'zod';
import { contributionCategoryFields, contributionCategorySchema, contributionTitle } from '../shared/content';
import type { Draft, DraftArtifact } from '../shared/types';

export const preparedResultSchema = z.object({
  category: contributionCategorySchema, topic: z.string().trim().min(1).max(100),
  origin: z.enum(['project', 'local_environment']),
  title: z.string().trim().min(1).max(40), body: z.string().trim().min(1).max(500),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  sourceDetails: z.string().max(4000).optional(), attachmentIds: z.array(z.string().max(100)).max(30).optional(), repoUrl: z.string().max(2048).optional()
});

// A conservative backstop, not a claim that regex can classify arbitrary prose.
// The prompt excludes these before extraction; explicit model origin is also checked.
export function containsLocalEnvironmentError(text: string) {
  return /(?:command not found|CreateProcessAsUser failed)/i.test(text)
    || /(?:未安装|缺少|没有安装|无法导入|找不到模块|no module named)[^。\n]{0,45}(?:PyTorch|torch|python|node|npm|依赖|模块|软件包)/i.test(text)
    || /(?:PyTorch|torch|python|node|npm|依赖|模块|软件包)[^。\n]{0,30}(?:未安装|缺失|无法导入|版本冲突|版本不兼容)/i.test(text)
    || /(?:本机|本地环境|工作机|开发机|当前机器|local environment)[^。\n]{0,60}(?:失败|错误|不足|缺少|缺失|未安装|权限|断网|不通|配置|冲突)/i.test(text)
    || /(?:登录凭证|登录认证|代理连接|本地路径|工具启动|CLI 启动|依赖安装|环境配置)[^。\n]{0,30}(?:失败|错误|过期|无效|缺失|修复|排查|解决)/i.test(text);
}
const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

export function validatePreparedResults(draft: Draft, raw: unknown) {
  const parsed = z.object({ artifacts: z.array(preparedResultSchema).max(5) }).safeParse(raw);
  if (!parsed.success) throw new Error('整理结果不符合精简规则（最多 5 条，标题不超过 40 字、正文不超过 500 字，须有主题和来源），请重试整理');
  const categories = new Set(draft.resultRules!.categories), evidence = new Set(draft.preparationEvidenceIds || []);
  const topics = new Set<string>(), titles = new Set<string>(), bodies = new Set<string>();
  const results: z.infer<typeof preparedResultSchema>[] = [];
  for (const item of parsed.data.artifacts) {
    if (item.origin === 'local_environment' || containsLocalEnvironmentError([item.topic, item.title, item.body, item.sourceDetails].filter(Boolean).join('\n'))) continue;
    if (!categories.has(item.category)) throw new Error('整理结果使用了当前组合未启用的类别，请重试整理');
    if (item.evidenceIds.some(id => !evidence.has(id))) throw new Error('整理结果引用了本次冻结材料中不存在的来源，请重试整理');
    if (item.body.split(/\n\s*\n/).length > 3) throw new Error('成果正文超过三段，请重新精简整理');
    const topic = normalized(item.topic), title = normalized(item.title), body = normalized(item.body);
    if (!topic || topics.has(topic) || titles.has(title) || bodies.has(body)) throw new Error('同一主题被重复整理，请合为一条后重试');
    topics.add(topic); titles.add(title); bodies.add(body); results.push(item);
  }
  return results;
}

export function preparedArtifact(item: z.infer<typeof preparedResultSchema>, id: string, target: string): DraftArtifact {
  return { id, category: item.category, title: contributionTitle(item.category, item.title), body: item.body,
    fields: { [contributionCategoryFields[item.category][0]]: item.body }, target, selected: true,
    topic: item.topic, evidenceIds: item.evidenceIds, sourceDetails: item.sourceDetails,
    attachments: [], repoUrl: item.repoUrl };
}
