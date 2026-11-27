import { z } from 'zod';

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export { platformActionSchema, actionTools, type PlatformAction, type ActionName } from './actions.ts';
