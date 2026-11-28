import { z } from 'zod';

export const planningRosterSchema = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u))
  .min(1).max(30).refine((ids) => new Set(ids).size === ids.length, '参与岗位标识重复');
export interface PlanningMember { id: string; name: string; connection: string; role: string }
export interface PlanningRequest {
  id: string;
  member: string;
  memberIds: string[];
  started: number;
  finished: number | null;
  status: 'running' | 'proposed' | 'failed' | 'cancelled' | 'interrupted';
  phase: 'preparing' | 'sent' | 'receiving' | 'finished';
  progressBytes: number;
  hasResult: boolean;
}
