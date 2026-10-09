import React from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { cliConnectionAdvice, cliConnectionLabel, type CliConnection } from '../shared/cli-connection';

export function CliConnectionNotice({ value, provider }: { value?: CliConnection; provider?: string }) {
  if (!value || !['reconnecting', 'failed'].includes(value.state)) return null;
  if (provider === 'codex' && (value.state === 'reconnecting' || value.kind === 'network')) {
    const limit = value.retryLimit || 5, stopped = value.state === 'failed', attempt = value.attempt ? Math.min(value.attempt, limit) : stopped ? 0 : 1;
    return <p className={'cli-reconnect-line' + (stopped ? ' failed' : '')} role={stopped ? 'alert' : 'status'}>{stopped ? `重连失败${attempt ? ` ${attempt}/${limit}` : ''}` : `重连 ${attempt}/${limit}`}</p>;
  }
  const retrying = value.state === 'reconnecting';
  return <div className={'cli-connection-notice ' + (retrying ? 'retrying' : 'failed')} role={retrying ? 'status' : 'alert'}>
    {retrying ? <RefreshCw size={17}/> : <CircleAlert size={17}/>}
    <div><strong>{cliConnectionLabel(value)}</strong><span>{cliConnectionAdvice(value)}</span></div>
    <time>{new Date(value.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
  </div>;
}
