import { randomBytes, timingSafeEqual } from 'node:crypto';
import { actionTools, platformActionSchema, type PlatformAction } from '@concordia/protocol';
import { z } from 'zod';

type RpcId = number | string;
interface McpReply { status: number; body?: unknown }
interface McpRequest { executionId: string; authorization?: string; protocolVersion?: string; body: unknown }
interface Lease {
  token: Buffer;
  expires: number;
  protocol?: string;
  allowed: ReadonlySet<PlatformAction['type']>;
  observe?: (action: PlatformAction) => void;
  calls: Map<RpcId, { signature: string; result: Promise<McpReply> }>;
}
const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const rpc = z.object({
  jsonrpc: z.literal('2.0'), method: z.string(), id: z.union([z.string(), z.number().int()]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
function rpcReply(id: RpcId, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}
function rpcError(id: RpcId | null, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export class ExecutionMcpServer {
  private leases = new Map<string, Lease>();
  constructor(
    private readonly dispatch: (executionId: string, action: PlatformAction) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  open(executionId: string, observe?: (action: PlatformAction) => void, allowed?: ReadonlySet<PlatformAction['type']>): string {
    if (this.leases.has(executionId)) throw new Error('执行已经拥有动作通道');
    const token = randomBytes(32);
    this.leases.set(executionId, { token, expires: this.now() + 180_000, calls: new Map(), observe, allowed: new Set(allowed) });
    return token.toString('hex');
  }

  initialized(executionId: string) { return !!this.leases.get(executionId)?.protocol; }

  close(executionId: string) { this.leases.delete(executionId); }

  async handle(request: McpRequest): Promise<McpReply> {
    const lease = this.leases.get(request.executionId);
    const match = /^Bearer ([0-9a-f]{64})$/.exec(request.authorization ?? '');
    if (!lease || !match || this.now() >= lease.expires || !timingSafeEqual(lease.token, Buffer.from(match[1], 'hex'))) {
      return { status: 401 };
    }
    const parsed = rpc.safeParse(request.body);
    if (!parsed.success) return rpcError(null, -32600, '无效 JSON-RPC 请求', 400);
    const { id, method, params } = parsed.data;
    if (typeof id === 'string' && id.toLowerCase().includes(lease.token.toString('hex'))) return rpcError(null,-32600,'请求编号包含凭证',400);
    if (request.protocolVersion && !versions.includes(request.protocolVersion)) {
      return rpcError(id ?? null, -32600, '不支持的 MCP 协议版本', 400);
    }
    if (id === undefined) return method.startsWith('notifications/') ? { status: 202 } : rpcError(null, -32600, '缺少请求编号', 400);
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      lease.protocol = typeof requested === 'string' && versions.includes(requested) ? requested : versions[0];
      return rpcReply(id, { protocolVersion: lease.protocol, capabilities: { tools: {} }, serverInfo: { name: 'concordia', version: '1' } });
    }
    if (!lease.protocol) return rpcError(id, -32600, '请先初始化动作通道');
    if (request.protocolVersion && request.protocolVersion !== lease.protocol) return rpcError(id, -32600, '协议版本不一致', 400);
    if (method === 'ping') return rpcReply(id, {});
    if (method === 'tools/list') return rpcReply(id, { tools: actionTools.filter(tool => lease.allowed.has(tool.name)) });
    if (method !== 'tools/call') return rpcError(id, -32601, '未知方法');
    const args = params?.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, 'type')) {
      return rpcError(id, -32602, '动作参数无效');
    }
    const action = platformActionSchema.safeParse({ ...args, type: params?.name });
    if (!action.success) return rpcError(id, -32602, '动作参数无效');
    if (!lease.allowed.has(action.data.type)) return rpcError(id, -32602, '此动作不在执行授权范围内');
    const signature = JSON.stringify(action.data);
    if (signature.toLowerCase().includes(lease.token.toString('hex'))) return rpcError(id, -32602, '动作包含仅供传输层使用的凭证');
    const previous = lease.calls.get(id);
    if (previous) return previous.signature === signature ? previous.result : rpcError(id, -32600, '请求编号重复');
    if (lease.calls.size >= 256) return rpcError(id, -32000, '单次执行的动作上限已达');
    const result = this.dispatchOnce(request.executionId, id, lease, action.data);
    lease.calls.set(id, { signature, result });
    return result;
  }

  private async dispatchOnce(executionId: string, id: RpcId, lease: Lease, action: PlatformAction) {
    try {
      const value = await this.dispatch(executionId, action);
      if (lease !== this.leases.get(executionId) || this.now() >= lease.expires) return { status: 401 };
      const content=JSON.stringify(value ?? { accepted:true });
      if (content.toLowerCase().includes(lease.token.toString('hex'))) return rpcError(id,-32603,'动作回复包含传输凭证');
      lease.observe?.(action);
      return rpcReply(id, { content: [{ type: 'text', text: content }] });
    } catch {
      return rpcReply(id, { isError: true, content: [{ type: 'text', text: '当前执行无权执行此动作或其状态已改变。' }] });
    }
  }
}
