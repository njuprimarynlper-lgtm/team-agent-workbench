import type { ModelOption } from '../shared/types';

// The text `models` command reports legacy slugs. Modern ACP accepts either
// base model ids (parameterized picker) or exploded variant ids, not both.
// New selections use the ACP base-model catalog; keep saved explicit variants.
export function cursorClientCapabilities(model?: string) {
  return { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    _meta: { parameterizedModelPicker: !model?.includes('[') } };
}

export function cursorAcpModels(result: any): ModelOption[] {
  if (!Array.isArray(result?.models)) throw new Error('无法识别 Cursor 会话模型列表');
  const models = new Map<string, ModelOption>();
  for (const item of result.models) {
    if (typeof item?.value !== 'string' || !item.value.trim() || item.value.length > 300 || /[\x00-\x1f]/.test(item.value)) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : item.value;
    models.set(item.value, { id: item.value, name });
  }
  return [...models.values()];
}

export function cursorRequestError(error: unknown, model?: string): Error | undefined {
  const e = error as { code?: number; message?: unknown; data?: { message?: unknown }; method?: string } | undefined;
  if (e?.code !== -32602) return;
  // Inspect only the explanatory string. Never render raw error.data: it can
  // include request payloads, credentials or an entire validation object.
  const detail = [e.message, e.data?.message].filter(v => typeof v === 'string').join(' ');
  const modelLabel = model && model.length <= 300 && !/[\x00-\x1f]/.test(model) ? `「${model}」` : '';
  const message = /Invalid model (?:value|id)|unknown model|model.+not (?:found|available)/i.test(detail)
    ? `Cursor 当前不接受模型${modelLabel}。请刷新模型列表并重新选择后发送；已有对话保留。`
    : /Session .+ not found/i.test(detail)
      ? 'Cursor 未找到这条会话的原始记录，无法继续原上下文。请确认仍使用原来的 Cursor CLI 和本机账号；已有对话保留。'
      : `Cursor 拒绝了${({ initialize: '连接初始化', authenticate: '账号验证', 'session/new': '创建会话', 'session/load': '恢复会话', 'session/set_model': '模型设置', 'session/set_mode': '模式设置', 'session/prompt': '本次消息' } as Record<string, string>)[e.method || ''] || '本次请求'}的参数。请更新 Cursor CLI 后重试；已有对话保留。`;
  return Object.assign(new Error(message, { cause: error }), { code: e.code, method: e.method, data: e.data });
}
