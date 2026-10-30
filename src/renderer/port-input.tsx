import React, { useEffect, useState } from 'react';

export const validPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

/** Keep the editing text: Number('') is 0, but the field must stay empty. */
export function PortInput({ value, onChange, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value || ''));
  useEffect(() => { setDraft(current => Number(current) === value ? current : String(value || '')); }, [value]);
  return <input {...props} type="text" inputMode="numeric" pattern="[0-9]*" value={draft} aria-invalid={!validPort(value)} onChange={event => {
    const text = event.target.value;
    if (!/^\d*$/.test(text)) return;
    setDraft(text); onChange(Number(text));
  }}/>;
}
