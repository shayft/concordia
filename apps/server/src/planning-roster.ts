import type { DatabaseSync } from 'node:sqlite';
import { planningRosterSchema, type PlanningMember } from '@concordia/protocol/planning';
import { resolveMember } from './connections.ts';

/** This projection is both the approved disclosure and the entire roster sent to the provider. */
export function planningRoster(db: DatabaseSync, ids: unknown): PlanningMember[] {
  return planningRosterSchema.parse(ids).sort().map((id) => {
    const { member } = resolveMember(db, id);
    return { id, name: member.name, role: member.role, connection: member.connectionId };
  });
}
