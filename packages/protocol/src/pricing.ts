import { z } from 'zod';

const rate = z.number().finite().nonnegative();
export const modelPricingSchema = z
  .strictObject({
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    inputPerMillion: rate.optional(),
    outputPerMillion: rate.optional(),
  })
  .refine(
    (value) => value.inputPerMillion !== undefined || value.outputPerMillion !== undefined,
    '至少提供一个方向的单价。',
  );
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export interface ModelSnapshot {
  modelId: string;
  pricing?: ModelPricing;
}
export interface ExecutionCost {
  id: string;
  taskId: string;
  connection: string;
  started: number;
  modelId: string | null;
  pricing: ModelPricing | null;
  inputTokens: number | null;
  outputTokens: number | null;
  amount: number | null;
}
