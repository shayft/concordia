import { z } from 'zod';

export const budgetScopeSchema = z.enum(['global', 'workspace', 'member', 'connection', 'pool']);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const budgetCapsSchema = z
  .strictObject({
    maxCalls: positive.optional(),
    maxTokens: positive.optional(),
    maxConcurrent: positive.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少指定一项上限');
export type BudgetScope = z.infer<typeof budgetScopeSchema>;
export type BudgetLimit = z.infer<typeof budgetCapsSchema> & { scope: BudgetScope; id: string };
export interface BudgetUsage {
  scope: BudgetScope;
  id: string;
  calls: number;
  tokens: number;
  active: number;
}
export interface BudgetReport {
  limits: BudgetLimit[];
  usage: BudgetUsage[];
}
