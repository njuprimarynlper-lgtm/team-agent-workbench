import React, { useEffect, useRef, useState } from 'react';
import { Check, FileText, RefreshCw, Search, X } from 'lucide-react';
import type { AgentSession } from '../shared/types';
import { resultDirectoryLabel, resultItemFolder } from '../shared/result-directories';
import { resultReferenceKey, resultVersionKey, supportsSessionResults, type AttachResultsResponse, type SessionResultCandidate, type SessionResultCandidates } from '../shared/session-results';
import { teamAccessRevoked } from '../shared/team-cache';
import { DirectoryTree } from './result-directories';
import { Markdown } from './markdown';
import './session-materials.css';

type Scope = 'personal' | 'team';
export function SessionMaterials({ session, changed, opened, close }: { session: AgentSession; changed: () => Promise<void>; opened?: boolean; close?: () => void }) {
  const [localOpen, setLocalOpen] = useState(false), [scope, setScope] = useState<Scope>('personal');
  const [catalogs, setCatalogs] = useState<Partial<Record<Scope, SessionResultCandidates>>>({}), [loading, setLoading] = useState<Scope[]>([]);
  const [selected, setSelected] = useState<SessionResultCandidate[]>([]), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [errors, setErrors] = useState<string[]>([]);
  const [folders, setFolders] = useState<Record<Scope, string>>({ personal: 'all', team: 'all' }), [preview, setPreview] = useState<SessionResultCandidate>();
  const dialog = useRef<HTMLElement>(null), sequence = useRef(0), requests = useRef({ personal: 0, team: 0 }), open = opened ?? localOpen;
  const dismiss = () => { if (busy) return; if (close) close(); else setLocalOpen(false); };
  const load = async (kind: Scope, n: number) => {
    const request = ++requests.current[kind], current = () => sequence.current === n && requests.current[kind] === request;
    setLoading(value => [...new Set([...value, kind])]);
    try {
      const cached = await window.workbench.call<SessionResultCandidates>('session.resultCandidates', { id: session.id, scope: kind });
      if (!current()) return;
      setCatalogs(value => ({ ...value, [kind]: cached }));
      if (kind === 'team') {
        const fresh = await window.workbench.call<SessionResultCandidates>('session.resultCandidates', { id: session.id, scope: kind, refresh: true });
        if (current()) setCatalogs(value => ({ ...value, [kind]: fresh }));
      }
    } catch (error: any) { if (current()) setCatalogs(value => ({ ...value, [kind]: value[kind]?.available && !teamAccessRevoked(error) ? { ...value[kind]!, warning: error.message } : { items: [], directories: [], cached: false, available: false, warning: error.message } })); }
    finally { if (current()) setLoading(value => value.filter(item => item !== kind)); }
  };
  useEffect(() => {
    const n = ++sequence.current;
    if (open) { setBusy(false); setLoading([]); setSelected([]); setErrors([]); setPreview(undefined); setCatalogs({}); setScope('personal'); setQuery(''); setFolders({ personal: 'all', team: 'all' }); void load('personal', n); void load('team', n); }
    return () => { ++sequence.current; };
  }, [open, session.id]);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement; dialog.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus();
    return () => { if (prior instanceof HTMLElement && prior.isConnected) prior.focus(); };
  }, [open]);
  const catalog = catalogs[scope], directories = catalog?.directories || [], folder = folders[scope];
  const visible = (catalog?.items || []).filter(item => query.trim() ? `${item.title} ${item.content} ${item.author}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : folder === 'all' || resultItemFolder(item, directories) === folder);
  const toggle = (item: SessionResultCandidate) => setSelected(value => value.some(row => resultReferenceKey(row.reference) === resultReferenceKey(item.reference)) ? value.filter(row => resultReferenceKey(row.reference) !== resultReferenceKey(item.reference)) : [...value, item]);
  const chooseLatest = (item: SessionResultCandidate) => setSelected(value => [...value.filter(row => resultReferenceKey(row.reference) !== resultReferenceKey(item.reference)), item]);
  const attach = async () => {
    const n = sequence.current; setBusy(true); setErrors([]);
    try {
      const result = await window.workbench.call<AttachResultsResponse>('session.attachResults', { id: session.id, references: selected.map(item => item.reference) });
      const refreshError = await changed().then(() => undefined, (error: any) => '关联已保存，但界面刷新失败：' + error.message);
      if (sequence.current !== n) return;
      const added = new Set(result.added.map(item => resultVersionKey(item.reference)));
      setSelected(value => value.filter(item => !added.has(resultVersionKey(item.reference))));
      if (!result.failed.length && !refreshError) { if (close) close(); else setLocalOpen(false); }
      else { setErrors([...(result.added.length && result.failed.length ? [`已关联 ${result.added.length} 项，其余未完成。`] : []), ...result.failed.map(failure => `${selected.find(item => resultVersionKey(item.reference) === resultVersionKey(failure.reference))?.title || '成果'}：${failure.error}`), ...(refreshError ? [refreshError] : [])]); void load('personal', n); void load('team', n); }
    } catch (error: any) { if (sequence.current === n) setErrors([error.message]); }
    finally { if (sequence.current === n) setBusy(false); }
  };
  return <>{!opened && <button className="text-button" disabled={!session.binding || !supportsSessionResults(session)} title={session.codexRemote || session.cursorNative ? '此接入方式暂不支持本机成果引用' : undefined} onClick={() => setLocalOpen(true)}>关联成果</button>}{open && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) dismiss(); }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || [])].filter(element => element.getClientRects().length);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
  }}><section className="modal wide session-results-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="关联成果"><header><h2>关联成果 · {session.binding?.project.name}</h2><button className="icon" disabled={busy} aria-label="关闭成果选择" onClick={dismiss}><X size={18}/></button></header>
    <div className="session-results-toolbar"><div className="session-results-tabs" role="tablist" aria-label="成果来源">{(['personal', 'team'] as const).map(kind => <button key={kind} role="tab" aria-selected={scope === kind} onClick={() => { setScope(kind); setPreview(undefined); }}>{kind === 'personal' ? '个人成果' : '团队成果'}</button>)}</div><label className="session-results-search"><Search size={15}/><input type="search" aria-label="搜索关联成果" placeholder="搜索当前来源的标题、内容或作者" value={query} onChange={event => setQuery(event.target.value)}/></label><button className="icon" aria-label="刷新可关联成果" disabled={loading.includes(scope)} onClick={() => void load(scope, sequence.current)}><RefreshCw size={15} className={loading.includes(scope) ? 'spin' : ''}/></button></div>
    <div className="session-results-notices">{errors.length > 0 && <div className="inline-error" role="alert">{errors.map((error, index) => <div key={index}>{error}</div>)}</div>}{catalog?.warning && <p className="muted small" role="status">{catalog.warning}</p>}{loading.includes(scope) && <p className="muted small" role="status">{catalog?.available ? '正在更新列表，可以继续选择已有成果。' : '正在读取成果…'}</p>}</div>
    <div className="session-results-layout"><aside className="result-directory-sidebar"><b>目录</b><DirectoryTree directories={directories} value={folder} change={value => { setFolders(old => ({ ...old, [scope]: value })); setPreview(undefined); }} all disabled={!catalog?.available}/></aside><div className="session-results-items" aria-label="可关联成果">
      {visible.map(item => {
        const picked = selected.find(row => resultReferenceKey(row.reference) === resultReferenceKey(item.reference)), used = item.linkedVersion === item.reference.version && !item.needsLinkUpgrade;
        return <article key={resultVersionKey(item.reference)} className={'session-result-option' + (preview && resultVersionKey(preview.reference) === resultVersionKey(item.reference) ? ' is-previewed' : '')}>
          <label><input type="checkbox" aria-label={`关联成果：${item.title}`} checked={used || !!picked} disabled={busy || used || !!item.unavailable} onChange={() => toggle(item)}/><span><b>{item.title}</b><small>{item.author} · v{item.reference.version}{used ? ' · 已关联' : item.linkedVersion ? ` · 已关联 v${item.linkedVersion}` : ''}{item.needsLinkUpgrade ? ' · 可补全附件入口' : ''}{item.attachments.length ? ` · ${item.attachments.length} 个附件入口` : ''}</small>{(query.trim() || folder === 'all') && <small>{resultDirectoryLabel(resultItemFolder(item, directories), directories)}</small>}</span></label>
          <div className="session-result-actions"><button className="text-button" onClick={() => setPreview(item)}><FileText size={13}/>预览</button>{!used && !picked && !!item.linkedVersion && <button className="text-button" disabled={busy || !!item.unavailable} onClick={() => chooseLatest(item)}>{item.needsLinkUpgrade && item.linkedVersion === item.reference.version ? '补全附件入口' : '更新引用'}</button>}{used && <Check size={14}/>}</div>
          {picked && picked.reference.version !== item.reference.version && <p className="session-result-version-change">已选 v{picked.reference.version}，当前已更新为 v{item.reference.version}。<button className="text-button" disabled={busy} onClick={() => chooseLatest(item)}>改选新版</button></p>}{item.unavailable && <p className="inline-error">{item.unavailable}</p>}
        </article>;
      })}{!visible.length && !loading.includes(scope) && <p className="session-results-empty muted">{catalog?.available ? query.trim() ? '没有匹配成果。' : '此目录暂无可关联成果。' : '没有可用的本地成果清单。'}</p>}
    </div>{preview && <aside className="session-result-preview" aria-label="成果预览"><div className="row"><b>{preview.title} · v{preview.reference.version}</b><span className="spacer"/><button className="icon" aria-label="关闭成果预览" onClick={() => setPreview(undefined)}><X size={15}/></button></div><Markdown text={preview.content}/>{preview.attachments.length > 0 && <section><h3>附件（按需读取）</h3>{preview.attachments.map(file => <p key={file.sha256 + file.name}>{file.name} · {file.size} 字节</p>)}<p className="muted small">关联后提供取件链接，不预先下载或读取。</p></section>}</aside>}</div>
    <div className="session-results-selection" aria-label="已选成果">{selected.map(item => <span className="session-result-chip" key={resultVersionKey(item.reference)}>{item.reference.scope === 'team' ? '团队' : '个人'} · {item.title} · v{item.reference.version}<button className="icon" disabled={busy} aria-label={'取消选择：' + item.title} onClick={() => toggle(item)}><X size={12}/></button></span>)}</div>
    <footer><span className="muted small">已选 {selected.length} 项，附带 {selected.reduce((count, item) => count + item.attachments.length, 0)} 个附件入口；下次发送时生效。</span><span className="spacer"/><button className="secondary" disabled={busy} onClick={dismiss}>取消</button><button className="primary" disabled={busy || !selected.length} onClick={() => void attach()}>{busy ? '正在关联…' : `关联 ${selected.length} 项成果`}</button></footer>
  </section></div>}</>;
}
