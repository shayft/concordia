import { expect, it } from 'vitest';
import type { Protocol } from '../src/model-types.ts';
import { createModelProvider } from '../src/model-provider.ts';
import { collect, input, listen } from './fixture.ts';

const cases: [Protocol, object, string][] = [
  ['chat-completions',{error:{code:'insufficient_quota'}},'budget'],
  ['responses',{type:'response.failed',response:{error:{code:'rate_limit_exceeded'}}},'rate_limit'],
  ['responses',{type:'error',code:'invalid_api_key'},'auth'],
  ['gemini',{error:{status:'RESOURCE_EXHAUSTED',code:429}},'rate_limit'],
  ['anthropic',{type:'error',error:{type:'overloaded_error'}},'server'],
  ['anthropic',{type:'error',error:{type:'private_unknown'}},'invalid'],
];
it.each(cases)('normalizes %s error frames independently of the successful HTTP handshake', async (protocol,error,kind) => {
  const baseUrl = await listen((_req,res) => {
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('data: ' + JSON.stringify({...error,message:'private upstream detail'}) + '\n\n');
  });
  const events = await collect(createModelProvider({protocol,baseUrl,model:'test'}).stream(input));
  expect(events).toEqual([expect.objectContaining({type:'error',kind,httpStatus:200})]);
  expect(JSON.stringify(events)).not.toMatch(/private/);
});
