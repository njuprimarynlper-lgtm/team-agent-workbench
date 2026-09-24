import React, { useId } from 'react';
import { ChevronDown } from 'lucide-react';

export function ResultCard({ id, title, badges, metadata, preview, expanded, selected, disabled, toggle, selection, children, actions }: {
  id: string; title: string; badges: React.ReactNode; metadata: React.ReactNode; preview: string;
  expanded: boolean; selected?: boolean; disabled?: boolean; toggle: () => void;
  selection?: React.ReactNode; children?: React.ReactNode; actions: React.ReactNode;
}) {
  const detailId = useId();
  return <article className={'content-card result-card' + (expanded ? ' selected is-expanded' : '') + (selected ? ' merge-selected' : '')} data-result-id={id}>
    <div className="result-card-top">
      {selection && <div className="result-card-selection">{selection}</div>}
      <button className="content-card-summary result-card-toggle" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} disabled={disabled} onClick={toggle}>
        <span className="result-card-heading"><b title={title}>{title}</b><span className="result-card-badges">{badges}</span><ChevronDown size={16} aria-hidden="true"/></span>
        <span className="result-card-overview">{!expanded && <span className="result-card-preview">{preview}</span>}<span className="result-card-meta">{metadata}</span></span>
      </button>
      <div className="content-card-actions result-card-actions">{actions}</div>
    </div>
    {expanded && <div className="result-card-details" id={detailId} role="region" aria-label={`${title}详情`}>{children}</div>}
  </article>;
}
