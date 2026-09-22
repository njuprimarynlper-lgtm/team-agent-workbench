import React from 'react';
import { ChevronRight, FileArchive, Trash2 } from 'lucide-react';
import type { AgentSession, Draft, Transfer } from '../shared/types';
import { contributionStatus } from '../shared/contribution-status';

export function draftIsPreserved(draft: Draft) {
  return !!draft.mergeCompletedAt || !!draft.submitted || !!draft.artifacts?.some(item => item.submitted);
}

function relatedTransfers(draft: Draft, transfers: Transfer[]) {
  const ids = new Set([draft.submitted, ...(draft.artifacts || []).map(item => item.submitted)].filter((id): id is string => !!id));
  return transfers.filter(item => ids.has(item.id));
}

function taskStatus(draft: Draft, transfers: Transfer[]) {
  if (draft.mergeCompletedAt) return draft.conclusionMergeProjectId ? '已保存到本地成果库' : '已保存到团队成果库';
  const related = relatedTransfers(draft, transfers);
  if (draftIsPreserved(draft)) {
    if (related.some(item => item.status === 'error')) return '上传未完成';
    if (related.some(item => item.status === 'running')) return '正在上传';
    if (related.some(item => item.status === 'queued')) return '等待上传';
    if (related.length && related.every(item => item.status === 'done')) return '已上传';
    return '上传状态待核对';
  }
  return contributionStatus(draft);
}

function statusTone(draft: Draft, transfers: Transfer[]) {
  const status = taskStatus(draft, transfers);
  if (/失败|未完成/.test(status)) return 'error';
  if (/正在|整理中|融合中|处理中/.test(status)) return 'running';
  if (/已上传|已保存/.test(status)) return 'done';
  return 'queued';
}

function taskKind(draft: Draft) {
  if (draft.conclusionMergeProjectId) return '本地成果处理';
  if (draft.mergeProjectId) return '团队成果合并';
  if (draft.preparationScope === 'incremental') return '增量整理';
  if (draft.preparationScope === 'full') return '全量整理';
  return '会话成果整理';
}

export function DraftTaskList({ drafts, sessions, transfers, open, remove }: { drafts: Draft[]; sessions: AgentSession[]; transfers: Transfer[]; open: (draft: Draft) => void; remove?: (draft: Draft) => void }) {
  const ordered = [...drafts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return <section className="draft-task-list" aria-label="成果整理任务列表">
    {ordered.map(draft => {
      const source = sessions.find(session => session.id === draft.sessionId), status = taskStatus(draft, transfers), preserved = draftIsPreserved(draft);
      const projectName = draft.binding?.project.name || source?.binding?.project.name || '本机项目';
      const resultCount = draft.artifacts?.length || draft.mergeSources?.length || (draft.body ? 1 : 0);
      return <article className="draft-task-card" data-draft-id={draft.id} key={draft.id}>
        <button className="draft-task-open" aria-label={`查看整理任务：${draft.titleAlias || draft.title}`} onClick={() => open(draft)}>
          <span className="draft-task-icon"><FileArchive size={21}/></span>
          <span className="draft-task-body">
            <span className="draft-task-badges"><span className="content-category-badge">{taskKind(draft)}</span><span className={'badge ' + statusTone(draft, transfers)}>{status}</span>{preserved && <span className="draft-preserved">成果已单独保存</span>}</span>
            <b>{draft.titleAlias || draft.title}</b>
            <span className="draft-task-meta"><span>来源：{source?.title || '原会话记录'}</span><span>项目：{projectName}</span>{draft.preparationScope === 'incremental' && draft.snapshot && <span>新增 {draft.snapshot.messageCount} 条消息</span>}{resultCount > 0 && <span>{resultCount} 项内容</span>}</span>
            <small>创建于 {new Date(draft.createdAt).toLocaleString()}{draft.generationFinishedAt ? ` · 最近完成 ${new Date(draft.generationFinishedAt).toLocaleString()}` : ''}</small>
          </span>
          <ChevronRight size={18}/>
        </button>
        {remove && <button className="text-button danger draft-task-delete" aria-label={`删除整理记录：${draft.titleAlias || draft.title}`} onClick={() => remove(draft)}><Trash2 size={13}/>删除记录</button>}
      </article>;
    })}
  </section>;
}
