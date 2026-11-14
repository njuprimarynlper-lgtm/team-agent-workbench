import React from 'react';
import { Puzzle, X } from 'lucide-react';
import type { AgentCapabilitySelection } from '../shared/types';

export function CapabilityChips({ selected, change, disabled }: { selected: AgentCapabilitySelection[]; change: (items: AgentCapabilitySelection[]) => void; disabled?: boolean }) {
  return selected.length > 0 && <div className="capability-chips" aria-label="下一条消息使用的能力"><span>下一条消息</span>{selected.map(item => <button type="button" key={item.id} disabled={disabled} aria-label={'移除能力：' + item.name} title="点击移除" onClick={() => change(selected.filter(value => value.id !== item.id))}><Puzzle size={11}/>{item.name}<X size={11}/></button>)}</div>;
}
