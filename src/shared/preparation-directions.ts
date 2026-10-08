import { z } from 'zod';
import type { ContributionCategory } from './content';
import { materialCategorySchema, type MaterialCategory } from './result-rules';

export const preparationDirectionLimit = 4000;
export const defaultPreparationDirections = {
  capability: '记录本项目已经实现的具体能力：能做什么、使用前提、实际验证范围和仍然受限的部分。对照同对象、同环境、同范围的当前能力，仅保留新增或纠正；证据不足时保留验证边界，不把单项改动扩大成项目整体可用。',
  exploration: '围绕本项目的具体问题，记录尝试的方法、选择理由、实际观察和证据，包括失败与相互矛盾的结果。同一探索的方法、效果及限制写在一条里；区分事实、推测与未验证假设，不把局部观察写成最终定论。沿用相关历史记录中的对象名称和问题粒度。',
  todo: '提取本项目尚未完成、可以独立推进的动作、缺陷或待确认问题。每条说明要做什么，以及已知的完成判断；负责人、依赖和时限只采用明确提供的信息。对照当前及已完成事项，避免重复新增；独立事项逐条保留，不擅自完成、取消或合并已有任务。',
} as const;
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
