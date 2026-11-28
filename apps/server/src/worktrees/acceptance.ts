import type { DatabaseSync } from 'node:sqlite';
import type { Scheduler } from '@concordia/core/workflow';
import type { AcceptanceSnapshot } from '@concordia/protocol/workflow';

export interface SourceCommit {
  treeId: string;
  sha: string;
}
export interface MergeAcceptance extends AcceptanceSnapshot {
  workspaceId: string;
  sources: (SourceCommit & { versionId: string })[];
}
export type CheckAcceptance = (
  scope: string | null,
  project: string,
  inputs: SourceCommit[],
) => MergeAcceptance;

export function acceptedCommits(
  scheduler: Scheduler,
  db: DatabaseSync,
  workspaceId: string,
  scope: string | null,
  project: string,
  inputs: SourceCommit[],
): MergeAcceptance {
  const board = scheduler.board();
  const accepted = board.acceptedSnapshot;
  if (!accepted || scope !== JSON.stringify([workspaceId, accepted.planId]))
    throw new Error('请先在所属计划验收主卡并核对当前联调版本。');

  const versions = new Map(board.versions.map((v) => [v.id, v]));
  const wanted = new Set(Object.values(accepted.versions));
  for (const execId of Object.values(accepted.executions)) {
    const exec = board.executions.find((e) => e.id === execId);
    if (!exec || exec.status !== 'success') throw new Error('无法核实验收执行。');
    for (const id of [...Object.values(exec.inputs), ...Object.values(exec.outputs)]) wanted.add(id);
  }
  // Set iteration includes subsequently added ancestors and visits each version once.
  const sources: MergeAcceptance['sources'] = [];
  const acceptedInputs = new Set<string>();
  for (const id of wanted) {
    const version = versions.get(id);
    if (!version || version.stale) throw new Error('验收引用的交付版本已失效。');
    for (const parent of Object.values(version.basedOn)) wanted.add(parent);
    if (version.kind !== 'git_commit') continue;
    const sha = scheduler.readVersion(id).content;
    const row = db
      .prepare('SELECT tree,project FROM version_sources WHERE workspace=? AND execution=? AND sha=?')
      .get(workspaceId, version.executionId, sha);
    if (!row) throw new Error('验收提交的工作树来源无法核实。');
    if (row.project !== project) continue;
    const treeId = String(row.tree);
    acceptedInputs.add(treeId + ':' + sha);
    sources.push({ treeId, sha, versionId: id });
  }
  if (
    !inputs.length ||
    inputs.length !== acceptedInputs.size ||
    inputs.some(({ treeId, sha }) => !acceptedInputs.has(treeId + ':' + sha))
  )
    throw new Error('联调输入与主卡已验收的项目提交不一致。');
  sources.sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0));
  return { workspaceId, ...accepted, sources };
}
