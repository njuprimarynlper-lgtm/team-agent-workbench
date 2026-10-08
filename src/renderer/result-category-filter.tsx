import React from 'react';
import { contributionCategoryInfo } from '../shared/content';
import { resultCategories, resultCategory } from '../shared/result-model';

export function ResultCategoryFilter({ items, value, onChange, label, disabled = false }: { items: { title: string; category?: string; kind?: string }[]; value: string; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  const options = resultCategories.map(category => ({ value: category, label: contributionCategoryInfo[category].label, count: items.filter(item => resultCategory(item) === category).length }));
  const files = items.filter(item => item.kind && item.kind !== 'contribution').length;
  const choose = (next: string) => onChange(value === next ? 'all' : next);
  return <nav className="result-category-tabs" aria-label={label}>
    <button type="button" aria-pressed={value === 'all'} disabled={disabled && value !== 'all'} onClick={() => onChange('all')}>全部<span>{items.length}</span></button>
    {options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} disabled={disabled && value !== option.value} onClick={() => choose(option.value)}>{option.label}<span>{option.count}</span></button>)}
    {!!files && <button type="button" aria-pressed={value === 'files'} disabled={disabled && value !== 'files'} onClick={() => choose('files')}>共享文件<span>{files}</span></button>}
  </nav>;
}
