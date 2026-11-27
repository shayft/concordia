import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const message = z.string().trim().min(1).max(32_768);
export const actionVariants = [
  z.strictObject({ type: z.literal('create_task'), taskId: id, assignee: id, description: message }),
  z.strictObject({ type: z.literal('assign_task'), taskId: id, assignee: id }),
  z.strictObject({ type: z.literal('publish_artifact'), slotId: id, content: message,
    incompatible: z.boolean().optional(), kind: z.enum(['text', 'git_commit']).optional() }),
  z.strictObject({ type: z.literal('read_artifact'), slotId: id, versionId: id.optional() }),
  z.strictObject({ type: z.literal('ask_question'), to: id, question: message, blocking: z.boolean(), replyTo: id.optional() }),
  z.strictObject({ type: z.literal('answer_question'), questionId: id, answer: message }),
  z.strictObject({ type: z.literal('send_message'), to: id, message }),
  z.strictObject({ type: z.literal('progress'), message }),
  z.strictObject({ type: z.literal('submit_result'), summary: message }),
  z.strictObject({ type: z.literal('request_review'), taskId: id }),
  z.strictObject({ type: z.literal('run_project_command'), name: id }),
] as const;

export const platformActionSchema = z.discriminatedUnion('type', actionVariants).refine(action =>
  action.type !== 'publish_artifact' || action.kind !== 'git_commit' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(action.content),
{ message: 'Git 交付物需要完整的提交标识' });

export type PlatformAction = z.infer<typeof platformActionSchema>;
export type ActionName = PlatformAction['type'];

// Both MCP and API tool definitions use these parameters; the tool name
// supplies the discriminator. The backend validates the full union again.
export const actionTools = actionVariants.map(schema => {
  const { properties, required, ...rest } = z.toJSONSchema(schema);
  const parameters = { ...rest, properties: { ...properties },
    required: (required as string[]).filter(field => field !== 'type') };
  delete parameters.properties.type;
  return { name: schema.shape.type.value, inputSchema: parameters };
});
