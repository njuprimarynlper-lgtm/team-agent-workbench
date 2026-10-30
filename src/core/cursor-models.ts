import type { ModelOption } from '../shared/types';
import type { AgentRpc } from './rpc';

// The text `models` command reports legacy slugs. Modern ACP accepts either
// base model ids (parameterized picker) or exploded variant ids, not both.
// New selections use the ACP base-model catalog; keep saved explicit variants.
export function cursorClientCapabilities(model?: string) {
  return { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    _meta: { parameterizedModelPicker: !model?.includes('[') } };
}

export function cursorThoughtLevel(configOptions: any) {
  if (!Array.isArray(configOptions)) return;
  const candidates = configOptions.filter(item => item?.category === 'thought_level' && item.type === 'select' && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128);
  if (candidates.length !== 1) return; // Do not conflate multiple independent controls.
  const item = candidates[0];
  if (!Array.isArray(item.options)) return;
  const options = [...new Map<string, { id: string; name?: string }>(item.options.filter((option: any) => typeof option?.value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(option.value))
    .map((option: any) => [option.value, { id: option.value, ...(typeof option.name === 'string' ? { name: option.name.slice(0, 100) } : {}) }] as [string, { id: string; name?: string }])).values()];
  if (!options.length) return;
  return { id: item.id, options, current: options.some(option => option.id === item.currentValue) ? item.currentValue as string : undefined };
}

export async function applyCursorReasoningEffort(rpc: AgentRpc, sessionId: string, model: string | undefined, effort: string, sessionState: any) {
  if (model?.includes('[')) throw new Error('请先选择基础模型，再单独选择思考强度；当前模型名已包含参数。');
  const modelId = model || sessionState.models?.currentModelId;
  if (!modelId) throw new Error('请先选择 Cursor 模型，再设置思考强度。');
  // Unlike set_model, set_config_option returns the new model's parameters.
  // Read them after switching: different models may use different native ids.
  let state: any;
  try { state = await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: modelId }); }
  catch (error: any) { if (error.code === -32601) throw new Error('当前 Cursor CLI 不支持单独设置思考强度，请更新 CLI 后重试。'); throw error; }
  const thought = cursorThoughtLevel(state.configOptions);
  if (!thought?.options.some(option => option.id === effort)) throw new Error('当前 Cursor 模型不支持所选思考强度，请打开模型选项重新选择或清除该设置；本次消息未发送。');
  const applied = await rpc.request('session/set_config_option', { sessionId, configId: thought.id, value: effort });
  if (cursorThoughtLevel(applied.configOptions)?.current !== effort) throw new Error('Cursor 未确认思考强度已生效，本次消息未发送，请重试。');
}

export function cursorAcpModels(result: any): ModelOption[] {
  if (!Array.isArray(result?.models)) throw new Error('无法识别 Cursor 会话模型列表');
  const models = new Map<string, ModelOption>();
  for (const item of result.models) {
    if (typeof item?.value !== 'string' || !item.value.trim() || item.value.length > 300 || /[\x00-\x1f]/.test(item.value)) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : item.value;
    const thought = cursorThoughtLevel(item.configOptions);
    models.set(item.value, { id: item.value, name, ...(thought ? { reasoningEfforts: thought.options, ...(thought.current ? { defaultReasoningEffort: thought.current } : {}) } : {}) });
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
      : `Cursor 拒绝了${({ initialize: '连接初始化', authenticate: '账号验证', 'session/new': '创建会话', 'session/load': '恢复会话', 'session/set_model': '模型设置', 'session/set_config_option': '模型或思考强度设置', 'session/set_mode': '模式设置', 'session/prompt': '本次消息' } as Record<string, string>)[e.method || ''] || '本次请求'}的参数。请更新 Cursor CLI 后重试；已有对话保留。`;
  return Object.assign(new Error(message, { cause: error }), { code: e.code, method: e.method, data: e.data });
}
