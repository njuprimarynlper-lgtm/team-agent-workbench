import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { BetaFeature, BetaFeatureSettings } from '../shared/types';

export function betaFeatureStates(features: BetaFeatureSettings = {}) {
  return {
    sessionHandoff: !!features.sessionHandoff,
    subsessions: !!(features.subsessions ?? features.sessionHandoff),
  };
}

export function BetaFeaturesModal({ features, close, changed }: { features: BetaFeatureSettings; close: () => void; changed: () => Promise<void> }) {
  const [desired, setDesired] = useState(() => betaFeatureStates(features));
  const [busy, setBusy] = useState<BetaFeature>();
  const [error, setError] = useState('');
  useEffect(() => setDesired(betaFeatureStates(features)), [features.sessionHandoff, features.subsessions]);

  const toggle = async (feature: BetaFeature, enabled: boolean) => {
    setDesired(current => ({ ...current, [feature]: enabled }));
    setBusy(feature);
    setError('');
    try {
      await window.workbench.call('beta.set', { feature, enabled });
      await changed();
    } catch (reason: any) {
      setError(reason.message);
      setDesired(betaFeatureStates(features));
    } finally { setBusy(undefined); }
  };

  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="beta-features-title">
    <header><h2 id="beta-features-title">Beta 功能</h2><button className="icon" aria-label="关闭窗口" onClick={close}><X size={19}/></button></header>
    <div className="modal-body">
      <p className="muted small">两个试用功能可分别开启或关闭，设置只作用于当前团队账号。</p>
      <div className="beta-feature"><div><strong>跨会话引用</strong><span className="badge">Beta</span>
        <p>引用同项目其他会话的阶段摘要，由你选择何时发送给 AI。</p>
        <p className="muted small">引用个人会话内容后，轨迹自动上传会关闭；如需共享轨迹，请先核对内容再手动上传。</p>
      </div><label className="beta-feature-toggle"><input type="checkbox" role="switch" aria-label="开启跨会话引用" checked={desired.sessionHandoff} disabled={!!busy} onChange={event => void toggle('sessionHandoff', event.target.checked)}/><span>{desired.sessionHandoff ? '已开启' : '未开启'}</span></label></div>
      <div className="beta-feature"><div><strong>Subsession</strong><span className="badge">Beta</span>
        <p>从当前会话派生独立工作会话；子会话回报经你查看和选入后，才会发送给父会话的 AI。</p>
        <p className="muted small">关闭后不能新建 Subsession 或回报；已创建的子会话和已有回报保留。</p>
      </div><label className="beta-feature-toggle"><input type="checkbox" role="switch" aria-label="开启 Subsession" checked={desired.subsessions} disabled={!!busy} onChange={event => void toggle('subsessions', event.target.checked)}/><span>{desired.subsessions ? '已开启' : '未开启'}</span></label></div>
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div><footer><button className="primary" disabled={!!busy} onClick={close}>完成</button></footer>
  </section></div>;
}
