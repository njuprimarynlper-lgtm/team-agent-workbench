import { z } from 'zod';

export const draftDeleteBatchLimit = 100;
export const draftDeleteIdsSchema = z.array(z.string().uuid()).min(1).max(draftDeleteBatchLimit).transform(ids => [...new Set(ids)]);
export interface DraftDeleteResult {
  deletedIds: string[];
  failures: { id: string; message: string }[];
}
