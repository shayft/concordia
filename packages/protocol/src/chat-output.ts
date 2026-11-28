import { z } from 'zod';

export const chatOutputField = z.enum(['max_completion_tokens', 'max_tokens']);
export type ChatOutputField = z.infer<typeof chatOutputField>;
export const maxOutputTokens = z.number().int().min(1).max(65_536);

export function chatOutputLimit(field?: ChatOutputField, limit?: number) {
  return { [chatOutputField.parse(field ?? 'max_completion_tokens')]: maxOutputTokens.parse(limit ?? 1024) };
}
