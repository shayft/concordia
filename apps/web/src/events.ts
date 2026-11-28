import { browserFetch } from './api.ts';

/** Each reconnect carries the last fully received ID. A new workspace creates a new subscription. */
export function subscribeEvents(onOpen: () => void, onEvent: () => void, onDisconnect: () => void) {
  const controller = new AbortController();
  let cursor = '';
  let retry: ReturnType<typeof setTimeout> | undefined;
  async function connect() {
    try {
      const response = await browserFetch(cursor ? '/api/events' : '/api/events?tail=1', {
        headers: cursor ? { 'Last-Event-ID': cursor } : {},
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('实时连接未建立');
      onOpen();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let end: number;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const id = /^id: (\d+)$/m.exec(frame)?.[1];
            if (id) cursor = id;
            if (id && /^data:/m.test(frame)) onEvent();
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Refetching the workspace list on reconnect also catches another tab's switch.
    }
    if (!controller.signal.aborted) {
      onDisconnect();
      retry = setTimeout(() => void connect(), 1000);
    }
  }
  void connect();
  return () => { controller.abort(); clearTimeout(retry); };
}
