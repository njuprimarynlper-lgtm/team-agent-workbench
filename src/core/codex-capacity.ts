/** Only provider capacity errors qualify, never quota, policy or generic RPC overload. */
export function isCodexCapacityError(error: unknown): boolean {
  const e: any = error;
  const text = (typeof e === 'string' ? e : [e?.message, e?.additionalDetails, e?.data?.message].filter(v => typeof v === 'string').join('\n')).slice(0, 8192);
  const info = e?.codexErrorInfo ?? e?.data?.codexErrorInfo;
  const code = e?.code ?? e?.data?.code;
  const blocked = /usage.?limit|rate.?limit|context.?window|context.?length|session.?budget|unauthorized|cyber.?policy|misalignment|bad.?request|insufficient.?quota|credit|billing|spend.?limit|flex.?unavailable|forbidden/i;
  if (code === -32001 || blocked.test(typeof info === 'string' ? info : '') || blocked.test(typeof code === 'string' ? code : '') ||
      [401, 403].includes(e?.httpStatusCode ?? e?.data?.httpStatusCode) ||
      /quota|usage.limit|credit|billing|spend.limit|context.length|context.window|authentication|unauthorized|forbidden|verification|safety|policy|额度|余额|权限/i.test(text)) return false;
  return ['serverOverloaded', 'modelCapacityExceeded'].includes(info) ||
    ['server_overloaded', 'server_is_overloaded', 'model_capacity_exceeded'].includes(code) ||
    /\b(?:model\b[^\n]{0,160}(?:capacity|overloaded)|(?:at|exceeded|reached|over)\s+(?:its\s+|the\s+)?capacity\b)|模型[^\n]{0,80}(?:容量|拥塞|繁忙)/i.test(text);
}

export type CapacityModel = { model: string; effort: string | null };
export function capacityFallbackModel(models: any[], used: Set<string>, effort?: string | null): CapacityModel | undefined {
  // Preserve catalog ordering, with its recommended default first. No hard-coded model names.
  const visible = models.filter(m => m && !m.hidden && typeof m.model === 'string' && m.model.trim() && !used.has(m.model) &&
    (!Array.isArray(m.inputModalities) || m.inputModalities.includes('text') && m.inputModalities.includes('image')));
  visible.sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
  for (const m of visible) {
    const supported = (m.supportedReasoningEfforts || []).map((e: any) => typeof e === 'string' ? e : e.reasoningEffort).filter((e: unknown) => typeof e === 'string');
    const selected = effort && supported.includes(effort) ? effort : supported.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : supported[0] ?? null;
    return { model: m.model, effort: selected };
  }
}

export interface CodexSubmission {
  params: any; messageId: string; userText: string; used: Set<string>; attempts: number; revision: number;
  progressed: boolean; rerouted: boolean; recovering: boolean; cancelled?: boolean;
  pendingError?: unknown; errorTimer?: ReturnType<typeof setTimeout>;
}
