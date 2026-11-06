import type { AgentRpc } from './rpc';
import type { AgentSession, Message } from '../shared/types';

const unsupported = (error: any) => error?.code === -32601 || /unknown method|unknown variant .thread\/|method not found/i.test(error?.message || '');

export async function revertLastCodexTurn(rpc: Pick<AgentRpc, 'request'>, session: AgentSession, message: Message, prepare: () => Promise<void>, check: () => void) {
  const threadId = session.nativeId!;
  const receipt = session.turnTimings?.findLast(timing => timing.userMessageId === message.id)?.nativeTurnId;
  const itemId = message.nativeItemId || message.id.replace(/^native:/, '');
  const readTarget = async () => {
    const metadata = (await rpc.request('thread/read', { threadId })).thread;
    if (metadata?.id !== threadId || !['idle', 'notLoaded'].includes(metadata?.status?.type)) throw Error('原生会话正在运行或状态未知，请刷新后编辑');
    let turn;
    try { turn = (await rpc.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' })).data?.[0]; }
    catch (error) {
      if (!unsupported(error)) throw error;
      turn = (await rpc.request('thread/read', { threadId, includeTurns: true })).thread?.turns?.at(-1);
    }
    const inputs = turn?.items?.filter((item: any) => item.type === 'userMessage');
    const first = inputs?.[0], plain = first?.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    const capabilities = first?.content?.filter((part: any) => part.type === 'skill' || part.type === 'mention');
    if (capabilities?.length && capabilities.length !== message.context?.capabilities?.length) throw Error('此轮包含无法完整恢复的原生能力引用');
    if (!turn?.id || !['completed', 'interrupted', 'failed'].includes(turn.status) || inputs?.length !== 1
      || (receipt ? turn.id !== receipt : first.id !== itemId) || plain !== message.text
      || first.content.some((p: any) => !['text','skill','mention'].includes(p.type))) throw Error('最后一轮已变化，或原始输入无法完整还原。请刷新会话后重试');
    return turn.id;
  };
  const beforeTurnId = await readTarget();
  await prepare();
  if (await readTarget() !== beforeTurnId) throw Error('编辑期间原生会话已变化');
  check();
  let result;
  try { result = await rpc.request('thread/revert', { threadId, beforeTurnId }); }
  catch (error) {
    if (!unsupported(error)) throw error;
    // The older count-based operation has no target ID. Only use it for a privately owned thread.
    if (session.codexDesktop || session.codexRemote || session.nativeLive) throw Error('当前共享会话需要支持按轮次回退的 Codex CLI');
    if (await readTarget() !== beforeTurnId) throw Error('原生轮次已改变');
    check();
    result = await rpc.request('thread/rollback', { threadId, numTurns: 1 });
  }
  if (result?.thread?.id !== threadId) throw Error('未能确认原生会话已回退，请核对对话后恢复编辑稿');
}
