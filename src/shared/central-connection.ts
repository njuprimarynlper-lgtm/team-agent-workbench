export function needsCentralConnection(input: string | { recovery?: string; failure?: { recovery?: string }; message?: string }) {
  if (typeof input !== 'string' && (input.failure?.recovery || input.recovery) === 'reconnect-central') return true;
  const message = typeof input === 'string' ? input : input.message || '';
  // Keep native agent/CLI recovery separate from the central node connection.
  if (/^(?:连接已断开，请重新登录后再试|此连接已经断开，请重新登录)$/.test(message)) return true;
  return /中央节点|共享服务器|共享连接|团队连接|(?:团队|成员)账号/.test(message)
    && /断开|未连接|尚未连接|请先连接|请先登录|重新连接|重新登录|连不上|还没连上|重试连接/.test(message);
}
