import type { DatabaseSync } from 'node:sqlite';
import type { PlanningRequest } from '@concordia/protocol/planning';
import { workflowSpecSchema, type WorkflowSpec } from '@concordia/protocol/workflow';
import { currentApprovalId } from './governance.ts';
import { ContentStore } from '@concordia/store/content';

type Row = {
  id: string; member: string; selected_ids: string; status: PlanningRequest['status'];
  started: number; finished: number | null; phase: PlanningRequest['phase']; progress_bytes: number;
  result_ref: string | null; request_hash: string | null;
};
const fields = 'id,member,selected_ids,status,started,finished,phase,progress_bytes,result_ref,request_hash';
function summary(row: Row): PlanningRequest {
  return { id: row.id, member: row.member, memberIds: JSON.parse(row.selected_ids), started: row.started,
    finished: row.finished, phase: row.phase, progressBytes: row.progress_bytes, status: row.status,
    hasResult: row.status === 'proposed' && row.result_ref !== null };
}

/** The catalog owns request status; the workspace's private object directory owns generated text. */
export class PlanningRequests {
  private objects: ContentStore;
  private unsettled = new Map<string, number>();
  constructor(private db: DatabaseSync, private workspace: string, directory: string) {
    this.objects = new ContentStore(directory);
  }
  rememberWriteFailure(id: string, bytes: number) {
    this.unsettled.set(id, bytes);
  }
  flushInterrupted() {
    for (const [id, bytes] of this.unsettled) {
      try { this.finish(id, 'interrupted', bytes); }
      catch { throw new Error('规划状态尚未保存，请检查可用存储空间'); }
      this.unsettled.delete(id);
    }
  }
  byKey(key: string) {
    this.flushInterrupted();
    return this.db.prepare('SELECT ' + fields + ' FROM plan_requests WHERE workspace=? AND request_key=?')
      .get(this.workspace, key) as Row | undefined;
  }
  private row(id: string) {
    this.flushInterrupted();
    const row = this.db.prepare('SELECT ' + fields + ' FROM plan_requests WHERE workspace=? AND id=?')
      .get(this.workspace, id) as Row | undefined;
    if (!row) throw new Error('当前工作区没有这项规划');
    return row;
  }
  get(id: string) { return summary(this.row(id)); }
  list() {
    this.flushInterrupted();
    // A completed-page limit must never hide an active request's cancel control.
    const active = this.db.prepare('SELECT ' + fields + " FROM plan_requests WHERE workspace=? AND status='running' ORDER BY started DESC").all(this.workspace);
    const history = this.db.prepare('SELECT ' + fields + " FROM plan_requests WHERE workspace=? AND status<>'running' ORDER BY started DESC LIMIT 30").all(this.workspace);
    return [...active, ...history].map((row) => summary(row as Row));
  }
  start(id: string, member: string, connection: string, roster: string[], key: string | undefined, hash: string) {
    this.db.prepare(`INSERT INTO plan_requests(id,workspace,member,connection,started,status,phase,selected_ids,request_key,request_hash,approval_id)
      VALUES(?,?,?,?,?,'running','preparing',?,?,?,?)`).run(id, this.workspace, member, connection, Date.now(), JSON.stringify(roster), key ?? null, hash, currentApprovalId() ?? null);
  }
  sent(id: string) {
    this.db.prepare("UPDATE plan_requests SET phase='sent' WHERE workspace=? AND id=? AND status='running'").run(this.workspace, id);
  }
  progress(id: string, bytes: number) {
    this.db.prepare("UPDATE plan_requests SET phase='receiving', progress_bytes=? WHERE workspace=? AND id=? AND status='running'").run(bytes, this.workspace, id);
  }
  finish(id: string, status: Exclude<PlanningRequest['status'], 'running'>, bytes: number, spec?: WorkflowSpec) {
    const ref = spec ? this.objects.put(JSON.stringify(spec)) : null;
    this.db.prepare("UPDATE plan_requests SET status=?,finished=?,phase='finished',progress_bytes=?,result_ref=? WHERE workspace=? AND id=? AND status='running'")
      .run(status, Date.now(), bytes, ref, this.workspace, id);
  }
  result(id: string) {
    const row = this.row(id);
    if (row.status !== 'proposed' || !row.result_ref) throw new Error('此规划没有可载入的草案');
    return workflowSpecSchema.parse(JSON.parse(this.objects.get(row.result_ref)));
  }
}
