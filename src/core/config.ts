import { z } from 'zod';
import { accountNameSchema } from '../shared/accounts';
import { remotePath, withinRemote } from './paths';
const absoluteRemote = z.string().transform(remotePath);
export const projectSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1).max(120), remoteRoot: absoluteRemote, uploadPath: absoluteRemote, historyPath: absoluteRemote, managed: z.boolean().optional(), groupName: z.string().optional(), groupLabel: z.string().optional() }).refine(p => withinRemote(p.remoteRoot, p.uploadPath) && withinRemote(p.remoteRoot, p.historyPath), '上传与历史目录必须位于项目根路径内');
export const profileSchema = z.object({ mode: z.enum(['sftp', 'local']).optional(), localRoot: z.string().optional(), id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1).max(120), host: z.string().min(1).max(255).regex(/^[^\s/\\\x00]+$/), port: z.number().int().min(1).max(65535), username: accountNameSchema, fingerprint: z.string().default(''), manifestPath: z.string().default(''), projects: z.array(projectSchema).max(200), workPath: z.string().default('') });
export const settingsSchema = z.object({ connections: z.array(profileSchema).max(50), providerPaths: z.object({ codex: z.string(), cursor: z.string() }), lastWorkspace: z.string(), localWorkspace: z.string().default(''), verifiedLocalWorkspace: z.string().optional() });
export const manifestSchema = z.object({ version: z.literal(1), projects: z.array(projectSchema).max(200) }).refine(x => new Set(x.projects.map(p => p.id)).size === x.projects.length, '项目 ID 不能重复');
