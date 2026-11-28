import { expect, it } from 'vitest';
import { rehearse } from '../bench/delivery.ts';

it('相同固定任务和验收内容下，分别记录串行和提前交付的耗时、并行重叠与人工验收', () => {
  const serial = rehearse('serial'), early = rehearse('early');
  expect(early.acceptance).toEqual(serial.acceptance);
  expect(early.acceptedContents).toEqual(serial.acceptedContents);
  expect(early.calls).toBe(serial.calls);
  expect(early.taskStarts.ui).toBe(2000);
  expect(serial.taskStarts.ui).toBe(9000);
  expect(early.elapsedMs).toBeLessThan(serial.elapsedMs);
  expect(early.dependencyWallMs).toBeLessThanOrEqual(early.elapsedMs);
  expect(early.approvalWallMs).toBeGreaterThan(0);
  expect(early.approvalWallMs).toBeLessThan(6000);
});
