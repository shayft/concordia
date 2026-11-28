import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { auditEvent } from './audit.ts';

const cursor = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const historyQuery = z.strictObject({
  before: cursor.optional(),
  after: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).refine(q => q.before === undefined || q.after === undefined);
type Query = z.output<typeof historyQuery>;

export function eventPage(db: DatabaseSync, { before, after, limit }: Query) {
  const columns = 'SELECT seq, type, data FROM workflow_events';
  const rows = after !== undefined
    ? db.prepare(columns + ' WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit + 1)
    : before !== undefined
      ? db.prepare(columns + ' WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(before, limit + 1)
      : db.prepare(columns + ' ORDER BY seq DESC LIMIT ?').all(limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  if (after === undefined) rows.reverse();
  const events = rows.map(row => auditEvent({ seq: Number(row.seq), type: String(row.type), data: JSON.parse(String(row.data)) }));
  return { events, hasMore };
}

/** A connection owns at most one page and waits for drain before reading any more rows. */
export function streamHistory(out: ServerResponse, db: DatabaseSync, sequence: number, onClose: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    out.off('drain', send);
    out.off('close', stop);
    onClose();
    if (!out.destroyed && !out.writableEnded) out.end();
  }
  function send() {
    if (stopped) return;
    if (out.destroyed || out.writableEnded) return stop();
    try {
      const page = eventPage(db, { after: sequence, limit: 100 });
      for (const event of page.events) {
        const buffered = out.write('id: ' + event.seq + '\ndata: ' + JSON.stringify(event) + '\n\n');
        sequence = event.seq;
        if (!buffered) {
          out.once('drain', send);
          return;
        }
      }
      timer = setTimeout(send, page.hasMore ? 0 : 250);
      timer.unref();
    } catch {
      stop();
    }
  }
  out.once('close', stop);
  // Defer the first page until the caller has registered the cleanup.
  timer = setTimeout(send, 0);
  timer.unref();
  return stop;
}
