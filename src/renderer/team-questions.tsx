import { usePopupDismiss } from './popup-dismiss';
import { cachedTeamRead } from './team-cache';
import { MarkdownEditor } from './markdown-editor';
import React, { useEffect, useRef, useState } from 'react';
import { Handshake, Paperclip, Plus, X } from 'lucide-react';
import type { AgentSession, FilePreview, Project } from '../shared/types';
import { type QuestionFile, type QuestionInbox, type QuestionMember, type TeamQuestion } from '../shared/questions';
import { sessionQuestionDraft } from '../shared/session-context-text';
import { QUESTION_COMPOSER_DEFAULT, QUESTION_COMPOSER_MAX, QUESTION_COMPOSER_MIN, questionComposerHeightAfterDrag } from './composer-resize';
import { Markdown } from './markdown';

type StagedFile = { id: string; name: string; size: number };
const fileSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
function QuestionBody({ text }: { text: string }) { return <div className="team-question-text"><Markdown text={text}/></div>; }
function FilePreviewDialog({ file, close }: { file: FilePreview; close: () => void }) {
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-label="附件预览"><header><h2>{file.name}</h2><button className="icon" aria-label="关闭附件预览" onClick={close}>×</button></header><div className="modal-body">{file.type === 'image' ? <img style={{ maxWidth: '100%' }} src={file.content} alt={file.name}/> : file.type === 'text' ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.content}</pre> : <p>此格式暂不支持预览，请下载后查看。</p>}{file.truncated && <p className="muted small">仅预览前 512 KB。</p>}</div></section></div>;
}
function QuestionFileList({ projectId, questionId, files }: { projectId: string; questionId: string; files?: QuestionFile[] }) {
  const [preview, setPreview] = useState<FilePreview>(), [error, setError] = useState('');
  if (!files?.length) return null;
  const open = async (file: QuestionFile, download: boolean) => {
    setError('');
    try {
      const result = await window.workbench.call<FilePreview | boolean>(download ? 'question.file.download' : 'question.file.preview', { projectId, id: questionId, sha256: file.sha256, name: file.name });
      if (!download && result && typeof result === 'object') setPreview(result);
    } catch (reason: any) { setError(reason.message); }
  };
  return <><ul className="team-question-files">{files.map(file => <li key={file.sha256 + file.name}><span>{file.name}</span><small className="muted">{fileSize(file.size)}</small><button type="button" className="text-button" onClick={() => void open(file, false)}>预览</button><button type="button" className="text-button" onClick={() => void open(file, true)}>下载</button></li>)}</ul>{error && <p className="inline-error" role="alert">{error}</p>}{preview && <FilePreviewDialog file={preview} close={() => setPreview(undefined)}/>}</>;
}

const empty: QuestionInbox = { items: [], jobs: [], read: {} };
export const questionUnread = (q: TeamQuestion, inbox: QuestionInbox) => (inbox.read[q.id] || 0) < q.activityRevision;
const time = (value: string) => new Date(value).toLocaleString('zh-CN');
export function QuestionCard({ question: q, unread, open }: { question: TeamQuestion; unread: boolean; open: () => void }) {
  return <button className={'team-question-card' + (unread ? ' unread' : '')} onClick={open}>
    <span className="row"><b>{q.title}</b><span className="spacer"/><span className={'badge' + (q.closedAt ? ' muted' : '')}>{q.closedAt ? '已关闭' : '开放'}</span></span>
    <small>{q.authorName} 求助 · {q.recipients.filter(r => r.answers.length).length}/{q.recipients.length === q.recipientCount ? q.recipientCount : 1} 人已回复{unread ? ' · 有新动态' : ''}</small>
  </button>;
}
export function QuestionFeed({ inbox = empty, projects, open }: { inbox?: QuestionInbox; projects: Project[]; open: (id: string) => void }) {
  const [scope, setScope] = useState('all'), [search, setSearch] = useState('');
  const items = inbox.items.filter(q => (scope === 'all' || (scope === 'closed' ? !!q.closedAt : !q.closedAt)) && (q.title + q.authorName).includes(search)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="team-question-feed" aria-label="求助动态"><div className="row"><Handshake size={18}/><h3>求助动态</h3><span className="spacer"/><select aria-label="筛选求助状态" value={scope} onChange={e => setScope(e.target.value)}><option value="open">开放的求助</option><option value="closed">已关闭</option><option value="all">全部</option></select><input aria-label="搜索求助" placeholder="搜索求助或求助人" value={search} onChange={e => setSearch(e.target.value)}/></div>
    {inbox.error && <p className="inline-error">求助动态暂未同步：{inbox.error}</p>}
    <div className="team-question-feed-list">{items.map(q => <div key={q.id}><small className="muted">{projects.find(p => p.id === q.projectId)?.name || '项目'}</small><QuestionCard question={q} unread={questionUnread(q, inbox)} open={() => open(q.id)}/></div>)}{!items.length && <p className="muted small">暂无{scope === 'closed' ? '已关闭' : scope === 'open' ? '开放的' : ''}求助</p>}</div>
  </section>;
}

function QuestionComposer({ session, sent }: { session: AgentSession; sent: (q: TeamQuestion) => void }) {
  const [members, setMembers] = useState<QuestionMember[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [context, setContext] = useState('');
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [choosingMembers, setChoosingMembers] = useState(false), [memberSearch, setMemberSearch] = useState('');
  const [beforeAi, setBeforeAi] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const submitted = useRef<{ payload: string; id: string } | undefined>(undefined), working = useRef(false);
  const draft = sessionQuestionDraft(session);
  const matchingMembers = members.filter(member => `${member.name} ${member.username}`.toLocaleLowerCase().includes(memberSearch.trim().toLocaleLowerCase()));
  useEffect(() => { let active = true; void cachedTeamRead<QuestionMember[]>(window.workbench, { action: 'question.members', projectId: session.binding!.project.id }, value => { if (active) { setMembers(value || []); if (value) setLoading(false); } }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [session.id]);
  const send = async () => {
    if (working.current || !title.trim() || !selected.length || session.closedAt) return; working.current = true; setBusy(true); setError('');
    const fileIds = files.map(file => file.id);
    const value = { title: title.trim(), body: body.trim(), context: context.trim(), recipients: [...selected].sort(), fileIds }, payload = JSON.stringify(value);
    if (submitted.current?.payload !== payload) submitted.current = { payload, id: crypto.randomUUID() };
    try { const q = await window.workbench.call<TeamQuestion>('question.create', { sessionId: session.id, question: { ...value, id: submitted.current.id } }); setFiles([]); sent(q); }
    catch (e: any) { setError(e.message); } finally { working.current = false; setBusy(false); }
  };
  const fillAi = () => {
    if (!draft) return;
    const next = body.trim() ? `${body.trimEnd()}\n\n${draft}` : draft;
    if (next.length > 12000) { setError('加入 AI 建议后内容过长，请先精简求助内容。'); return; }
    setBeforeAi(body); setBody(next); setError('');
  };
  const memberPicker = useRef<HTMLDivElement>(null), memberTrigger = useRef<HTMLButtonElement>(null);
  usePopupDismiss(choosingMembers, memberPicker, reason => { setChoosingMembers(false); if (reason === 'escape') memberTrigger.current?.focus(); }, { inside: () => [memberTrigger.current] });
  return <section className="team-question-compose" aria-label="发起求助"><fieldset disabled={busy || !!session.closedAt}>
    <div className="team-question-recipient-row"><span>发给</span>{selected.map(username => <span className="team-question-recipient-chip" key={username}>{members.find(member => member.username === username)?.name || username}<button type="button" aria-label={`移除接收人 ${username}`} onClick={() => setSelected(current => current.filter(name => name !== username))}><X size={12}/></button></span>)}<button type="button" className="text-button" ref={memberTrigger} aria-expanded={choosingMembers} onClick={() => setChoosingMembers(value => !value)}><Plus size={14}/>选择成员</button></div>
    {choosingMembers && <div className="team-question-member-picker" ref={memberPicker}><input autoFocus aria-label="搜索成员" placeholder="搜索姓名或账号" value={memberSearch} onChange={event => setMemberSearch(event.target.value)}/><div className="team-question-members">{matchingMembers.map(member => <label key={member.username}><input type="checkbox" checked={selected.includes(member.username)} onChange={event => setSelected(current => event.target.checked ? [...current, member.username] : current.filter(name => name !== member.username))}/>{member.name} <small className="muted">{member.username}</small></label>)}{loading ? <small>正在读取成员…</small> : !members.length ? <small>当前组没有可选择的其他成员</small> : !matchingMembers.length && <small>没有匹配的成员</small>}</div><button type="button" className="text-button" onClick={() => setChoosingMembers(false)}>完成选择</button></div>}
    <label>求助标题（必填）<input aria-label="求助标题" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="用一句话概括需要什么帮助"/></label>
    <div className="team-question-main-input"><label>求助内容（选填）<MarkdownEditor aria-label="求助内容（选填）" rows={5} maxLength={12000} value={body} onChange={e => { setBody(e.target.value); setBeforeAi(undefined); }} placeholder="可补充问题详情、背景或希望对方确认的内容"/></label>
      <div className="team-question-compose-tools"><button type="button" className="team-question-tool" disabled={files.length >= 30} onClick={() => void window.workbench.call<StagedFile[]>('question.files.stage').then(added => setFiles(current => { const next = [...current]; for (const file of added) if (!next.some(item => item.id === file.id) && next.length < 30) next.push(file); return next; }), reason => setError(reason.message))}><Paperclip size={14}/>添加附件</button>{draft && <button type="button" className="team-question-tool" onClick={fillAi}>填入 AI 建议</button>}{beforeAi !== undefined && <button type="button" className="team-question-tool" onClick={() => { setBody(beforeAi); setBeforeAi(undefined); }}>撤销填入</button>}</div>
      {!!files.length && <div className="team-question-attachments">{files.map(file => <div className="team-question-file-chip" key={file.id}><span>{file.name}</span><small className="muted">{fileSize(file.size)}</small><button type="button" className="text-button" aria-label={`移除附件 ${file.name}`} onClick={() => void window.workbench.call('question.files.remove', { id: file.id }).then(() => setFiles(current => current.filter(item => item.id !== file.id)), reason => setError(reason.message))}><X size={12}/></button></div>)}</div>}
    </div>
    <details className="team-question-extra"><summary>补充资料（选填）{context.trim() && <span className="muted"> · 已填写</span>}</summary><MarkdownEditor aria-label="补充资料（选填）" rows={3} maxLength={24000} placeholder="可补充背景、参考资料或链接" value={context} onChange={e => setContext(e.target.value)}/></details>
    <div className="team-question-compose-footer"><button className="primary" disabled={!title.trim() || !selected.length || busy} title={!selected.length ? '请选择接收成员' : !title.trim() ? '请填写求助标题' : undefined} onClick={() => void send()}>{busy ? '发送中…' : `发送求助${selected.length ? `（${selected.length} 人）` : ''}`}</button></div>
  </fieldset>{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

function QuestionResizeHandle({ height, resize }: { height: number; resize: (height: number, anchor: HTMLElement) => void }) {
  const begin = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startY = event.clientY, start = height, anchor = event.currentTarget;
    const apply = (clientY: number) => resize(questionComposerHeightAfterDrag(start, startY, clientY), anchor);
    const move = (next: PointerEvent) => apply(next.clientY);
    const finish = (next: PointerEvent) => { apply(next.clientY); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };
  return <button type="button" className="team-question-resize" role="separator" aria-label="调整继续求助高度" aria-orientation="horizontal" aria-valuemin={QUESTION_COMPOSER_MIN} aria-valuemax={QUESTION_COMPOSER_MAX} aria-valuenow={height} title="向上拖动加高，向下拖动降低；双击恢复默认" onPointerDown={begin} onDoubleClick={event => resize(QUESTION_COMPOSER_DEFAULT, event.currentTarget)} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(questionComposerHeightAfterDrag(height, 0, event.key === 'ArrowUp' ? -24 : 24), event.currentTarget); } }}><span/></button>;
}
export function questionAutoLock(inbox: QuestionInbox | undefined, sessionId: string) {
  const dialogue = inbox?.dialogues?.find(item => item.sessionId === sessionId);
  if (!dialogue) {
    const received = inbox?.items.find(q => !q.closedAt && inbox.replyModes?.[q.id] === 'auto' && q.recipients.some(r => r.sessionId === sessionId));
    if (received) return { name: received.authorName, title: received.title, suggested: received.recipients.some(r => !!r.endSuggestedAt) };
    return;
  }
  const question = inbox?.items.find(item => item.id === dialogue.questionId);
  const peer = question?.recipients.find(item => item.username === dialogue.peer);
  return { name: peer?.name || dialogue.peer, title: question?.title || '求助', suggested: !!dialogue.suggested || !!peer?.endSuggestedAt };
}
export function QuestionDetail({ question: q, inbox, username, sessions, session, changed, onPlace, onBack, active: visible = true }: { active?: boolean; question: TeamQuestion; inbox: QuestionInbox; username: string; sessions: AgentSession[]; session?: AgentSession; changed: () => Promise<void>; onPlace?: (sessionId: string, text: string) => void; onBack?: () => void }) {
  const own = q.recipients.find(r => r.username === username), author = q.author === username;
  const [laneText, setLaneText] = useState<Record<string, string>>({}), [laneFiles, setLaneFiles] = useState<Record<string, StagedFile[]>>({}), [laneHeight, setLaneHeight] = useState(QUESTION_COMPOSER_DEFAULT);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [ack, setAck] = useState<{ peer: string; kind: 'send' | 'auto' | 'stop' | 'close'; body?: string }>();
  const followDraft = useRef<Record<string, { payload: string; id: string }>>({});
  const working = useRef(false);
  const linked = sessions.find(s => s.id === (author ? q.sessionId : own?.sessionId));
  const job = [...inbox.jobs].reverse().find(j => j.questionId === q.id && j.mode !== 'import' && j.mode !== 'auto' && j.mode !== 'fill'), active = !!job && ['queued', 'running', 'ready'].includes(job.phase);
  const inDialogue = !!own && (!!own.sessionId || own.answers.length > 0 || own.state !== 'pending');
  useEffect(() => { if (visible && questionUnread(q, inbox)) void window.workbench.call('question.read', { id: q.id, revision: q.activityRevision }).then(changed).catch(e => setError(e.message)); }, [q.id, q.activityRevision, visible]);
  const resizeLane = (height: number) => setLaneHeight(height);
  const run = async (action: string, payload: object) => { if (working.current) return false; working.current = true; setBusy(true); setError(''); try { await window.workbench.call(action, payload); await changed(); return true; } catch (e: any) { setError(e.message); return false; } finally { working.current = false; setBusy(false); } };
  const placeReply = async (sessionId: string, answerId: string) => {
    if (working.current || !onPlace) return;
    working.current = true; setBusy(true); setError('');
    try {
      const text = await window.workbench.call<string>('question.import', { projectId: q.projectId, id: q.id, sessionId, answerId });
      onPlace(sessionId, text);
    } catch (e: any) { setError(e.message); }
    finally { working.current = false; setBusy(false); }
  };
  const pickLane = async (username: string) => {
    setError('');
    try {
      const added = await window.workbench.call<StagedFile[]>('question.files.stage');
      setLaneFiles(current => { const next = [...(current[username] || [])]; for (const file of added) if (!next.some(item => item.id === file.id) && next.length < 30) next.push(file); return { ...current, [username]: next }; });
    } catch (reason: any) { setError(reason.message); }
  };
  const lanes = q.recipients.map(r => {
      const peer = author ? r.username : q.author, peerName = author ? r.name : q.authorName;
      const dialogue = author ? inbox.dialogues?.find(item => item.questionId === q.id && item.peer === r.username) : undefined;
      const receiverAuto = !author && !!linked && !linked.closedAt && inbox.replyModes?.[q.id] !== 'manual';
      const automatic = !!dialogue || receiverAuto, suggested = !!r.endSuggestedAt || !!dialogue?.suggested;
      const current = session && session.binding?.project.id === q.projectId && session.purpose === 'work' && !session.closedAt && !session.cursorNative ? session : undefined;
      const targetSession = author ? (linked && !linked.closedAt ? linked : undefined) : current || (linked && !linked.closedAt ? linked : undefined);
      const otherAuto = inbox.dialogues?.find(item => item.sessionId === targetSession?.id && !(item.questionId === q.id && item.peer === peer));
      const autoOn = automatic && !suggested;
      const pendingAuto = ack?.kind === 'auto' && ack.peer === r.username;
      const pendingStop = ack?.kind === 'stop' && ack.peer === r.username;
      const pendingClose = ack?.kind === 'close';
      const pendingSend = ack?.kind === 'send' && ack.peer === r.username ? ack.body || '' : '';
      const autoNow = pendingStop ? false : (autoOn || pendingAuto);
      const turns = [...(q.followUps || []).filter(item => !item.target || item.target === r.username).map(item => ({ id: item.id, at: item.createdAt, mine: author, who: author ? '我' : q.authorName, body: item.body, files: item.files, answerId: undefined as string | undefined })), ...r.answers.map(item => ({ id: item.id, at: item.createdAt, mine: !author, who: author ? r.name : '我', body: item.body, files: item.files, answerId: item.id }))].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const savedFill = (author ? inbox.fills?.[q.id]?.[r.username] : r.username === username ? inbox.fills?.[q.id]?.[`answer:${username}`] : '')?.trim() || '';
      const fillTitle = savedFill ? (author ? '把 AI 生成的追问填进输入框' : '把 AI 生成的回答填进输入框') : (author ? '还没有 AI 生成的追问' : '还没有 AI 生成的回答');
      const lane = laneFiles[r.username] || [];
      const sendMessage = () => {
        const body = (laneText[r.username] || '').trim(); if (!body || busy || autoNow || q.closedAt || pendingClose) return;
        const key = r.username, fileIds = author ? lane.map(file => file.id) : [];
        const signature = JSON.stringify({ body, fileIds });
        if (followDraft.current[key]?.payload !== signature) followDraft.current[key] = { payload: signature, id: crypto.randomUUID() };
        const draft = followDraft.current[key];
        const action = author ? 'question.follow' : 'question.answer';
        const payload = author ? { followId: draft.id, target: r.username, fileIds } : { answerId: draft.id };
        setLaneText(current => ({ ...current, [key]: '' }));
        setAck({ peer: key, kind: 'send', body });
        void run(action, { projectId: q.projectId, id: q.id, body, ...payload }).then(ok => {
          if (!ok) { setAck(current => current?.kind === 'send' && current.peer === key ? undefined : current); setLaneText(current => current[key]?.trim() ? current : { ...current, [key]: body }); return; }
          if (followDraft.current[key] === draft) delete followDraft.current[key];
          setAck(current => current?.kind === 'send' && current.peer === key ? undefined : current);
          if (author) setLaneFiles(current => ({ ...current, [key]: (current[key] || []).filter(file => !fileIds.includes(file.id)) }));
        });
      };
      const status = q.closedAt ? '已结束' : automatic ? (suggested ? '建议结束' : '自动对话中') : r.answers.length ? `${r.answers.length} 条答复` : ({ pending: '待回复', linked: '已关联', running: '回答中', replied: '已回复' })[r.state];
      const thread = <section className="team-question-replies" key={r.username}>
        <div className="team-question-lane-head"><b>{peerName}</b><small className="muted">{status}</small></div>
        <div className="team-question-thread">{turns.map(turn => {
          return <article key={turn.id} className={'team-question-turn' + (turn.mine ? ' mine' : '')}><span className="who">{turn.who} · {time(turn.at)}</span><QuestionBody text={turn.body}/><QuestionFileList projectId={q.projectId} questionId={q.id} files={turn.files}/>{author && !q.closedAt && !dialogue && turn.answerId && linked && !linked.closedAt && <button className="secondary compact team-question-import" disabled={busy || !onPlace} title="填入发起求助的会话，编辑后由你发送" onClick={() => void placeReply(linked.id, turn.answerId!)}>填入对话框</button>}</article>;
        })}{pendingSend && !turns.some(turn => turn.mine && turn.body === pendingSend) && <article className="team-question-turn mine is-pending" role="status"><span className="who">我 · 刚刚</span><QuestionBody text={pendingSend}/><p className="team-question-ack">已写入对话，正在送达。</p></article>}{!turns.length && !pendingSend && <p className="muted small">还没有往来。</p>}</div>
      </section>;
      const composer = !q.closedAt && !pendingClose && <div className={'team-question-composer' + (autoNow ? ' is-auto' : '')}>
          {!autoNow && <QuestionResizeHandle height={laneHeight} resize={resizeLane}/>}
          <MarkdownEditor readOnly={autoNow} style={{ height: laneHeight }} maxLength={12000} aria-label={`回复${peerName}`} value={autoNow ? '' : (laneText[r.username] || '')} placeholder={autoNow ? `正在与${peerName}自动往返。新的回复会出现在上面的对话里，这里暂时不能手动发送。` : (author ? '继续求助' : '回复对方')} onChange={e => { if (!autoNow) setLaneText(current => ({ ...current, [r.username]: e.target.value })); }} onKeyDown={e => { if (autoNow) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (!e.repeat) sendMessage(); } }}/>
          {author && !autoNow && !!lane.length && <div className="team-question-file-row">{lane.map(file => <span className="team-question-file-chip" key={file.id}><span>{file.name}</span><button type="button" className="text-button" disabled={busy} onClick={() => void window.workbench.call('question.files.remove', { id: file.id }).then(() => setLaneFiles(current => ({ ...current, [r.username]: (current[r.username] || []).filter(item => item.id !== file.id) })), reason => setError(reason.message))}>移除</button></span>)}</div>}
          <div className="team-question-composer-bar">
            <button type="button" className={'team-question-tool boxed' + (pendingClose ? ' is-ack' : '')} disabled={busy || pendingClose || (!author && !inDialogue)} title={suggested ? '确认结束这条求助' : '结束求助'} onClick={() => { setAck({ peer: '', kind: 'close' }); void run('question.close', { projectId: q.projectId, id: q.id }).then(ok => { if (!ok) setAck(current => current?.kind === 'close' ? undefined : current); }); }}>{pendingClose ? '正在结束…' : suggested ? '确认结束' : '结束'}</button>
            {!autoNow && (author ? !!r.answers.length : true) && <button type="button" className="team-question-tool boxed" disabled={!targetSession || !!targetSession.closedAt || !!otherAuto || busy || (!author && (active || own?.state === 'running'))} title={!targetSession ? '当前 Session 不能用来自动往返' : otherAuto ? '这条 Session 正在与另一个人自动往返' : author ? `让当前 Session 和${peerName}自动往返：对方回复后会继续追问，期间不能手动发送` : `让当前 Session 自动回复${peerName}，期间不能手动发送`} onClick={() => { if (!targetSession) return; setAck({ peer: r.username, kind: 'auto' }); void run('question.auto', { projectId: q.projectId, id: q.id, sessionId: targetSession.id, peer }).then(ok => { if (!ok) setAck(current => current?.kind === 'auto' && current.peer === r.username ? undefined : current); else setAck(current => current?.kind === 'auto' && current.peer === r.username ? undefined : current); }); }}>自动对话</button>}
            {autoNow && <button type="button" className={'team-question-tool boxed' + (pendingAuto || pendingStop ? ' is-ack' : '')} disabled={busy} title="停止自动往返，之后可以继续手动发送" onClick={() => { setAck({ peer: r.username, kind: 'stop' }); void run('question.auto.stop', { projectId: q.projectId, id: q.id, peer }).then(ok => { if (!ok) setAck(current => current?.kind === 'stop' && current.peer === r.username ? undefined : current); else setAck(current => current?.kind === 'stop' && current.peer === r.username ? undefined : current); }); }}>{pendingStop ? '已停止自动' : '停止自动'}</button>}
            {!autoNow && <span className="team-question-composer-actions">
              {author && <button type="button" className="team-question-tool" disabled={busy || lane.length >= 30} title="为这次追问添加附件" onClick={() => void pickLane(r.username)}>附件</button>}
              {(author || r.username === username) && <button type="button" className="team-question-tool" disabled={!savedFill || busy} title={fillTitle} onClick={() => savedFill && setLaneText(current => ({ ...current, [r.username]: savedFill }))}>AI填入</button>}
              <button type="button" className="primary compact team-question-send" disabled={!laneText[r.username]?.trim() || busy} onClick={sendMessage}>{busy ? '发送中…' : '发送'}</button>
            </span>}
          </div>
          {pendingAuto && <p className="team-question-ack" role="status">已开启自动对话。对方的新回复会进入当前 Session，这里暂时不能手动发送。</p>}
          {pendingStop && <p className="team-question-ack" role="status">已停止自动，可以继续手动发送。</p>}
          {!author && job?.phase === 'error' && <p className="muted small team-question-composer-status">{job.error}</p>}
          {!author && job?.phase === 'ready' && job.error && <p className="muted small team-question-composer-status">答复已保留，连接恢复后自动送达。</p>}
        </div>;
      return { username: r.username, peerName, thread, composer };
    });
  const docked = lanes.some(lane => lane.composer);
  return <section className="team-question-detail">
    <div className="team-question-detail-scroll">
      {onBack && <button className="text-button" onClick={onBack}>返回求助列表</button>}
      <div className="row"><h3>{q.title}</h3><span className="spacer"/><span className="badge">{q.closedAt ? '已关闭' : '开放'}</span></div><p className="muted small">{q.authorName} · {time(q.createdAt)}</p><QuestionBody text={q.body}/><QuestionFileList projectId={q.projectId} questionId={q.id} files={q.files}/>{q.context && <details><summary>补充资料</summary><QuestionBody text={q.context}/></details>}
      {q.closedAt && <p className="callout">求助已于 {time(q.closedAt)} 结束，不再接收答复。已关联的 Session 保留，需要结束时请在 Session 中手动关闭。</p>}
      {author && <p className="muted small">{q.recipients.filter(r => r.answers.length).length}/{q.recipientCount} 人已回复 · 每人一条对话</p>}
      {lanes.map(lane => lane.thread)}
    </div>
    {(docked || (ack?.kind === 'close' && !q.closedAt) || error) && <div className="team-question-dock">
      {ack?.kind === 'close' && !q.closedAt && <p className="team-question-ack" role="status">正在结束这条求助。结束后不再接收新的答复。</p>}
      {lanes.map(lane => lane.composer && <div key={lane.username}>{lanes.length > 1 && <span className="team-question-dock-label">{author ? `继续向${lane.peerName}求助` : `回复${lane.peerName}`}</span>}{lane.composer}</div>)}
      {error && <p className={error === '这条回复已经引入当前 Session' ? 'team-question-note' : 'inline-error'} role={error === '这条回复已经引入当前 Session' ? 'status' : 'alert'}>{error}</p>}
    </div>}
  </section>;
}

export function QuestionPanel({ inbox = empty, selectedId, session, username, sessions, connected, select, close, changed, onPlace, embedded = false, active = true, projectId }: { embedded?: boolean; active?: boolean; projectId?: string; inbox?: QuestionInbox; selectedId: string; session?: AgentSession; username: string; sessions: AgentSession[]; connected: boolean; select: (id: string) => void; close: () => void; changed: () => Promise<void>; onPlace?: (sessionId: string, text: string) => void }) {
  const items = inbox.items.filter(q => projectId ? q.projectId === projectId : session && q.projectId === session.binding?.project.id && (q.sessionId === session.id || q.recipients.some(r => r.username === username && (!r.sessionId || r.sessionId === session.id)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const q = items.find(item => item.id === selectedId);
  const canCompose = !!session && !session.closedAt && connected;
  return <aside className="team-question-panel" aria-label="寻求帮助">{!embedded && <header className="row"><Handshake size={18}/><h3>寻求帮助</h3><span className="spacer"/><button className="icon" aria-label="关闭求助窗口" onClick={close}><X size={18}/></button></header>}<div className="team-question-panel-body">
    {(!connected || inbox.error) && <div className="team-question-panel-note">{!connected && <p className="callout">连接中央节点后，可发送求助和答复。</p>}{inbox.error && <p className="inline-error">{inbox.error}</p>}</div>}
    {q ? <QuestionDetail key={q.id} active={active} question={q} inbox={inbox} username={username} sessions={sessions} session={session} changed={changed} onPlace={onPlace} onBack={() => select('session')}/> : <div className="team-question-panel-scroll">{canCompose && <QuestionComposer key={session.id} session={session} sent={item => { select(item.id); void changed(); }}/>} {!!items.length && <h3>{projectId ? '本项目的求助' : '当前会话的求助'}</h3>}{items.map(item => <QuestionCard key={item.id} question={item} unread={questionUnread(item, inbox)} open={() => select(item.id)}/>)}{!items.length && !canCompose && <p className="muted small">暂无求助</p>}</div>}
  </div></aside>;
}
