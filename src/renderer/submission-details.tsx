import React from 'react';
import { fullDestination, sourceLabel, type SubmissionDestination, type SubmissionRecord } from '../shared/submission';

export function SubmissionDetails({ record, legacySource, legacyAuthor, destination, updatedBy, revision, summary = '来源与历史', children }: {
  record?: SubmissionRecord; legacySource?: string; legacyAuthor?: string; destination?: SubmissionDestination;
  updatedBy?: string; revision?: number; summary?: string; children?: React.ReactNode;
}) {
  const author = record?.submittedBy || legacyAuthor;
  return <details className="content-provenance submission-details"><summary>{summary}</summary>
    <dl>
      <dt>提交人</dt><dd>{author || '未记录提交人'}</dd>
      <dt>来源</dt><dd>{record ? record.sources.map((source, index) => <div key={index}>{sourceLabel(source)}</div>) : legacySource || '未记录来源'}</dd>
      <dt>上传到</dt><dd>{record || destination ? fullDestination(record?.destination || destination!) : '未记录目标'}</dd>
      {record && <><dt>提交时间</dt><dd>{new Date(record.submittedAt).toLocaleString()}</dd></>}
      {updatedBy && updatedBy !== author && <><dt>最近维护</dt><dd>{updatedBy}</dd></>}
      {revision && <><dt>当前版本</dt><dd>v{revision}</dd></>}
    </dl>{children}
  </details>;
}
