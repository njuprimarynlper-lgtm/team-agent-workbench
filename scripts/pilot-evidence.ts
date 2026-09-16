import { createHash } from 'node:crypto';
export function sourceDigest(bytes: Buffer, filename: string) {
  // Git may convert LF/CRLF in text checkouts. No other whitespace is ignored.
  const content = /\.(?:txt|md|py|json)$/i.test(filename) ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes;
  return createHash('sha256').update(content).digest('hex');
}
export function completedRound(messages: { role: string; text: string }[], events: any[], round: number) {
  const user = messages.filter(m => m.role === 'user').at(-1);
  const event = events.filter(e => e.event?.method === 'turn/completed' || e.event?.direction === 'user' && typeof e.event.text === 'string').at(-1)?.event;
  return !!user?.text.includes(`这是你的第 ${round}/2 轮`) && event?.method === 'turn/completed' && event.params?.turn?.status === 'completed' && !event.params.turn.error;
}
