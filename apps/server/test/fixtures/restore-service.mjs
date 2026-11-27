// Use the normal server entry point in a fresh process so SQLite handles,
// application sessions, and scheduler state cannot survive the stop/start.
import { startLocalServer } from '../../src/local-server.ts';

const [web, data] = process.argv.slice(2);
const service = await startLocalServer(web, data);
process.once('message', async (command) => {
  if (command !== 'stop') throw new Error('测试服务的关闭请求无效。');
  await service.close();
  process.disconnect();
});
process.send({ launchUrl: service.launchUrl });
