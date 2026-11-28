// A fresh process runs the installed application. IPC keeps launch tokens out of job logs.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, data] = process.argv.slice(2);
let server;
try {
  const { startLocalServer } = await import(pathToFileURL(join(source, 'apps/server/src/local-server.ts')).href);
  server = await startLocalServer(undefined, data);
  const close = () => server.close().then(() => { if (process.connected) process.disconnect(); });
  process.once('message', close);
  process.once('disconnect', () => { if (process.connected === false) void server.close(); });
  process.send(server.launchUrl);
} catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
