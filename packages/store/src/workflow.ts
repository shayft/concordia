import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  emptyState,
  type Append,
  type State,
  type WorkflowEvent,
  type WorkflowStorage,
} from '@concordia/core/state';

/** SQLite owns execution state and event order. Content is immutable and installed before references commit. */
export class WorkflowStore implements WorkflowStorage {
  private readonly objects: string;
  constructor(
    private readonly db: DatabaseSync,
    dataDirectory?: string,
  ) {
    const dbFile = db.location();
    if (!dataDirectory && !dbFile) throw new Error('内存数据库需要显式指定内容目录');
    this.objects = join(dataDirectory ?? dirname(dbFile!), 'objects');
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
  }
  read(): State {
    const row = this.db.prepare('SELECT data FROM workflow_state WHERE singleton=1').get();
    return row ? (JSON.parse(String(row.data)) as State) : emptyState();
  }
  events(after = 0): WorkflowEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('事件游标无效');
    return this.db
      .prepare('SELECT seq, type, data FROM workflow_events WHERE seq>? ORDER BY seq')
      .all(after)
      .map((row) => ({ seq: Number(row.seq), type: String(row.type), data: JSON.parse(String(row.data)) }));
  }
  transaction<T>(mutate: (state: State, append: Append) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const previousWakeups = new Set(state.wakeups),
        previousPlan = state.spec?.id;
      const event = this.db.prepare('INSERT INTO workflow_events(type,data) VALUES (?,?)');
      const result = mutate(state, (type, data) => {
        event.run(type, JSON.stringify({ planId: state.spec?.id, ...data }));
      });
      const wake = this.db.prepare(
        'INSERT INTO workflow_wakeups(workflow_id,task_id,version_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      );
      for (const key of state.wakeups) {
        if (previousPlan === state.spec?.id && previousWakeups.has(key)) continue;
        const [taskId, versionId] = JSON.parse(key) as [string, string];
        wake.run(state.spec!.id, taskId, versionId);
      }
      this.db
        .prepare(
          'INSERT INTO workflow_state(singleton,data) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET data=excluded.data',
        )
        .run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  putContent(text: string) {
    const digest = createHash('sha256').update(text).digest('hex');
    const path = join(this.objects, digest);
    if (existsSync(path)) return digest;
    const temporary = join(this.objects, '.' + randomUUID());
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      unlinkSync(temporary);
    }
    return digest;
  }
  getContent(ref: string) {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('内容引用无效');
    const body = readFileSync(join(this.objects, ref), 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== ref) throw new Error('内容摘要不匹配');
    return body;
  }
}
