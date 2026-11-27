import { platformActionSchema, type ActionName } from '@concordia/protocol';
import { z } from 'zod';
import { CliDiagnosticError } from './errors.ts';
import type { ExecutionMcpServer } from './mcp.ts';

const list = z.array(platformActionSchema).min(1).max(32);
const envelope = z.union([z.strictObject({ actions:list }),list,platformActionSchema]);

export async function applyFinalActions(server: ExecutionMcpServer, executionId: string, token: string,
  text: string, allowed: Set<ActionName>) {
  let decoded: unknown;
  try { decoded = JSON.parse(text.trim()); } catch { throw new CliDiagnosticError('CLI 最终动作不是 JSON。'); }
  const parsed = envelope.safeParse(decoded);
  if (!parsed.success) throw new CliDiagnosticError('CLI 最终动作格式无效。');
  const data = parsed.data;
  const actions = Array.isArray(data) ? data : 'actions' in data ? data.actions : [data];
  if (actions.some(a => !allowed.has(a.type)) || actions.slice(0,-1).some(a=>a.type==='submit_result')) {
    throw new CliDiagnosticError('CLI 最终动作超出授权或顺序错误。','permission');
  }
  const request = (id: number, method:string, params:unknown) => server.handle({
    executionId,authorization:'Bearer '+token,body:{jsonrpc:'2.0',id,method,params},
  });
  await request(0,'initialize',{protocolVersion:'2025-11-25'});
  for (const [index,action] of actions.entries()) {
    const {type,...args}=action;
    const response=await request(index+1,'tools/call',{name:type,arguments:args});
    const accepted = z.object({ result:z.object({isError:z.literal(false).optional()}) }).safeParse(response.body);
    if (response.status!==200 || !accepted.success) throw new CliDiagnosticError('当前执行或角色拒绝该动作。','permission');
  }
}
