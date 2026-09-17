import type { AgentSession, PermissionMode, PermissionReport, Provider } from './types';

export const permissionLabels: Record<Provider, Record<PermissionMode, string>> = {
  codex: { inherit: '沿用 Codex 设置', review: '请求批准', auto: '帮我批准', full: '完全访问' },
  cursor: { inherit: '沿用 Cursor 设置', review: 'Allowlist（白名单）', auto: 'Auto-review（自动审查）', full: 'Run Everything（全部运行）' },
};
export const permissionEffects: Record<Provider, Record<PermissionMode, string>> = {
  codex: {
    inherit: '沿用已有设置，部分操作可能需要你批准。',
    review: '可在工作目录内修改文件和运行命令，超出范围时向你请求批准。',
    auto: '可在工作目录内执行任务，由 Codex 自动审查符合条件的批准请求，部分操作仍可能需要你确认。',
    full: '可访问本机账号允许的文件和网络，通常不再请求批准。',
  },
  cursor: {
    inherit: '沿用已有设置，部分操作可能需要你批准。',
    review: '已允许的操作可直接执行，其他操作可能需要你批准。',
    auto: '自动审查工具操作，部分操作仍可能需要你确认。',
    full: '自动执行工具操作，明确禁止的操作仍可能无法执行。',
  },
};

// Filesystem scope and approval routing are independent. Only call a Codex
// configuration a native preset when both parts match that preset.
function codexApprovalMode(report: PermissionReport): PermissionMode | undefined {
  return report.approval === 'on-request' ? report.reviewer === 'user' ? 'review' : ['auto_review', 'guardian_subagent'].includes(report.reviewer || '') ? 'auto' : undefined : undefined;
}
function reportMode(report: PermissionReport): PermissionMode | undefined {
  if (report.provider === 'cursor') return report.approval === 'allowlist' ? 'review' : report.approval === 'auto-review' ? 'auto' : report.approval === 'unrestricted' ? 'full' : undefined;
  if (['danger-full-access', 'dangerFullAccess'].includes(report.sandbox) && report.approval === 'never') return 'full';
  if (['workspace-write', 'workspaceWrite'].includes(report.sandbox)) return codexApprovalMode(report);
}
function reportLabel(report: PermissionReport) {
  const mode = reportMode(report), approvalMode = report.provider === 'codex' && codexApprovalMode(report);
  return mode ? permissionLabels[report.provider][mode] : approvalMode ? `自定义设置（${permissionLabels.codex[approvalMode]}）` : '自定义设置';
}
export function permissionReportDescription(report: PermissionReport) {
  const { provider, sandbox, approval } = report;
  const readOnly = ['read-only', 'readOnly'].includes(sandbox);
  const lead = report.source === 'runtime' ? '当前' : '已保存设置';
  const mode = reportMode(report); let detail = '';
  if (provider === 'codex') {
    const approvalMode = codexApprovalMode(report);
    if (!mode) {
      detail = `${lead}：${reportLabel(report)}。`;
      if (approval === 'never') detail += '不会请求批准，受限操作可能无法完成。';
      else if (approvalMode === 'auto') detail += '符合条件的批准请求由 Codex 自动审查。';
      else if (approvalMode === 'review' || approval === 'untrusted') detail += '部分操作需要你批准。';
      else detail += '暂时无法确认完整权限，部分操作可能受限。';
      if (readOnly) detail += approval === 'never' ? '目前仅允许读取，无法修改文件或运行写入命令。' : '目前仅允许读取，修改文件或运行写入命令需要额外授权。';
    }
  } else {
    if (!mode) detail = `${lead}：自定义设置。暂时无法确认完整权限，部分操作可能受限。`;
  }
  if (mode) detail = `${lead}：${permissionLabels[provider][mode]}。${permissionEffects[provider][mode]}`;
  if (report.execution === 'blocked') detail += '当前环境无法执行部分命令，相关任务可能无法完成。';
  return detail;
}

export function sessionPermissionDescription(session: Pick<AgentSession, 'provider' | 'permissionMode' | 'permissions'>) {
  const { provider, permissions: report } = session, mode = session.permissionMode || 'inherit';
  if (report?.source === 'runtime' || (mode === 'inherit' && report)) return permissionReportDescription(report);
  if (mode === 'inherit') return `当前：${permissionLabels[provider].inherit}。${permissionEffects[provider].inherit}`;
  return `已选择：${permissionLabels[provider][mode]}。${permissionEffects[provider][mode]}`;
}

/** The compact control uses the same effective preset as the detailed explanation. */
export function sessionPermissionLabel(session: Pick<AgentSession, 'provider' | 'permissionMode' | 'permissions'>) {
  const mode = session.permissionMode || 'inherit', report = session.permissions;
  return report && (report.source === 'runtime' || mode === 'inherit') ? reportLabel(report) : permissionLabels[session.provider][mode];
}
