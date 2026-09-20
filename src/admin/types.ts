import { z } from 'zod';
import { accountNameSchema, accountPasswordSchema } from '../shared/accounts';
import { groupLabelMessage, groupLabelPattern } from '../shared/groups';
export const adminProfileSchema = z.object({
  mode: z.enum(['sftp', 'local']).optional(), localRoot: z.string().optional(),
  host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535),
  username: z.string().max(64).default(''), fingerprint: z.string().default(''),
  root: z.string().regex(/^\/(?:[^\x00\r\n\\/]+\/)+[^\x00\r\n\\/]+$/).default('/srv/teamspace'),
}).refine(profile => profile.mode === 'local' || !!profile.username.trim(), { path: ['username'], message: '请输入服务器管理账号' });
export const adminConnectSchema = z.object({
  profile: adminProfileSchema, password: z.string().max(4096).default(''), sudoPassword: z.string().max(4096).default(''),
}).refine(input => input.profile.mode === 'local' || !!input.password, { path: ['password'], message: '请输入服务器登录密码' });
export type AdminProfile = z.infer<typeof adminProfileSchema>;
export type ManagedUser = { username: string; systemUsername?: string; name: string; enabled: boolean; uid?: number; groups?: string[]; contentAdminGroups?: string[]; missing?: boolean; provisioning?: boolean };
export type ManagedGroup = AdminState['groups'][string];
export type AdminJob = { id: string; op: string; request: Record<string, any>; status: 'running' | 'failed' | 'done'; completed: string[]; error?: string };
export type AdminState = { initialized: boolean; bootstrapPending?: boolean; operations?: Record<string, AdminJob>; storageVersion?: number; teamId?: string; loginGroup?: string; sftpConfigured?: boolean; users: Record<string, ManagedUser>; groups: Record<string, { name: string; label: string; adminGroup: string; workspace?: string; provisioning?: boolean }> };
export type AdminSnapshot = { profile?: AdminProfile; connectionError?: string; connected: boolean; verified: boolean; busy: boolean; actor?: string; role?: 'administrator' | 'project_admin'; contentGroups?: { id: string; name: string }[]; state?: AdminState; missingCommands?: string[] };
export const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, '系统组名需以小写字母开头，最多 32 位，可包含数字、下划线和短横线');
// Normalize before checking so the value that travels to the server is the one that was validated.
export const groupLabelSchema = z.string().max(48).transform(value => value.normalize('NFC')).refine(value => groupLabelPattern.test(value), groupLabelMessage);
const password = accountPasswordSchema;
export const adminOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }), z.object({ op: z.literal('initialize') }),
  z.object({ op: z.literal('user_create'), username: accountNameSchema, name: z.string().max(120), password, groups: z.array(nameSchema).optional(), contentAdminGroups: z.array(nameSchema).optional() }),
  z.object({ op: z.literal('recover'), operationId: z.string().min(1).max(160), password: password.optional() }),
  z.object({ op: z.literal('user_password'), username: accountNameSchema, password }),
  z.object({ op: z.literal('user_enabled'), username: accountNameSchema, enabled: z.boolean() }),
  z.object({ op: z.literal('workspace_prepare'), group: nameSchema }),
  z.object({ op: z.literal('group_create'), label: groupLabelSchema }),
  z.object({ op: z.literal('user_groups'), username: accountNameSchema, groups: z.array(nameSchema).max(100), contentAdminGroups: z.array(nameSchema).max(100).default([]) }),
  z.object({ op: z.literal('group_member'), username: accountNameSchema, group: nameSchema, role: z.enum(['member', 'admin', 'remove']) }),
]).and(z.object({ handoffs: z.record(z.string(), accountNameSchema.nullable()).optional() }));
export type AdminOperation = z.infer<typeof adminOperationSchema>;
