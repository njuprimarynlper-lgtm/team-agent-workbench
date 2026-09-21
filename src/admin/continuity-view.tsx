import React from 'react';
import type { AdminOperation, AdminState } from './types';
import { continuityImpact } from './continuity';
export function ContinuityChoices({ state, operation, choices, change }: { state?: AdminState; operation: Partial<AdminOperation>; choices: Record<string, string | null>; change: (value: Record<string, string | null>) => void }) {
  const groups = continuityImpact(state, operation); if (!state || !groups.length) return null;
  return <div className="callout" role="status"><div><b>此操作将移除最后一位组管理员</b>{groups.map(group => <label className="field" key={group}>{state.groups[group]?.label} · 接任安排<select aria-label={state.groups[group]?.label + ' 接任安排'} value={Object.hasOwn(choices, group) ? choices[group] === null ? '__vacant__' : choices[group]! : ''} onChange={e => { const next = { ...choices }; if (!e.target.value) delete next[group]; else next[group] = e.target.value === '__vacant__' ? null : e.target.value; change(next); }}><option value="">请选择</option>{Object.values(state.users).filter(u => u.enabled && !u.missing && !u.provisioning && u.groups?.includes(group) && !('username' in operation && u.username === operation.username)).map(u => <option value={u.username} key={u.username}>{u.name || u.username}</option>)}<option value="__vacant__">明确保留空缺，稍后指定</option></select></label>)}</div></div>;
}
