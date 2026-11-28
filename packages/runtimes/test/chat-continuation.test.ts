import { text } from 'node:stream/consumers';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createModelProvider } from '@concordia/providers';
import { listen } from '../../providers/test/fixture.ts';
import { runBuiltin } from '../src/builtin.ts';

it.each([true,false])('Chat 工具续调只在同一会话内回传思考字段，stream=%s', async stream => {
  const reasoning = randomUUID();
  const requests: unknown[] = [];
  const dispatched = vi.fn(async () => ({ok:true}));
  const endpoint = await listen(async (req,res) => {
    const body = JSON.parse(await text(req));
    requests.push(body);
    if (requests.length > 1 && body.messages.find((m: {role:string}) => m.role === 'assistant')?.reasoning_content !== reasoning) {
      res.writeHead(400).end(); return;
    }
    const first = requests.length === 1;
    const fn = first ? {name:'progress',arguments:'{"message":"working"}'} : {name:'submit_result',arguments:'{"summary":"done"}'};
    const call = {id:'call-' + requests.length,type:'function',function:fn};
    if (!stream) {
      res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{reasoning_content:reasoning,tool_calls:[call]}}]}));
      return;
    }
    res.setHeader('content-type','text/event-stream');
    for (const delta of [{reasoning_content:reasoning.slice(0,8)},{reasoning_content:reasoning.slice(8)},{tool_calls:[{...call,index:0}]}])
      res.write('data: ' + JSON.stringify({choices:[{delta,index:0}]}) + '\n\n');
    res.end('data: ' + JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]}) + '\n\ndata: [DONE]\n\n');
  });
  const usage = vi.fn();
  await runBuiltin({provider:createModelProvider({protocol:'chat-completions',model:'custom',baseUrl:endpoint,stream}),
    prompt:'work',instruction:'test',allowed:new Set(['progress','submit_result']),mode:'native',signal:new AbortController().signal,
    beforeCall:() => {},dispatch:dispatched,usage,maxCalls:2});
  expect(requests).toHaveLength(2);
  expect(dispatched).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(dispatched.mock.calls)).not.toContain(reasoning);
  expect(JSON.stringify(usage.mock.calls)).not.toContain(reasoning);
});
