import type { AgentSession } from './types';

export const localResultApiMarker = '\n\n[工作台个人成果接口]\n';
const instructions = '\n需要查询或维护当前项目的个人成果时，先读取上述 Skill，使用其脚本调用本机接口。配置文件每次调用重新读取。无需操作界面；按用户任务范围执行，不自行分享至团队。';
export interface LocalResultPaths { configPath: string; skillPath: string; clientPath: string }
export const localResultApiNotice = (paths: LocalResultPaths) => localResultApiMarker + JSON.stringify(paths) + instructions;
export function withoutLocalResultApiNotice(session: AgentSession, text: string) {
  const index = text.lastIndexOf(localResultApiMarker);
  if (index < 0 || !text.endsWith(instructions)) return text;
  try {
    const paths = JSON.parse(text.slice(index + localResultApiMarker.length, -instructions.length));
    if (Object.keys(paths).sort().join(',') !== 'clientPath,configPath,skillPath' || Object.values(paths).some(value => typeof value !== 'string')) return text;
    const config = (paths.configPath as string).replace(/\\/g, '/');
    if (!config.endsWith('/sessions/' + session.id + '/results-api.json') && !config.endsWith('/local-result-api/temporary/' + session.id + '/results-api.json')) return text;
    if (!paths.skillPath.replace(/\\/g, '/').endsWith('/workbench-results/SKILL.md') || !paths.clientPath.replace(/\\/g, '/').endsWith('/workbench-results/scripts/client.mjs')) return text;
    return text.slice(0, index);
  } catch { return text; }
}
