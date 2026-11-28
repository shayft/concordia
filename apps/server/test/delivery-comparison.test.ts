import { expect, it } from 'vitest';
import { rehearse } from '../bench/delivery.ts';

it('固定发布时刻后比较并发，固定并发后比较提前发布，分别计量主卡就绪、确认和全队收工', () => {
  const serial = rehearse('serial'),
    parallel = rehearse('parallel'),
    early = rehearse('early');
  const longGuide = rehearse('early', 60_000);
  for (const arm of [serial, parallel, early, longGuide]) {
    expect(arm.acceptance).toEqual(serial.acceptance);
    expect(arm.acceptedContents).toEqual(serial.acceptedContents);
    expect(arm.calls).toBe(6);
    expect(arm.approvalWallMs).toBeGreaterThan(0);
    expect(arm.dependencyWallMs).toBeLessThanOrEqual(arm.allCardsFinishedMs);
    expect(arm.confirmedMs - arm.firstAcceptableMs).toBe(1000);
  }
  expect([serial, parallel, early].map((arm) => arm.firstAcceptableMs)).toEqual([26_000, 21_000, 15_000]);
  expect([serial, parallel, early].map((arm) => arm.taskStarts.ui)).toEqual([9000, 9000, 2000]);
  expect(longGuide).toMatchObject({
    firstAcceptableMs: 15_000,
    confirmedMs: 16_000,
    allCardsFinishedMs: 69_000,
  });
});
