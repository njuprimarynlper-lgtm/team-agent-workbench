import { z } from 'zod';
import type { ContributionCategory } from './content';
import { materialCategorySchema, type MaterialCategory } from './result-rules';

export const preparationDirectionLimit = 4000;
export const preparationDirectionsSchema = z.partialRecord(materialCategorySchema, z.string().trim().max(preparationDirectionLimit, '每类整理方向最多 4000 字'));
export type PreparationDirections = z.infer<typeof preparationDirectionsSchema>;

// Only selected, nonblank directions enter the frozen task or its prompt.
export function selectedPreparationDirections(categories: readonly ContributionCategory[], input: unknown): PreparationDirections {
  const parsed = preparationDirectionsSchema.parse(input ?? {});
  return Object.fromEntries(categories.flatMap(category => {
    const direction = parsed[category as MaterialCategory];
    return direction ? [[category, direction]] : [];
  }));
}
