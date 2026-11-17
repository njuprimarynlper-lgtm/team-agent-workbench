import { createHash } from 'node:crypto';
import { userFailure, type FailureContext, type UserFailure } from '../shared/user-failure';
import { errorMessage } from '../shared/errors';
import { accountLogScope, type LogService } from '../core/logging';
import type { LogScope } from '../shared/logs';
import { transferFailureMessage } from '../shared/transfer-failure';

const operationNames: Record<string, string> = { remote: '连接中央节点', project: '处理项目设置', session: '处理会话', content: '读取或更新团队成果', conclusion: '处理个人成果', question: '处理求助', assignment: '处理项目任务', egress: '处理管理端出口', logs: '读取日志', rsi: '处理 AI 推荐', group: '管理项目', member: '管理成员', connect: '连接中央节点', operation: '执行服务器管理操作', settings: '保存设置', scheduledTask: '处理定时任务' };
const exactOperationNames: Record<string, string> = {
  'provider.auth':'检测个人 AI 账号', 'provider.login':'登录个人 AI 账号', 'providers.detect':'检测本机 CLI', 'catalog':'读取模型与额度',
  'session.create':'创建会话', 'session.send':'发送消息', 'session.answer':'提交批准或回答', 'session.model':'切换会话模型', 'session.reasoningEffort':'设置思考强度',
  'session.permissions':'读取执行权限', 'session.permissionMode':'修改执行权限', 'session.capabilities':'读取会话工具', 'session.mcp':'读取 MCP 服务', 'session.rename':'保存会话名称', 'session.network':'保存会话连接方式',
  'project.directory.save':'保存项目代码目录', 'project.directory.impact':'读取会话目录切换状态', 'project.brief':'读取项目说明',
  'content.list':'读取团队成果', 'content.history':'读取团队历史', 'content.preview':'预览团队文件', 'conclusion.list':'读取个人成果',
  'assignment.list':'读取项目任务', 'question.sync':'同步求助记录', 'draft.deleteMany':'删除整理记录', 'draft.retry':'重新整理成果', 'settings.agent.save':'保存 Agent 设置',
  'provider.catalog':'读取模型和额度', 'provider.permissions':'检查执行权限',
  'session.record.save':'保存本机会话记录', 'session.status':'读取会话状态', 'session.mode':'切换对话模式', 'session.modes':'读取可用对话模式',
  'session.tools.configuration':'打开工具配置', 'session.skills.configure':'保存 Skill 设置', 'session.mcp.login':'登录 MCP 服务',
  'session.mcp.add':'添加 MCP 服务', 'session.mcp.update':'修改 MCP 服务', 'session.mcp.remove':'删除 MCP 服务', 'session.mcp.toggle':'切换 MCP 服务开关',
  'session.plan.execute':'执行计划', 'session.plan.revise':'修改计划', 'session.plan.confirmRetry':'确认计划未执行', 'session.connection.restore':'恢复会话连接',
  'session.native.list':'读取可导入会话', 'session.native.link':'导入会话', 'session.native.linkMany':'批量导入会话', 'session.native.refresh':'同步原生会话消息',
  'session.codexDesktop.open':'在 Codex 中打开会话', 'session.codexDesktop.sync':'开启 Codex 桌面同步', 'session.desktopSync.restore':'恢复桌面同步',
  'assignment.create':'派发任务', 'assignment.update':'修改任务', 'assignment.members':'读取任务负责人', 'assignment.file.download':'下载任务附件',
  'content.edit':'保存团队成果', 'content.download':'下载团队文件', 'content.delete':'删除团队成果',
  'conclusion.save':'保存个人成果', 'conclusion.delete':'删除个人成果', 'conclusion.upload':'上传个人成果',
  'draft.prepare':'整理成果', 'draft.delete':'删除整理记录', 'draft.save':'保存整理成果', 'draft.upload':'上传整理成果',
  'project.brief.save':'保存项目说明', 'project.create':'创建项目', 'group.details':'读取项目成员', 'group.refresh':'刷新项目列表',
  'settings.save':'保存设置', 'snapshot':'加载工作台', 'logs.query':'读取故障记录', 'logs.get':'打开故障详情', 'logs.export':'导出日志', 'logs.cleanup':'清理日志',
  'transfer.retrySave':'保存本机传输记录',
  'open.data':'打开本机数据文件夹',
};
function operationLabel(action: string) {
  if (exactOperationNames[action]) return exactOperationNames[action];
  const parts = action.split('.'), kind = parts[0], verb = parts.at(-1) || '';
  const topics: Record<string, string> = { session: '会话', sidechat: '侧边提问', subsession: '子会话', project: '项目', content: '团队成果', conclusion: '个人成果', draft: '整理记录', question: '求助', assignment: '任务', result: '成果目录', account: '账号资料', rsi: 'AI 推荐', scheduledTask: '定时任务', directions: '项目方向', journal: '会话日志', group: '项目成员', member: '成员账号', settings: '设置', transfer: '传输记录', logs: '日志', workspace: '工作台', provider: '模型账号', providers: '本机 AI 程序', choose: '本机文件' };
  let topic = topics[kind];
  if (kind === 'session' && ['file','files'].includes(parts[1])) topic = '会话文件';
  if (kind === 'session' && parts[1] === 'input') topic = '输入草稿';
  if (kind === 'session' && parts[1] === 'queue') topic = '待发送消息';
  if (topic) {
    const verbs: Record<string, string> = { list: '读取', read: '读取', query: '查询', preview: '预览', status: '读取', view: '读取', history: '读取', historyPage: '读取', transcriptPage: '读取', summary: '读取', match: '查找', candidates: '读取', save: '保存', write: '保存', update: '更新', create: '创建', add: '添加', delete: '删除', deleteMany: '删除', remove: '移除', close: '关闭', reopen: '重新打开', rename: '重命名', publish: '发布', attach: '关联', detach: '取消关联', download: '下载', upload: '上传', sync: '同步', refresh: '刷新', recover: '恢复', stop: '停止', retry: '重试', configure: '配置', import: '导入', export: '导出' };
    return (verbs[verb] || '更新') + topic;
  }
  return operationNames[kind] || '这次操作';
}
export function failureContext(action: string, provider?: string): FailureContext {
  const key = action.replace(/^personal:/, '').split('.')[0];
  return { operation: operationLabel(action.replace(/^personal:/, '')), provider,
    domain: ['remote', 'group', 'member', 'connect', 'operation', 'content', 'assignment', 'question'].includes(key) ? 'central' : key === 'egress' ? 'relay' : key === 'logs' ? 'logs' : key === 'session' ? 'cli' : 'local', phase: action };
}
export function publicFailure(error: unknown, action: string, logRef?: UserFailure['logRef'], provider?: string) {
  // Preserve Zod's reviewed field labels before creating the public payload.
  const input = (error as any)?.name === 'ZodError' ? Error(errorMessage(error)) : error;
  return userFailure(input, { ...failureContext(action, provider), logRef });
}

const failureFields = new Set(['error', 'lastError', 'connectionError', 'generationError', 'modelError', 'skillError', 'pluginError', 'accessError', 'blockedError', 'desktopSyncError', 'syncError', 'cleanupError']);
const opaqueFields = new Set(['messages', 'content', 'body', 'description', 'nativeDetails', 'stdout', 'stderr', 'raw', 'payload', 'text']);
/** Sanitize only application error fields at the display boundary. Never rewrite saved records or model output. */
export function publicErrorState<T>(input: T, action: string, logger?: LogService, scopeRoot?: string, scope: LogScope = {}): T {
  const visit = (value: any, path: string, depth: number): any => {
    if (!value || typeof value !== 'object' || depth > 12 || value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map((item, index) => visit(item, path + '.' + index, depth + 1));
    const output: any = { ...value };
    if (value.type === 'notice' && typeof value.message === 'string' && !/^(?:收到求助(?:答复)?|收到提问(?:答复)?|收到问题(?:答复)?|求助已关闭|问题已关闭|待授权|自动对话建议结束|求助有后续|定时任务(?:完成|结束))：/.test(value.message) && (value.failure?.version === 1 || /^(?:定时任务后台|会话记录保存失败)：/.test(value.message) || /失败|未能|未保存|未完成|未加入|未恢复|未上传|未更新|未清理|暂不可用|出现问题|异常|\bE[A-Z]{2,}\b|Error:|\[WB_NET|Traceback/.test(value.message))) {
      const operationId = createHash('sha256').update(`${logger?.instance || ''}:${scopeRoot}:${value.message}`).digest('hex').slice(0,32);
      const ref = logger?.record('diagnostic', 'ui.notice_failure', accountLogScope(scopeRoot || logger.root, { ...scope, operationId }), { level: 'error', detail: value.message });
      const failure = publicFailure(value.failure?.version === 1 ? { message: value.message, failure: value.failure } : value.message, /定时任务/.test(value.message) ? 'scheduledTask.status' : action);
      if (!failure.logRef?.id && !failure.logRef?.operationId && ref) failure.logRef = ref;
      const partial = /^(会话已迁移，提问关联将在后台继续清理|引导已送达，但本地记录保存失败|“[^”]+”已关闭。停止后台进程时出现问题|整理记录已删除，临时文件暂未清理)：([\s\S]*)$/.exec(value.message);
      if (partial) {
        failure.message = partial[1].startsWith('引导已送达') ? '补充消息已发给 AI，但本机聊天记录还没保存。先查看这轮回复，不要重发；请保留工作台窗口，把日志交给维护人员。'
          : partial[1].startsWith('会话已迁移') ? '会话已迁移，原来的求助关联还没清理完。你可以继续这条会话；请把日志交给维护人员处理旧关联。'
            : partial[1].startsWith('整理记录已删除') ? '整理记录已删除，临时文件还没清理完。无需再次删除记录；请把日志交给维护人员清理剩余文件。'
              : partial[1].replace(/。停止后台进程时出现问题$/, '') + '，但还没确认 AI 后台是否已停止。请把日志交给维护人员检查。';
        failure.outcome = 'partial';
      }
      if (/^定时任务后台：/.test(value.message)) failure.message = '定时任务的本轮检查没完成。请点左侧“定时任务”查看运行记录，确认哪些任务已经运行；需要帮助时，把日志交给维护人员。';
      if (/^会话记录保存失败：/.test(value.message)) failure.message = '这台电脑上的会话记录没能保存。请保留工作台窗口，把日志交给维护人员处理。';
      const knownNotices: [RegExp,string][] = [
        [/^定时任务执行记录未保存：/, '定时任务的运行记录没保存好。请点左侧“定时任务”检查已有结果，先别重复运行；需要帮助时，把日志交给维护人员。'],
        [/^项目资料引用未加入：/, '这条会话没能加入项目资料，AI 可能缺少项目背景。请点“查看日志”，让维护人员检查；继续对话时请自行补充所需背景。'],
        [/^个人成果接口暂不可用：/, 'AI 暂时无法直接读写个人成果。对话可以继续；你可以先点左侧“个人成果库”查看已有内容，修复此能力请把日志交给维护人员。'],
        [/^AI 推荐参考暂未恢复：/, 'AI 推荐的参考资料没恢复出来，对话可以继续。需要引用这些资料时，请先在右侧“AI推荐”查看原建议；需要帮助时查看日志。'],
        [/^会话自动上传未完成：/, '这条会话的轨迹自动上传遇到问题，结果还没确认。请点左侧“更多”→“传输记录”核对原上传，先不要再上传一份；需要帮助时查看日志。'],
        [/^会话文件未上传：/, '会话文件没能加入上传队列。请点左侧“更多”→“传输记录”查看哪些文件已排队；没有这份文件时再重新选择上传。'],
        [/^项目说明未更新：/, '当前会话没能更新项目说明，可能仍在使用旧版。请先查看日志，让维护人员处理；依赖新版要求前，请核对项目说明的内容。'],
        [/^同步请求暂未完成：/, '与 Codex 桌面版的同步还没接通，本机对话仍保留。请点输入框上方的同步标签查看状态；需要帮助时查看日志。'],
      ];
      const known = knownNotices.find(([pattern]) => pattern.test(value.message));
      if (known) failure.message = known[1];
      if (value.failure?.code === 'LOCAL_BACKGROUND_RECORD_SAVE_FAILED') {
        // The current sender provides a persistent status and a real retry
        // button; older string-only events retain the maintenance fallback.
        const current = publicFailure({ failure: value.failure }, action);
        failure.message = current.message;
        failure.outcome = current.outcome;
      }
      output.message = failure.message; output.failure = failure;
    }
    for (const [key, field] of Object.entries(value)) {
      if (key === 'message' && value.type === 'notice' && output.failure) continue;
      if (failureFields.has(key) && typeof field === 'string' && field) {
        const operationId = createHash('sha256').update(`${logger?.instance || ''}:${scopeRoot || ''}:${scope.centralId || ''}:${path}:${key}:${field}`).digest('hex').slice(0, 32);
        const errorAction = /connection|workspace|access|remote/i.test(path + '.' + key) ? 'remote.status' : /transfer/i.test(path) ? 'content.transfer' : value.provider ? 'session.status' : action;
        const savedFailure = value[key === 'error' ? 'failure' : key + 'Failure'];
        const failure = publicFailure(savedFailure?.version === 1 ? { message: field, failure: savedFailure } : field, errorAction, undefined, value.provider);
        const ref = logger?.record('diagnostic', 'ui.background_failure', accountLogScope(scopeRoot || logger.root, { ...scope, operationId, sessionId: typeof value.id === 'string' && value.provider ? value.id : scope.sessionId, provider: value.provider }), { level: 'error', code: failure.code, detail: field }) || (logger ? { operationId } : undefined);
        if (ref && !failure.logRef?.id && !failure.logRef?.operationId) failure.logRef = ref;
        if (value.kind && ['upload', 'history', 'download'].includes(value.kind) && value.phase) {
          if (['awaiting_receipt','streaming','verifying','rejected','queued','completed'].includes(value.phase)) { failure.message = transferFailureMessage(value, field); failure.phase = value.phase; failure.outcome = value.phase === 'completed' ? 'accepted' : value.phase === 'awaiting_receipt' ? 'unknown' : value.phase === 'queued' ? 'not-started' : 'partial'; }
        }
        output[key] = failure.message;
        output[key === 'error' ? 'failure' : key + 'Failure'] = failure;
      } else if (!opaqueFields.has(key) && key !== 'failure' && !key.endsWith('Failure')) output[key] = visit(field, path + '.' + key, depth + 1);
    }
    return output;
  };
  return visit(input, '', 0);
}
