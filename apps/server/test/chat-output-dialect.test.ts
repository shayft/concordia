import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runBuiltin } from '@concordia/runtimes/builtin';
import { createModelProvider, validateGateway } from '@concordia/providers';
import { connectionSchema, catalogModelSchema } from '@concordia/protocol/connections';
import { listen } from '../../../packages/providers/test/fixture.ts';
import { providerConfig } from '../src/connections.ts';

it.each(['max_completion_tokens', 'max_tokens'] as const)('两种验证入口及两轮原生工具请求均只提交批准的字段 %s', async field => {
  const cap = 37;
  const guard = z.strictObject({ model:z.literal('custom'), messages:z.array(z.unknown()).min(1),
    stream:z.literal(false), tools:z.array(z.unknown()).optional(), [field]:z.literal(cap) });
  // The strict fixture rejects unknown fields just as a gateway with a fixed request schema would.
  let attempts = 0;
  const requests: unknown[] = [];
  const baseUrl = await listen(async (req, res) => {
    attempts++;
    const result = guard.safeParse(JSON.parse(await text(req)));
    if (!result.success) { res.writeHead(400).end(); return; }
    requests.push(result.data);
    const isTask = attempts >= 3;
    const last = attempts === 4;
    const message = isTask ? {tool_calls:[{id:last ? 'finish' : 'progress', type:'function',
      function:last ? {name:'submit_result',arguments:'{"summary":"done"}'} : {name:'progress',arguments:'{"message":"ok"}'}}]}
      : {content:'CONCORDIA_OK'};
    res.end(JSON.stringify({choices:[{message, finish_reason:isTask ? 'tool_calls' : 'stop'}]}));
  });
  const model = catalogModelSchema.parse({id:'model',connectionId:'link',modelId:'custom',name:'模型'});
  const binding = connectionSchema.parse({id:'link',name:'网关',kind:'chat-completions',baseUrl,
    stream:false,maxOutputTokens:cap, ...(field === 'max_tokens' && {outputTokenField:field})});
  const config = providerConfig(binding,model); // Existing catalogs without a selector use the original field.
  const provider = createModelProvider(config);
  const standalone = await validateGateway({baseUrl,model:'custom',credentialRef:'keychain:test',
    outputTokenField:config.outputTokenField,maxOutputTokens:config.maxOutputTokens}, async () => randomUUID());
  expect(standalone.ok).toBe(true);
  expect((await provider.validateConnection()).ok).toBe(true);
  // Mutating an outside reference cannot change the wire format of an approved conversation.
  config.outputTokenField = field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  config.maxOutputTokens = 100;
  const dispatch = vi.fn(async () => ({ok:true}));
  await runBuiltin({provider,mode:'native',maxCalls:2,signal:new AbortController().signal,
    instruction:'完成任务',prompt:'执行',allowed:new Set(['progress','submit_result']),beforeCall:()=>{},usage:()=>{},dispatch});
  expect(attempts).toBe(4);
  expect(requests).toHaveLength(4);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(requests[3]).toMatchObject({messages:expect.arrayContaining([expect.objectContaining({role:'tool',tool_call_id:'progress'})])});
});

it('供应商拒绝所选字段时不会重新发起另一种字段的请求', async () => {
  const attempts: unknown[] = [];
  const baseUrl = await listen(async (req,res) => {
    attempts.push(JSON.parse(await text(req)));
    res.writeHead(400).end('{"error":{"code":"invalid_request_error"}}');
  });
  const config = {baseUrl,model:'custom',outputTokenField:'max_tokens' as const};
  expect((await createModelProvider({...config,protocol:'chat-completions'}).validateConnection()).ok).toBe(false);
  expect((await validateGateway({...config,credentialRef:'keychain:test'},async()=>randomUUID())).ok).toBe(false);
  expect(attempts).toHaveLength(2);
  for (const request of attempts) {
    expect(request).toHaveProperty('max_tokens',1024);
    expect(request).not.toHaveProperty('max_completion_tokens');
  }
  expect(connectionSchema.safeParse({id:'one',name:'非 Chat',kind:'gemini',baseUrl,outputTokenField:'max_tokens'}).success).toBe(false);
  expect(connectionSchema.safeParse({id:'one',name:'非法字段',kind:'chat-completions',baseUrl,outputTokenField:'messages'}).success).toBe(false);
});
