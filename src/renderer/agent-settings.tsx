import { contextualError } from './contextual-error';
import { ErrorLogLink } from './error-notice';
import { uiErrorMessage } from '../shared/user-failure';
import React, { useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import type { AgentSession, Provider, Settings, Snapshot, WorkbenchAPI } from '../shared/types';
import { CodexRequestGuardSetting } from './codex-request-guard';
import { ProviderAuthPanel } from './provider-auth';

const providerIds = ['codex', 'cursor', 'claude'] as const;
const labels = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code' };
export function AgentSettings({ settings, providers, auth, toolSessions, openTools, api }: {
  settings: Settings; providers: Snapshot['providers']; auth: Snapshot['auth']; toolSessions: AgentSession[];
  openTools: (provider: Provider) => void; api: WorkbenchAPI;
}) {
  const [guardEnabled, setGuardEnabled] = useState(settings.codexRequestGuard ?? true);
  const [guardSaving, setGuardSaving] = useState(false), [guardMessage, setGuardMessage] = useState(''), [guardError, setGuardError] = useState('');
  const guardLock = useRef(false);
  const [certificateFile, setCertificateFile] = useState(settings.codexCaCertificate || '');
  const [paths, setPaths] = useState(settings.providerPaths), [saving, setSaving] = useState(false), [detecting, setDetecting] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  useEffect(() => { if (!guardLock.current) setGuardEnabled(settings.codexRequestGuard ?? true); }, [settings.codexRequestGuard]);
  const toggleGuard = async (enabled: boolean) => {
    if (guardLock.current) return;
    const previous = guardEnabled; guardLock.current = true;
    setGuardEnabled(enabled); setGuardSaving(true); setGuardError(''); setGuardMessage('');
    try {
      await api.call('settings.agent.save', { codexRequestGuard: enabled });
      setGuardMessage(`已保存：请求大小保护已${enabled ? '开启' : '关闭'}。`);
    } catch (reason: any) { setGuardEnabled(previous); setGuardError(uiErrorMessage(reason, { domain: 'local', operation: '保存请求保护开关', outcome: 'not-started' })); }
    finally { guardLock.current = false; setGuardSaving(false); }
  };
  const save = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      await api.call('settings.agent.save', { providerPaths: paths, codexCaCertificate: certificateFile });
      setMessage('设置已保存。');
    } catch (reason: any) { setError(contextualError(reason, { domain: 'local', operation: '保存 Agent 设置', outcome: 'not-started' }, { FILE_ACCESS_DENIED: '设置没有保存：Windows 不允许写入本机设置文件。输入的路径还在。点本页“本机数据”旁的“打开目录”，请管理员检查该目录的写入权限后，再点“保存设置”。', UNCLASSIFIED_FAILURE: '这次没能保存 Agent 设置，输入的路径还在。点“保存设置”再试。' })); }
    finally { setSaving(false); }
  };
  const detect = async () => {
    setDetecting(true); setError('');
    try { await api.call('providers.detect'); }
    catch (reason: any) { setError(uiErrorMessage(reason, { domain: 'cli', operation: '检测本机 CLI' })); }
    finally { setDetecting(false); }
  };
  const unsavedPaths = providerIds.some(provider => paths[provider] !== settings.providerPaths[provider]);
  return <><div className="modal-body">
    <label className="field">Codex 跟进处理方式<select aria-label="Codex 跟进处理方式" value={settings.followUpMode || 'queue'} onChange={e => void api.call('settings.agent.save', { followUpMode: e.target.value }).catch(reason => setError(uiErrorMessage(reason, { domain: 'local' })))}><option value="queue">排队到下一轮</option><option value="steer">引导当前任务</option></select><span className="muted small">运行时按 Ctrl+Enter（Mac 为 ⌘+Enter）临时切换一次。</span></label>
    <CodexRequestGuardSetting enabled={guardEnabled} disabled={guardSaving} changed={enabled => void toggleGuard(enabled)} certificateFile={certificateFile} certificateChanged={value => { setCertificateFile(value); setMessage(''); }} chooseCertificate={() => api.call<string>('choose.certificate')} testConnection={networkRoute => api.call('guard.connection.test', { certificateFile, cwd: settings.localWorkspace, networkRoute, providerPath: paths.codex })}/>
    {guardSaving && <p className="muted small" role="status">正在保存开关…</p>}
    {guardMessage && <p className="muted small" role="status">{guardMessage}</p>}
    {guardError && <p className="inline-error" role="alert">{guardError} <ErrorLogLink message={guardError}/></p>}
    {providerIds.map(provider => {
      const info = providers.find(value => value.provider === provider);
      return <div className="provider-setting" key={provider}>
        <div className="row"><span className={'provider-icon ' + provider}>{provider === 'codex' ? 'G' : provider === 'cursor' ? 'C' : 'A'}</span><strong>{labels[provider]}</strong><span className="spacer"/><span className={'badge ' + (info?.available ? 'done' : 'error')}>{info?.available ? '已检测到 CLI' : '未找到程序'}</span></div>
        <label className="field">程序位置<div className="row"><input aria-label={labels[provider] + ' CLI 程序路径'} placeholder="留空自动检测" value={paths[provider]} onChange={event => { setPaths({ ...paths, [provider]: event.target.value }); setMessage(''); }}/><button type="button" className="secondary" onClick={async () => { try { const file = await api.call<string>('choose.executable'); if (file) { setPaths(current => ({ ...current, [provider]: file })); setMessage(''); } } catch (reason: any) { setError(uiErrorMessage(reason, { domain: 'local' })); } }}>选择</button></div></label>
        <p className="muted small break">{info?.available ? info.path + '\n' + info.version : info?.detail ? uiErrorMessage(info.detail, { domain: 'cli', operation: '检测本机 CLI', provider }) : '还没检测本机程序'}</p>
        {provider !== 'claude' && <button type="button" className="secondary compact" disabled={!toolSessions.some(session => session.provider === provider)} title={toolSessions.some(session => session.provider === provider) ? '' : '先创建一个此类型的工作会话'} onClick={() => openTools(provider)}>{provider === 'codex' ? 'Codex 设置' : 'Cursor 自定义'}</button>}
        {!info?.available && <p className="muted small">还没找到本机程序，暂时不能检查登录。点“检测程序”，或在上方选择已安装的程序；以前的登录信息会保留。</p>}
        <ProviderAuthPanel provider={provider} auth={auth[provider]} cwd={settings.localWorkspace} autoCheck={false} stale={!info?.available || paths[provider] !== settings.providerPaths[provider]} beforeAction={async () => {
          if (paths[provider] !== settings.providerPaths[provider]) await api.call('settings.agent.save', { providerPaths: { [provider]: paths[provider] } });
        }}/>
        <div className="row"><button type="button" className="text-button" onClick={() => void api.call('open.link', provider === 'codex' ? 'https://developers.openai.com/codex/cli' : provider === 'claude' ? 'https://code.claude.com/docs/en/quickstart' : 'https://cursor.com/docs/cli/installation').catch(reason => setError(uiErrorMessage(reason, { domain: 'local', operation: '打开官方安装说明' })))}>官方安装说明</button></div>
      </div>;
    })}
    <div className="callout"><HardDrive size={18}/><div>本机数据</div><button type="button" className="secondary compact" onClick={() => void api.call('open.data').catch(reason => setError(uiErrorMessage(reason, { domain: 'local', operation: '打开本机数据目录' })))}>打开目录</button></div>
  </div>{message && <p className="muted small" role="status" style={{ margin: '0 26px 12px' }}>{message}</p>}{error && <p className="inline-error" role="alert" style={{ margin: '0 26px 12px' }}>{error} <ErrorLogLink message={error}/></p>}<footer><button type="button" className="secondary" disabled={detecting || saving || unsavedPaths} title={unsavedPaths ? '请先保存 CLI 路径' : '检测已保存的 CLI 路径'} onClick={() => void detect()}>{detecting ? '正在检测程序…' : '检测程序'}</button><button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button></footer></>;
}
