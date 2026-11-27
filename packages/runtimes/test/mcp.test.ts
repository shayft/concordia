import { expect, it, vi } from 'vitest';
import { ExecutionMcpServer } from '../src/mcp.ts';

it('MCP 协商、参数白名单、重发、错绑、撤销和到期', async () => {
  let now = 0;
  const dispatch = vi.fn(async () => ({ accepted: true }));
  const mcp = new ExecutionMcpServer(dispatch, () => now);
  const token = mcp.open('a', undefined, new Set(['submit_result']));
  mcp.open('b');
  const send = (executionId: string, method: string, params: unknown, id = 1) => mcp.handle({
    executionId, authorization: 'Bearer ' + token, body: { jsonrpc: '2.0', id, method, params },
  });
  expect((await send('b','initialize',{})).status).toBe(401);
  expect(await send('a','initialize',{protocolVersion:'2025-06-18'})).toMatchObject({status:200, body:{result:{protocolVersion:'2025-06-18'}}});
  expect(await send('a','tools/list',{})).toMatchObject({ body: { result: { tools: expect.arrayContaining([
    expect.objectContaining({ name:'submit_result', inputSchema:expect.objectContaining({required:['summary']}) }),
  ]) } } });
  const action = { name:'submit_result', arguments:{ summary:'测试' } };
  const refused = await send('a','tools/call',{name:'write_file',arguments:{path:'elsewhere',content:'无权写入'}},4);
  expect(refused).toMatchObject({body:{error:{code:-32602}}});
  expect(await send('a','tools/call',{name:'submit_result',arguments:{summary:token}},5)).toMatchObject({body:{error:{code:-32602}}});
  expect(dispatch).not.toHaveBeenCalled();
  expect(await send('a','tools/call', { ...action, arguments:{ type:'write_file', summary:'测试' } })).toMatchObject({body:{error:{code:-32602}}});
  await Promise.all([send('a','tools/call',action,3), send('a','tools/call',action,3)]);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('a', { type:'submit_result', summary:'测试' });
  expect(await send('a','tools/call',{...action, arguments:{summary:'重复编号'}},3)).toMatchObject({body:{error:{code:-32600}}});
  now = 181_000;
  expect((await send('a','tools/call',action)).status).toBe(401);
  now = 0;
  mcp.close('a');
  expect((await send('a','tools/call',action)).status).toBe(401);
});

it('分配给执行的凭证不会进入请求编号、动作回执或错误正文', async()=>{
  let token='';
  const mcp=new ExecutionMcpServer(async()=>({value:token}));
  token=mcp.open('one',undefined,new Set(['progress']));
  const send=(id:number|string,method:string,params:unknown)=>mcp.handle({
    executionId:'one',authorization:'Bearer '+token,body:{jsonrpc:'2.0',id,method,params},
  });
  await send(1,'initialize',{});
  for (const response of [
    await send(token,'ping',{}),
    await send(2,'tools/call',{name:'progress',arguments:{message:token.toUpperCase()}}),
    await send(3,'tools/call',{name:'progress',arguments:{message:'正常进度'}}),
  ]) {
    expect(JSON.stringify(response).toLowerCase().includes(token)).toBe(false);
    expect(response.body).toHaveProperty('error');
  }
});
