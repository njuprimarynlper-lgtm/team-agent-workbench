import React from 'react';
import { resultLabelOptions } from '../shared/result-labels';

export function ResultCategoryFilter({ items, value, onChange, label, disabled = false }: { items: { title: string }[]; value: string; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  return <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="all">全部类别（{items.length}）</option>
    {resultLabelOptions(items, value).map(option => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
  </select>;
}
