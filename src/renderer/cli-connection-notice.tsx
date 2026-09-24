import React from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { cliConnectionAdvice, cliConnectionLabel, type CliConnection } from '../shared/cli-connection';

export function CliConnectionNotice({ value }: { value?: CliConnection }) {
  if (!value || !['reconnecting', 'failed'].includes(value.state)) return null;
  const retrying = value.state === 'reconnecting';
  return <div className={'cli-connection-notice ' + (retrying ? 'retrying' : 'failed')} role={retrying ? 'status' : 'alert'}>
    {retrying ? <RefreshCw size={17}/> : <CircleAlert size={17}/>}
    <div><strong>{cliConnectionLabel(value)}</strong><span>{cliConnectionAdvice(value)}</span></div>
    <time>{new Date(value.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
  </div>;
}
