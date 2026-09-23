import React, { useState } from 'react';
import { Check, Download, RotateCcw } from 'lucide-react';
import type { ConclusionOrganization, ContentUpdate } from '../shared/types';
import type { SharedContent } from '../shared/content';
import { conclusionTitle } from '../shared/conclusion-context';

export function ActivityResultActions({ event, item, disabled = false, changed, notice }: {
  event: ContentUpdate; item?: SharedContent; disabled?: boolean; changed: () => Promise<void>; notice: (text: string) => void;
}) {
  const [busy, setBusy] = useState<'save' | 'status'>(), [error, setError] = useState('');
  const run = async (action: 'save' | 'status') => {
    if (busy || disabled) return;
    setBusy(action); setError('');
    try {
      if (action === 'save' && item) {
        const result = await window.workbench.call<ConclusionOrganization>('conclusion.import', { projectId: event.projectId, contentId: item.id, expectedRevision: item.revision });
        const label = ({ created: '已存入本地成果库', updated: '已更新本地成果来源', duplicate: '这条成果已在本地成果库中' } as const)[result.action];
        notice(`${label}：“${conclusionTitle(result.conclusion)}”`);
      } else if (action === 'status') {
        await window.workbench.call('content.updates.read', { eventIds: [event.eventId], processed: !event.readAt });
      }
      await changed();
    } catch (reason: any) { setError(reason.message); } finally { setBusy(undefined); }
  };
  return <section className="activity-result-actions" aria-label="处理这条动态">
    <div className="activity-result-status"><span className={'badge ' + (event.readAt ? 'done' : 'running')}>{event.readAt ? '已处理' : '待处理'}</span><span>{event.readAt ? '可设回待处理，之前保存的成果仍会保留。' : '查看不会自动完成处理；存入本地库后会标记为已处理。'}</span></div>
    {item && item.revision !== event.revision && <p className="activity-revision-note">这条动态记录第 {event.revision} 版，当前展示第 {item.revision} 版；存入本地库的是当前展示的内容。</p>}
    <div className="row">
      {item && <button className="primary" disabled={disabled || !!busy} onClick={() => void run('save')}><Download size={15}/>{busy === 'save' ? '正在存入…' : '存入本地成果库'}</button>}
      <button className="secondary" disabled={disabled || !!busy} onClick={() => void run('status')}>{event.readAt ? <RotateCcw size={15}/> : <Check size={15}/>} {busy === 'status' ? '正在更新…' : event.readAt ? '设为待处理' : '标记已处理'}</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
