import { ErrorLogLink } from './error-notice';
import React from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { cliConnectionAdvice, cliConnectionLabel, type CliConnection } from '../shared/cli-connection';

export function CliConnectionNotice({ value, provider, configure }: { value?: CliConnection; provider?: string; configure?: () => void }) {
  if (!value || !['reconnecting', 'failed'].includes(value.state)) return null;
  const retrying = value.state === 'reconnecting';
  return <div className={'cli-connection-notice ' + (retrying ? 'retrying' : 'failed')} role={retrying ? 'status' : 'alert'}>
    {retrying ? <RefreshCw size={17}/> : <CircleAlert size={17}/>}
    <div><strong>{cliConnectionLabel(value).replace('CLI', provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : provider === 'claude' ? 'Claude Code' : '模型连接')}</strong><span>{cliConnectionAdvice(value)} {configure && <button className="secondary compact" onClick={configure}>打开网络与登录</button>} <ErrorLogLink/></span></div>
    <time>{new Date(value.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
  </div>;
}
