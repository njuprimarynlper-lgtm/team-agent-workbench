import React from 'react';

export function EgressRouteChoice({ value, onChange, disabled = false }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <div className="egress-route-choice">
    <label className="check-row"><input type="checkbox" checked={value} disabled={disabled} onChange={event => onChange(event.target.checked)}/><b>经共享服务器中转</b></label>
    <small>{value ? '本机 → 已登录的共享服务器 → 管理端。复用 SSH 端口，无需新增共享服务器端口。' : '本机直接连接管理端；无法直达管理端时可启用中转。'}</small>
  </div>;
}
