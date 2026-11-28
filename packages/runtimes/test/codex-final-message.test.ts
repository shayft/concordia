import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodeAgentOutput } from '../src/agent-output.ts';

it('Codex keeps the last completed agent message as the final answer for JSON actions and plans', () => {
  const final = '{"actions":[{"type":"progress","message":"finished"}]}';
  const frames = [
    {type:'thread.started',thread_id:randomUUID()}, {type:'turn.started'},
    ...['working',final].map(text => ({type:'item.completed', item:{type:'agent_message',text}})),
    {type:'turn.completed'},
  ];
  expect(decodeAgentOutput('codex',frames.map(event => JSON.stringify(event)).join('\n')).text).toBe(final);
});
