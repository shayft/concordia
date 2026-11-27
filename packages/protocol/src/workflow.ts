import { z } from 'zod';

const id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
  .refine((value) => !Object.hasOwn(Object.prototype, value), '标识不能使用保留名称');
const poolId = z
  .string()
  .regex(/^(?:connection:)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
  .refine((value) => !Object.hasOwn(Object.prototype, value.replace(/^connection:/, '')), '额度池名称无效');
const title = z.string().trim().min(1).max(500);
const count = z.number().int().min(1).max(1000);
const tokens = z.number().int().min(1).max(100_000_000);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(256);
export const agentSchema = z.strictObject({
  id,
  name: title,
  connection: id,
  pool: poolId.optional(),
  role: z.enum(['lead', 'member']).default('member'),
});
const inputSchema = z
  .strictObject({
    slotId: id,
    policy: z.enum(['latest', 'pinned']).default('latest'),
    version: id.optional(),
  })
  .refine(
    (entry) => (entry.policy === 'pinned') === Boolean(entry.version),
    '钉住策略须指定且仅可指定一个版本',
  );
export const taskSchema = z.strictObject({
  id,
  title,
  owner: id,
  produces: list(id).default([]),
  consumes: list(inputSchema).default([]),
  maxCalls: count.default(6),
  maxCallsPerExecution: count.optional(),
  maxTokens: tokens.optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  maxRework: z.number().int().min(0).max(20).default(1),
  maxRetries: z.number().int().min(0).max(5).default(1),
});
export const workflowSpecSchema = z
  .strictObject({
    id,
    title,
    goal: z.string().trim().min(1).max(8000),
    acceptance: list(title).min(1),
    requiredSlots: list(id).default([]),
    requiredTasks: list(id).optional(),
    maxContextTokens: z.number().int().min(32).max(128_000).optional(),
    agents: list(agentSchema).min(1),
    slots: list(z.strictObject({ id, title })).default([]),
    tasks: list(taskSchema).min(1),
    maxCalls: count.default(50),
    maxConcurrent: z.number().int().min(1).max(256).optional(),
    maxTokens: tokens.optional(),
    estimatedTokensPerCall: tokens.optional(),
    maxHops: z.number().int().min(1).max(16).default(4),
    poolLimits: z.record(poolId, z.number().int().min(1).max(1024)).default({}),
  })
  .superRefine((spec, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: string[], name: string) => {
      if (new Set(values).size !== values.length) issue(name + '重复');
      return new Set(values);
    };
    const agents = unique(
      spec.agents.map((a) => a.id),
      '成员',
    );
    if (agents.has('user') || agents.has('integration')) issue('成员标识与系统发件人冲突');
    if (spec.tasks.some((t) => t.id.startsWith('reply-'))) issue('任务编号的 reply- 前缀由答复任务使用');
    const slots = unique(
      spec.slots.map((s) => s.id),
      '槽位',
    );
    unique(
      spec.tasks.map((t) => t.id),
      '任务',
    );
    unique(spec.requiredSlots, '必需槽位');
    for (const taskId of unique(spec.requiredTasks ?? [], '必需任务'))
      if (!spec.tasks.some((t) => t.id === taskId)) issue('未知必需任务 ' + taskId);
    const producers = new Map<string, string>();
    for (const task of spec.tasks) {
      if (!agents.has(task.owner)) issue('未知负责人 ' + task.owner);
      unique(
        task.consumes.map((c) => c.slotId),
        '消费槽位',
      );
      for (const slot of task.produces) {
        if (!slots.has(slot) || producers.has(slot)) issue('产出槽位未知或有重复生产者 ' + slot);
        producers.set(slot, task.id);
      }
    }
    for (const slot of slots) if (!producers.has(slot)) issue('槽位缺少生产者 ' + slot);
    for (const slot of spec.requiredSlots) if (!slots.has(slot)) issue('未知必需槽位 ' + slot);
    const parents = new Map(
      spec.tasks.map((task) => [
        task.id,
        task.consumes.map((input) => {
          if (!slots.has(input.slotId)) issue('未知消费槽位 ' + input.slotId);
          return producers.get(input.slotId) ?? '';
        }),
      ]),
    );
    const visited = new Set<string>();
    const visiting = new Set<string>();
    function cyclic(task: string): boolean {
      if (visiting.has(task)) return true;
      if (visited.has(task)) return false;
      visiting.add(task);
      if (parents.get(task)?.some(cyclic)) return true;
      visiting.delete(task);
      visited.add(task);
      return false;
    }
    if (spec.tasks.some((task) => cyclic(task.id))) issue('任务依赖存在环');
  });
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type Agent = z.infer<typeof agentSchema>;
