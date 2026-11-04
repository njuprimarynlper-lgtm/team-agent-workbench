import React from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { cliConnectionAdvice, cliConnectionLabel, type CliConnection } from '../shared/cli-connection';

export function CliConnectionNotice({ value, provider }: { value?: CliConnection; provider?: string }) {
  if (!value || !['reconnecting', 'failed'].includes(value.state)) return null;
  if (provider === 'codex' && (value.state === 'reconnecting' || value.kind === 'network')) {
    const stopped = value.state === 'failed';
    return <p className={'cli-reconnect-line' + (stopped ? ' failed' : '')} role={stopped ? 'alert' : 'status'}>{stopped ? '连接模型服务失败' : '正在重试连接模型服务…'}</p>;
  }
  const retrying = value.state === 'reconnecting';
  return <div className={'cli-connection-notice ' + (retrying ? 'retrying' : 'failed')} role={retrying ? 'status' : 'alert'}>
    {retrying ? <RefreshCw size={17}/> : <CircleAlert size={17}/>}
    <div><strong>{cliConnectionLabel(value)}</strong><span>{cliConnectionAdvice(value)}</span></div>
    <time>{new Date(value.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
  </div>;
}
