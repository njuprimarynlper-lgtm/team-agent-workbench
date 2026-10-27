import { usePopupDismiss } from './popup-dismiss';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, FileText, X } from 'lucide-react';
import type { AgentSession, FilePreview, SourceFile, WorkbenchAPI } from '../shared/types';
import { resultLabelTitle } from '../shared/result-labels';
import { composerReferenceLayout, pendingComposerReferences, toggleComposerReference } from './composer-references';
import { Markdown } from './markdown';

export interface ComposerReferenceControls {
  sourceIds: string[];
  select: (ids: string[]) => void;
  detach: (source: SourceFile) => Promise<void>;
  detaching?: boolean;
}

export function ComposerReferenceTabs({ session, api, controls, locked, removalLocked, syncOpen, onOpen }: {
  session: AgentSession; api: WorkbenchAPI; controls: ComposerReferenceControls;
  locked: boolean; removalLocked: boolean; syncOpen: boolean; onOpen: () => void;
}) {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null), request = useRef(0), removing = useRef(false);
  const [width, setWidth] = useState(0), [open, setOpen] = useState<'all' | string>(), [preview, setPreview] = useState<FilePreview>();
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const panelId = useId(), items = pendingComposerReferences(session, controls.sourceIds), layout = composerReferenceLayout(width, items.length);
  const selected = items.find(item => item.source.id === open), disabled = locked || !!controls.detaching || busy;
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const close = (focus = false) => {
    request.current++; setOpen(undefined); setLoading(false); setError('');
    if (focus) (trigger.current?.isConnected ? trigger.current : root.current?.querySelector<HTMLButtonElement>('.composer-reference-more, .composer-reference-tab')
      || root.current?.closest('.session-composer-tabs')?.querySelector<HTMLButtonElement>('.session-sync-tab'))?.focus();
  };
  useEffect(() => { if (syncOpen) close(); }, [syncOpen]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (open && (open === 'all' ? !layout.hidden : !selected)) close(true); }, [open, !!selected, layout.hidden]);
  usePopupDismiss(!!open, root, reason => close(reason === 'escape'));
  const show = (source: SourceFile, button: HTMLButtonElement) => {
    trigger.current = button; onOpen(); setOpen(source.id); setPreview(undefined); setError(''); setLoading(true);
    const sequence = ++request.current;
    void api.call<FilePreview>('session.source.preview', { id: session.id, sourceId: source.id }).then(value => {
      if (sequence === request.current) setPreview(value);
    }, reason => { if (sequence === request.current) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (sequence === request.current) setLoading(false); });
  };
  const toggle = (source: SourceFile) => controls.select(toggleComposerReference(session, controls.sourceIds, source));
  const detach = async (source: SourceFile) => {
    if (removing.current || removalLocked || disabled) return;
    removing.current = true; setBusy(true); setError('');
    try { await controls.detach(source); if (open !== 'all') close(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { removing.current = false; setBusy(false); }
  };
  const selection = (item: typeof items[number]) => <label className="composer-reference-choice"><input type="checkbox" aria-label={`下一条消息引用：${resultLabelTitle(item.source.name)}`} checked={item.selected} disabled={item.automatic || disabled} onChange={() => toggle(item.source)}/><span>{item.automatic ? '自动引用' : '随下一条消息发送'}</span></label>;
  return <div ref={root} className="composer-references" aria-label="待发送的参考资料">
    {items.slice(0, layout.visible).reverse().map((item, index) => <button key={item.source.id} type="button" className={'composer-reference-tab composer-edge-tab' + (item.selected ? ' selected' : '')} style={{ width: layout.width, zIndex: index + 1 }} title={resultLabelTitle(item.source.name) + (item.selected ? ' · 待发送' : ' · 未选用')} aria-label={`查看参考资料：${resultLabelTitle(item.source.name)}`} aria-expanded={open === item.source.id} aria-controls={panelId} onClick={event => show(item.source, event.currentTarget)}><span>{resultLabelTitle(item.source.name)}</span></button>)}
    {layout.hidden > 0 && <button type="button" className="composer-reference-more composer-edge-tab" style={{ zIndex: layout.visible + 1 }} aria-label={`更多参考资料，共 ${items.length} 份，已折叠 ${layout.hidden} 份`} aria-expanded={open === 'all'} aria-controls={panelId} title="查看全部参考资料" onClick={event => { trigger.current = event.currentTarget; if (open === 'all') close(); else { request.current++; onOpen(); setError(''); setLoading(false); setOpen('all'); } }}><span>更多 {layout.hidden}</span><ChevronDown size={11} aria-hidden="true"/></button>}
    {open && (open === 'all' || selected) && <section id={panelId} className="composer-reference-panel" aria-label={open === 'all' ? '全部待发送资料' : '参考资料详情'}>
      <header><b>{open === 'all' ? `参考资料 · ${items.length}` : resultLabelTitle(selected!.source.name)}</b><button type="button" className="icon" aria-label="关闭参考资料" onClick={() => close(true)}><X size={15}/></button></header>
      {open === 'all' ? <div className="composer-reference-list">{items.map(item => <div className="composer-reference-row" key={item.source.id}>
        <input type="checkbox" aria-label={`下一条消息引用：${resultLabelTitle(item.source.name)}`} checked={item.selected} disabled={item.automatic || disabled} onChange={() => toggle(item.source)}/>
        <button type="button" className="composer-reference-name" title={resultLabelTitle(item.source.name)} onClick={event => show(item.source, event.currentTarget)}><FileText size={13}/><span>{resultLabelTitle(item.source.name)}</span>{item.automatic && <small>自动</small>}</button>
        {item.removable && <button type="button" className="icon" disabled={removalLocked || disabled} aria-label={`撤销加入：${resultLabelTitle(item.source.name)}`} title={removalLocked ? '当前操作结束后可撤销' : '从此会话移除，下一条消息不会引用'} onClick={() => void detach(item.source)}><X size={13}/></button>}
      </div>)}</div> : selected && <>
        {selection(selected)}
        <div className="composer-reference-body">{loading ? <p role="status">正在读取…</p> : preview?.type === 'text' ? /\.md$/i.test(selected.source.localPath) ? <Markdown text={preview.content}/> : <pre>{preview.content}</pre> : preview?.type === 'image' ? <img src={preview.content} alt={preview.name}/> : preview && <p>此格式暂不支持预览。</p>}
          {preview?.truncated && <p className="muted small">仅预览前 512 KB。</p>}</div>
        {selected.removable && <footer><button type="button" className="text-button" aria-label={`撤销加入：${resultLabelTitle(selected.source.name)}`} disabled={removalLocked || disabled} title={removalLocked ? '当前操作结束后可撤销' : undefined} onClick={() => void detach(selected.source)}>{busy ? '正在撤销…' : '撤销加入'}</button></footer>}
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
