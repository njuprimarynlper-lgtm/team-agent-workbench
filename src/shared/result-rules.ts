import { z } from 'zod';
import { contributionCategoryInfo, materialCategories, type ContributionCategory } from './content';

export type MaterialCategory = typeof materialCategories[number];
export const materialCategorySchema = z.enum(materialCategories);
export const resultCategoryBoundaries: Record<MaterialCategory, { question: string; include: string; exclude: string }> = {
  finding: { question: '证据支持什么可复用判断？', include: '有事实支持、会影响后续决策的判断，写清适用边界。', exclude: '只描述一次测试归验证结果；待检验假设归方法探索；不要把静态检查推广为性能或精度结论。' },
  project_standard: { question: '哪些规则必须遵守？', include: '人明确确认的规范、约束、验收阈值和判定口径。', exclude: 'AI 建议不能升为标准；要做的功能归需求说明；怎么实现归设计方案。' },
  requirement: { question: '需要做什么、不做什么？', include: '有明确来源的用户/业务目标、行为、范围和非目标；未确认的需求必须说明待确认。', exclude: '实现结构归设计方案；强制规范和已确认验收阈值归项目标准；模型自行提出的优化归改进建议。' },
  design: { question: '为具体需求准备怎样实现？', include: '可实施的结构、流程、接口和关键取舍；写明已采纳或待确认。', exclude: '仅有可行性假设归方法探索；多个选择尚未取舍归方案对比；已完成不等于已验证有效。' },
  method_exploration: { question: '哪种方法值得继续验证？', include: '具有项目依据但可行性或收益尚未证实的假设、思路和候选实现。', exclude: '不能写成已验证结论；单次实测事实归验证结果；完整实现安排归设计方案。' },
  verification: { question: '这次验证实际证明了什么？', include: '明确对象、方法下的观察结果及覆盖范围，保留未测部分。', exclude: '同一主题已形成足够依据支持的可复用判断时并入项目结论，不另生成一条；环境未就绪不算验证结果。' },
  issue: { question: '哪些项目问题或风险尚未解决？', include: '项目本身尚未关闭的问题、触发条件、影响与待验证风险。', exclude: '已确认原因且修复验证通过归排障经验；本机依赖、登录、权限、网络等故障一律排除。' },
  troubleshooting: { question: '项目缺陷为何发生、怎样有效解决？', include: '项目代码、设计或数据缺陷的确认根因及已验证修复，保留复现条件。', exclude: '仅有猜测或修复未验证归问题与风险；本机环境故障和修复流水账一律排除。' },
  guide: { question: '后续怎样重复执行这项项目操作？', include: '有依据的业务、交付操作步骤，保留必要前提和完成检查点。', exclude: '一次性执行日志不保留；本机安装、配置、联网和工具启动修复不保留；实施结构归设计方案。' },
  research: { question: '外部资料提供了什么重要事实？', include: '有可追溯资料来源的外部事实及适用范围，区分事实与推测。', exclude: '自己的实测归验证结果；多个选择的同维度比较归方案对比；已形成的决策性判断归项目结论。' },
  comparison: { question: '不同选择有什么关键差异？', include: '至少两个方案围绕同一目标的同维度差异、代价和适用条件。', exclude: '只有一个方案归设计方案或方法探索；已有明确判断则把必要对比依据并入项目结论。' },
  baseline_change_proposal: { question: '已有做法值得怎样改进？', include: '针对现有做法、带依据但尚未采纳的改进建议，写清预期作用和待验证项。', exclude: '已确认的规则归项目标准；明确的实现安排归设计方案；没有项目依据的通用建议不保留。' }
};

const categoriesSchema = z.array(materialCategorySchema).min(1, '至少启用一个类别').max(materialCategories.length).refine(values => new Set(values).size === values.length, '类别不能重复');
export const resultCombinationSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(30), categories: categoriesSchema });
export interface ResultCombination { id: string; name: string; categories: MaterialCategory[] }
export const resultPresets: ResultCombination[] = [
  { id: 'research', name: '算法研究', categories: ['finding', 'project_standard', 'method_exploration', 'verification', 'issue', 'baseline_change_proposal'] },
  { id: 'development', name: '软件开发', categories: ['requirement', 'project_standard', 'design', 'finding', 'verification', 'issue', 'troubleshooting', 'guide', 'baseline_change_proposal'] },
  { id: 'investigation', name: '调研分析', categories: ['research', 'comparison', 'finding', 'method_exploration', 'issue', 'baseline_change_proposal'] }
];
export const resultPreferencesSchema = z.object({ combinations: z.array(resultCombinationSchema).max(50), projects: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), z.string().max(80)) }).superRefine((value, context) => {
  const all = [...resultPresets, ...value.combinations], ids = new Set(all.map(item => item.id)), names = all.map(item => item.name.normalize('NFKC').toLocaleLowerCase());
  if (ids.size !== all.length || new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: '组合名称和标识不能重复' });
  if (Object.values(value.projects).some(id => !ids.has(id))) context.addIssue({ code: 'custom', message: '请先为使用该组合的项目选择其他组合，再删除组合' });
});
export type ResultPreferences = z.infer<typeof resultPreferencesSchema>;
export interface ResultRuleSnapshot { contract: 2 | 3; combinationId: string; name: string; categories: ContributionCategory[] }
export interface ResultRulesState { owner: string; version: string; preferences: ResultPreferences; combination: ResultCombination }
export function activeResultCombination(preferences: ResultPreferences, projectId: string): ResultCombination {
  return [...resultPresets, ...preferences.combinations].find(item => item.id === preferences.projects[projectId]) || resultPresets[0];
}
export function resultRulesPrompt(categories: readonly ContributionCategory[]) {
  const definitions = categories.map(category => {
    const boundary = resultCategoryBoundaries[category as MaterialCategory];
    return { category, name: contributionCategoryInfo[category].label, ...(boundary || { include: contributionCategoryInfo[category].description }) };
  });
  return `整理顺序：先过滤不应保留的信息，再按独立主题提炼和合并，最后为每个主题选择一个主类别。禁止按类别逐个生成，禁止同一主题换类别重复输出。总计最多 5 条，允许 0 条，不凑类别或数量；多个独立主题可以使用相同类别。\n类别边界：${JSON.stringify(definitions)}\n优先规则：先按主要用途区分需求、标准、设计、操作及问题处理，不因它们也可复用就一律归项目结论。针对证据类主题：能形成有充分证据的可复用判断时用 finding，并把必要验证/对比依据写入正文；否则实测事实用 verification、外部事实用 research、至少两个方案的对比用 comparison。未解决项目缺陷用 issue，根因和修复均确认后用 troubleshooting。requirement 描述做什么，project_standard 描述人确认的必须遵守事项，design 描述如何实现，method_exploration 描述待验证假设，baseline_change_proposal 描述尚未采纳的改进。只能从启用类别选择；没有合适类别且无法如实表达时省略，不夸大事实迁就分类。\n示例：单次测试中延迟降低 8% 属于 verification；足够证据支持某方法在明确条件下更适合本项目，属于 finding，相关测试事实作为依据放在同一条。只有静态检查通过的候选实现通常是 method_exploration，不能写成已验证有效。\n硬排除：本机依赖缺失或版本冲突、安装配置、路径权限、账号登录凭证、代理联网、工具启动、资源不足引起的故障及排查修复日志，不论看起来多重要，一律不输出为成果，也不塞入来源详情。只有环境故障时返回空成果。若这些故障限制了有价值的项目方法验证，只保留“尚未完成运行验证，不能确认精度或性能收益”等判断边界，不描述环境错误。区分这些故障与项目代码、设计、数据自身的真实缺陷。`;
}
