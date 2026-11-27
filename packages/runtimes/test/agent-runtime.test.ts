import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { CliAgentRuntime, type AgentRuntimeEvent } from '../src/agent-runtime.ts';
import { ExecutionMcpServer } from '../src/mcp.ts';
import type { CliKind } from '../src/environment.ts';
import type { PlatformAction } from '@concordia/protocol';

const fixture = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));
let kind: CliKind;
vi.mock('../src/process.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/process.ts')>();
  return { ...actual, runProcess: (executable: string, args: string[], options: Parameters<typeof actual.runProcess>[2]) =>
    actual.runProcess(executable, [fixture, kind, ...args], options) };
});

for (const family of ['claude','codex'] as const) {
  it(family + ' 从假 CLI 经本机 TCP 执行动作，隔离会话并在同任务恢复', async () => {
    kind = family;
    const directory = await mkdtemp(join(tmpdir(), 'concordia-cli-task-'));
    const calls: PlatformAction[] = [];
    const mcp = new ExecutionMcpServer(async (_id, action) => { calls.push(action); return { accepted:true }; });
    const server = createServer(async (req, res) => {
      const result = await mcp.handle({ executionId:req.url!.split('/').at(-1)!,
        authorization:req.headers.authorization, body:JSON.parse(await text(req)) });
      res.writeHead(result.status,{'content-type':'application/json'}).end(JSON.stringify(result.body));
    }).listen(0,'127.0.0.1');
    await once(server,'listening');
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('没有本机端口');
      const sessions = new Map<string,string>();
      const runtime = new CliAgentRuntime({ kind, executable:process.execPath, connectionId:'connection',confirmUnmanaged:true },mcp,sessions);
      const input = { memberId:'member', taskId:'task', executionId:'one', prompt:'带空格的输入',
        cwd:directory,permission:'read-only' as const,mcpOrigin:'http://127.0.0.1:' + addr.port };
      const collect = async (mods: Partial<typeof input>) => {
        const events: AgentRuntimeEvent[] = [];
        await runtime.run({...input,...mods}, e => events.push(e));
        const text = events.find(event => event.type === 'text_delta');
        expect(events.map(e => e.type)).toEqual(['action','text_delta','usage','completed']);
        return text!.text;
      };
      const first = await collect({});
      const again = await collect({executionId:'two'});
      const other = await collect({executionId:'three',taskId:'different'});
      expect(again).toBe(first.replace('new ', 'resumed '));
      expect(other).not.toBe(first);
      const member = await collect({executionId:'other-member',memberId:'second'});
      expect(member).not.toBe(first);
      expect(sessions.size).toBe(6);
      expect(calls).toHaveLength(4);
      expect(calls[0]).toEqual({type:'publish_artifact',slotId:'contract',content:'带空格的输入'});
      await expect(runtime.run({...input,permission:'worktree-write'}, () => {})).rejects.toThrow(/授权/);
      await runtime.run({...input,executionId:'four',permission:'worktree-write',authorizedWorktree:directory,prompt:'受控写'}, () => {});
      expect(calls.at(-1)).toEqual({type:'write_file', path:'src/demo.ts', content:'测试内容'});
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory,{force:true, recursive:true}); }
  }, 90_000);
}
