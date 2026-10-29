import React from 'react';

export function CodexRequestGuardSetting({ enabled, disabled, changed }: { enabled: boolean; disabled?: boolean; changed: (value: boolean) => void }) {
  return <section aria-label="Codex 请求大小保护"><div className="row"><strong>Codex 请求大小保护（1 MB）</strong><span className="spacer"/><button type="button" role="switch" className="project-ai-switch" aria-label="Codex 请求大小保护（1 MB）" aria-checked={enabled} disabled={disabled} onClick={() => changed(!enabled)}><span/></button></div>
    <p className="muted small">超限时先压缩传输，仍超限再摘要历史；无法安全缩小时停止发送。历史摘要会增加等待时间和模型用量，也可能遗漏信息。</p>
    <p className="muted small">保存后对新启动或重新连接的本机 Codex 生效，已连接会话保持原设置。共用后台的子会话沿用该后台设置。暂不覆盖 Codex 桌面同步、远程会话及其他 Agent。</p></section>;
}
