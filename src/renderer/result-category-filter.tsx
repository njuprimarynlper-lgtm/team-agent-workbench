import React from 'react';
import { resultLabelOptions } from '../shared/result-labels';
import { currentResultLabel } from '../shared/content';

export function ResultCategoryFilter({ items, value, onChange, label, disabled = false }: { items: { title: string }[]; value: string; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  const currentValue = value.startsWith('label:') ? 'label:' + currentResultLabel(value.slice(6)) : value;
  return <select aria-label={label} value={currentValue} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="all">全部类别（{items.length}）</option>
    {resultLabelOptions(items, value).map(option => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
  </select>;
}
