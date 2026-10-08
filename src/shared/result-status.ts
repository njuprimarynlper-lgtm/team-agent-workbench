import { z } from 'zod';
export const resultStatusSchema = z.enum(['pending', 'confirmed', 'available', 'limited', 'in_progress', 'pending_review', 'completed', 'cancelled']);
export type ResultStatus = z.infer<typeof resultStatusSchema>;
