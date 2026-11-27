import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import type { ModelEvent, ModelTool } from '../src/model-types.ts';

export const tool: ModelTool = {
  name: 'publish',
  description: 'publish a version',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
};
export const input = [{ role: 'user' as const, content: 'Run this task.' }];
const cleanups: (() => Promise<void>)[] = [];
export async function listen(handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/tenant/v1';
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
export async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
