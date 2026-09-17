import { z } from 'zod';
export const gitRevisionSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), branch: z.string().max(256), dirty: z.boolean(), capturedAt: z.string() });
export type GitRevision = z.infer<typeof gitRevisionSchema>;
export const contentMetadataSchema = z.object({ title: z.string().max(200).default(''), description: z.string().max(2 * 1024 * 1024).default(''), repoUrl: z.string().max(2048).optional(), git: gitRevisionSchema.optional(), kind: z.enum(['contribution', 'file', 'trajectory']).default('file'), sourceSessionId: z.string().optional() });
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export interface SharedContent extends ContentMetadata { id: string; path: string; author: string; revision: number; state: 'submitted' | 'curated'; createdAt: string; updatedAt: string; updatedBy: string; sha256: string; size: number; sources?: string[]; }
export const contentEditSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), action: z.enum(['save', 'delete']), title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2 * 1024 * 1024).optional(), repoUrl: z.string().max(2048).optional(), curate: z.boolean().default(false), merge: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })).max(100).default([]) });
export type ContentEdit = z.infer<typeof contentEditSchema>;
