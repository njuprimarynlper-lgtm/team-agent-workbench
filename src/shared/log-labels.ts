import type { LogSummary } from './logs';

const operations: Record<string, string> = {
  'remote.connect': '登录中央节点', connect: '登录中央节点', 'provider.auth': '检测模型账号', 'provider.catalog': '读取模型和额度',
  'session.send': '发送消息', 'session.answer': '提交回答或批准', 'session.model': '切换模型', 'session.permissions': '修改执行权限',
  'settings.agent.save': '保存程序设置', 'settings.save': '保存设置', 'project.directory.save': '保存代码目录',
  'content.list': '读取团队成果', 'content.edit': '保存团队成果', 'content.download': '下载团队文件',
  'project.sync.content': '读取项目共享成果', 'project.sync.questions': '读取项目提问',
  'project.sync.records': '保存项目同步记录',
  'remote.download': '下载文件', 'content.attachment.download': '下载附件',
  'assignment.create': '派发任务', 'assignment.list': '读取任务列表', 'question.sync': '更新求助记录',
  'draft.retry': '重新整理成果', 'draft.prepare': '整理成果', 'draft.deleteMany': '删除整理记录',
  'app.start_failed': '启动工作台', 'renderer.load_failed': '打开工作台窗口',
};
const codes: Record<string, string> = {
  CENTRAL_CONNECTION_REFUSED: '中央节点连接失败', CENTRAL_AUTH_REJECTED: '中央节点登录失败',
  MODEL_AUTH_REJECTED: '模型账号验证失败', MODEL_ACCESS_REJECTED: '模型服务拒绝请求', MODEL_REQUEST_LIMITED: '模型请求受限',
  STORAGE_FULL: '保存空间不足', FILE_MISSING: '找不到文件', FILE_ACCESS_DENIED: '无法访问文件',
  LOCAL_RECORD_SAVE_FAILED_AFTER_SUBMISSION: '消息已发送，聊天记录未保存',
  CLI_CONNECTION_CLOSED: '本机 AI 程序连接断开', OPERATION_TIMEOUT: '请求等待超时',
};
export function logTitle(row: Pick<LogSummary, 'name' | 'code' | 'provider' | 'level'>): string {
  if (row.name === 'session.record.background_save_failed' || row.code === 'LOCAL_BACKGROUND_RECORD_SAVE_FAILED') return '本机会话记录保存失败';
  if (row.name === 'preparation.interrupted' || row.code === 'PREPARATION_CONNECTION_INTERRUPTED') return '成果整理中断';
  if (row.name === 'account.sync.cache_unreadable' || row.code === 'ACCOUNT_SYNC_CACHE_UNREADABLE') return '账号自动同步未能启动';
  const operation = operations[row.name.replace(/^personal:/, '')];
  if (operation) return operation + (row.level === 'warning' ? '需要处理' : '失败');
  if (row.name.startsWith('transfer.')) return '文件传输失败';
  if (row.name.startsWith('preparation.')) return '成果整理出现问题';
  if (row.name.startsWith('account.sync')) return '账号资料同步出现问题';
  if (row.name.startsWith('rsi.') || row.name.startsWith('activity.assistant')) return 'AI 推荐出现问题';
  if (row.code && codes[row.code]) return codes[row.code];
  if (/[\u4e00-\u9fff]/.test(row.name) && row.name.length < 60 && !/[\r\n]/.test(row.name)) return row.name;
  return row.provider ? `${({ codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code' } as Record<string, string>)[row.provider] || 'AI'} 出现问题` : '工作台出现问题';
}
