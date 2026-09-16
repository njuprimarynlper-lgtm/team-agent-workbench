import { z } from 'zod';
export const adminProfileSchema = z.object({
  mode: z.enum(['sftp', 'local']).optional(), localRoot: z.string().optional(),
  host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(64), fingerprint: z.string().default(''),
  root: z.string().regex(/^\/(?:[^\x00\r\n\\/]+\/)+[^\x00\r\n\\/]+$/).default('/srv/teamspace'),
});
export type AdminProfile = z.infer<typeof adminProfileSchema>;
export type ManagedUser = { username: string; name: string; enabled: boolean; uid?: number; groups?: string[]; contentAdminGroups?: string[]; missing?: boolean; provisioning?: boolean };
export type ManagedGroup = AdminState['groups'][string];
export type AdminJob = { id: string; op: string; request: Record<string, any>; status: 'running' | 'failed' | 'done'; completed: string[]; error?: string };
export type AdminState = { initialized: boolean; bootstrapPending?: boolean; operations?: Record<string, AdminJob>; teamId?: string; loginGroup?: string; sftpConfigured?: boolean; users: Record<string, ManagedUser>; groups: Record<string, { name: string; label: string; adminGroup: string; workspace?: string; provisioning?: boolean }> };
export type AdminSnapshot = { profile?: AdminProfile; connected: boolean; verified: boolean; busy: boolean; actor?: string; role?: 'administrator' | 'project_admin'; contentGroups?: { id: string; name: string }[]; state?: AdminState; missingCommands?: string[] };
export const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const password = z.string().min(8).max(4096).regex(/^[^\r\n\x00:]+$/);
export const adminOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }), z.object({ op: z.literal('initialize') }), z.object({ op: z.literal('configure_sftp') }),
  z.object({ op: z.literal('user_create'), username: nameSchema, name: z.string().max(120), password, groups: z.array(nameSchema).optional(), contentAdminGroups: z.array(nameSchema).optional() }),
  z.object({ op: z.literal('recover'), operationId: z.string().min(1).max(160), password: password.optional() }),
  z.object({ op: z.literal('user_password'), username: nameSchema, password }),
  z.object({ op: z.literal('user_enabled'), username: nameSchema, enabled: z.boolean() }),
  z.object({ op: z.literal('workspace_prepare'), group: nameSchema }),
  z.object({ op: z.literal('group_create'), label: z.string().regex(/^[a-z][a-z0-9_-]{0,13}$/) }),
  z.object({ op: z.literal('user_groups'), username: nameSchema, groups: z.array(nameSchema).max(100), contentAdminGroups: z.array(nameSchema).max(100).default([]) }),
  z.object({ op: z.literal('group_member'), username: nameSchema, group: nameSchema, role: z.enum(['member', 'admin', 'remove']) }),
]);
export type AdminOperation = z.infer<typeof adminOperationSchema>;
