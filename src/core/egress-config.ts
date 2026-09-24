import { z } from 'zod';
import type { AdminEgressConfig, EgressInvite, UserEgressSettings } from '../shared/egress';

const host = z.string().trim().min(1).max(255).regex(/^[^\s/\\\x00]+$/, '请输入有效的主机名或 IP 地址');
const port = z.number().int().min(1).max(65535);
export const fingerprintSchema = z.string().trim().transform(value => value.toUpperCase().replace(/^SHA256:/, '').replace(/:/g, '')).refine(value => /^[A-F0-9]{64}$/.test(value), '证书指纹格式无效');

export const adminEgressConfigSchema: z.ZodType<AdminEgressConfig> = z.object({
  enabled: z.boolean().default(false),
  listenHost: z.string().trim().min(1).max(255).default('0.0.0.0'),
  listenPort: port.default(18443),
  publicHost: host,
  upstreamMode: z.enum(['direct', 'http', 'socks5']).default('direct'),
  upstreamHost: z.string().trim().max(255).default(''),
  upstreamPort: z.number().int().min(0).max(65535).default(0),
  upstreamUsername: z.string().max(512).default(''),
  codex: z.boolean().default(true),
  cursor: z.boolean().default(true),
  claude: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.upstreamMode !== 'direct' && (!value.upstreamHost || !value.upstreamPort)) context.addIssue({ code: 'custom', path: ['upstreamHost'], message: '请输入上游代理地址和端口' });
  if (!value.codex && !value.cursor && !value.claude) context.addIssue({ code: 'custom', path: ['codex'], message: '至少启用一种 CLI' });
});

export const sharedServerRouteSchema = z.object({ host, port, fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/), relayPort: port });
export const userEgressSettingsSchema: z.ZodType<UserEgressSettings> = z.object({
  enabled: z.boolean().default(false), viaSharedServer: z.boolean().default(false), host, port, certificateFingerprint: fingerprintSchema,
  sharedServer: sharedServerRouteSchema.optional(),
});

export const userEgressInputSchema = z.object({ enabled: z.boolean(), viaSharedServer: z.boolean().optional(), inviteCode: z.string().max(4096).optional() });

const inviteFields = { host, port, fingerprint: fingerprintSchema, accessCode: z.string().min(24).max(512) };
const inviteSchema: z.ZodType<EgressInvite> = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...inviteFields }),
  z.object({ version: z.literal(2), ...inviteFields, sharedServer: sharedServerRouteSchema }),
]);

export function encodeEgressInvite(invite: EgressInvite) {
  return `TAE${invite.version}.` + Buffer.from(JSON.stringify(invite), 'utf8').toString('base64url');
}

export function decodeEgressInvite(value: string): EgressInvite {
  const clean = value.trim();
  if (!/^TAE[12]\./.test(clean) || clean.length > 4096) throw new Error('接入码格式无效，请确认已使用新版用户端');
  try { const invite = inviteSchema.parse(JSON.parse(Buffer.from(clean.slice(5), 'base64url').toString('utf8'))); if (clean[3] !== String(invite.version)) throw new Error(); return invite; }
  catch { throw new Error('接入码无效或内容不完整，请从管理端重新复制'); }
}
