import { z } from 'zod';
import { modelPricingSchema } from './pricing.ts';
import { actionTools } from './actions.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const label = z.string().trim().min(1).max(256);
const credentialRef = z.string().regex(/^keychain:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const count = z.number().int().min(1).max(1024);
const common = { id, name: label, enabled: z.boolean().default(true) };
const params = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
});
export const apiKinds = ['chat-completions', 'responses', 'gemini', 'anthropic'] as const;
export const cliKinds = ['claude', 'codex'] as const;
const base = {
  ...common,
  poolId: id.optional(),
  maxConcurrent: count.default(1),
};
function safeBaseUrl(raw: string) {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
    !url.username && !url.password && !url.search && !url.hash;
}
export const connectionSchema = z.union([
  z.strictObject({
    ...base, kind: z.enum(apiKinds), baseUrl: z.string().max(2048).refine(safeBaseUrl),
    credentialRef: credentialRef.optional(),
    headerRefs: z.record(z.string().regex(/^x-[a-z0-9-]+$/iu).refine(name =>
      !/forwarded|host|url/i.test(name) && !['x-api-key', 'x-goog-api-key'].includes(name.toLowerCase())),
      credentialRef).refine(refs => Object.keys(refs).length <= 16).optional(),
    endpoint: z.string().min(1).max(2048).regex(/^[^?#\\]+$/u).optional(),
    timeoutMs: z.number().int().min(1).max(2147483647).optional(),
    maxOutputTokens: z.number().int().positive().max(65536).optional(),
    params: params.optional(),
  }),
  z.strictObject({
    ...base, kind: z.enum(cliKinds), actionChannel: z.enum(['mcp', 'json']).optional(),
    executable: z.string().min(1).max(4096).optional(),
    cwd: z.string().min(1).max(4096).optional(),
  }),
]);
// Existing records from an older catalog remain readable for migration and deletion.
export const writableConnectionSchema = connectionSchema.refine(c => !c.id.startsWith('mock-'), 'mock- 为模拟连接保留前缀');
export const catalogModelSchema = z.strictObject({
  pricing: modelPricingSchema.optional(),
  ...common, connectionId: id, modelId: z.string().trim().min(1).max(512), params: params.optional(),
  toolMode: z.enum(['native', 'json']).default('native'),
});
export const memberSchema = z.strictObject({
  ...common, role: label, connectionId: id, modelId: id.optional(),
  systemPrompt: z.string().max(12000).optional(), reportsTo: id.optional(),
  allowedActions: z.array(z.enum(actionTools.map(tool => tool.name))).max(actionTools.length)
    .refine(items => new Set(items).size === items.length).optional(),
});
export const quotaPoolSchema = z.strictObject({ id, name: label, maxConcurrent: count });
export const catalogSchema = z.strictObject({
  connections: z.array(connectionSchema), models: z.array(catalogModelSchema),
  members: z.array(memberSchema), pools: z.array(quotaPoolSchema),
});
export const inspectConnectionSchema = z.strictObject({
  modelId: id.optional(), confirmUnmanaged: z.boolean().optional(),
});
export const testConnectionSchema = inspectConnectionSchema.extend({
  approved: z.literal(true), inspectionId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
export type Connection = z.infer<typeof connectionSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type Member = z.infer<typeof memberSchema>;
export type QuotaPool = z.infer<typeof quotaPoolSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
