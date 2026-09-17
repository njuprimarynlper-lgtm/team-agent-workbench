import { z } from 'zod';
import type { ConnectionProfile } from './types';

const required = (label: string) => z.string().trim().min(1, '请填写' + label).max(6000, label + '请控制在 6000 字以内');
const optional = z.string().trim().max(6000, '每项请控制在 6000 字以内').default('');
export const projectBriefSchema = z.object({
  background: required('项目背景'), objectives: required('项目目标'), acceptance: required('验收标准'),
  scope: optional, deliverables: optional, resources: optional, constraints: optional, collaboration: optional,
});
export type ProjectBrief = z.infer<typeof projectBriefSchema>;
export const PROJECT_BRIEF_FILE = '项目说明.md';
export function projectSetupIdentity(profile: ConnectionProfile, groupName: string) {
  return JSON.stringify([profile.mode || 'sftp', profile.host, profile.port, profile.localRoot || '', profile.username, profile.fingerprint, groupName]);
}
export const briefFields: { key: keyof ProjectBrief; label: string; required?: boolean; placeholder: string }[] = [
  { key: 'background', label: '项目背景', required: true, placeholder: '为什么要做？当前遇到什么问题，面向哪些用户或业务场景？' },
  { key: 'objectives', label: '项目目标', required: true, placeholder: '希望达成哪些结果？建议按优先级列出，可包含当前阶段目标。' },
  { key: 'acceptance', label: '验收标准', required: true, placeholder: '怎样判断完成且质量达标？填写指标、验证方式和验收人；尚未确定的部分可注明待确认。' },
  { key: 'scope', label: '范围与非目标', placeholder: '本阶段包含哪些工作？暂时不做什么？' },
  { key: 'deliverables', label: '交付物与里程碑', placeholder: '需要交付代码、报告、文档或其他成果？关键时间节点是什么？' },
  { key: 'resources', label: '现有资料与入口', placeholder: '仓库链接、文档、样例、数据或环境说明。没有仓库也可以。' },
  { key: 'constraints', label: '约束与风险', placeholder: '技术、环境、时间、数据使用和安全边界，有哪些需要先确认的问题？不要填写密码或密钥。' },
  { key: 'collaboration', label: '协作约定', placeholder: '成员分工、成果提交方式、评审人、沟通节奏和关键决策记录方式。' },
];
export function projectBriefMarkdown(name: string, brief: ProjectBrief, author: string, createdAt: string) {
  return `# ${name} · 项目说明\n\n由 ${author} 创建于 ${createdAt}。\n\n` + briefFields.map(field => `## ${field.label}\n\n${brief[field.key] || '待补充。'}\n`).join('\n');
}
