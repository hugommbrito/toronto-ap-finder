import { describe, expect, it } from 'vitest';
import { breakdownBars } from './breakdown';

/** The live profile's weights (sum 168), so the arithmetic below is the real arithmetic. */
const WEIGHTS = {
  bedroomFit: 35,
  areaFit: 15,
  rentBelowTarget: 30,
  daycareProximity: 20,
  daycareRedundancy: 10,
  daycareAffordability: 15,
  transitOperational: 4,
  parkingConfirmed: 6,
  bathrooms: 5,
  locker: 5,
  rentControlled: 5,
  buildingScore: 15,
  transitFuture: 1,
  inSuiteLaundry: 2,
};

describe('breakdownBars', () => {
  it('computes each criterion’s ceiling from the weights that actually evaluated', () => {
    // A terse Kijiji ad: buildingScore, areaFit, parkingConfirmed and bathrooms all null, so the
    // effective denominator is 127 — the case the profile's own comment walks through.
    const breakdown = {
      bedroomFit: 27.56,
      rentBelowTarget: 23.62,
      daycareProximity: 10,
      daycareRedundancy: 3.94,
      daycareAffordability: 5,
      transitOperational: 3.15,
      locker: 0,
      rentControlled: 3.94,
      transitFuture: 0,
      inSuiteLaundry: 1.57,
    };
    const view = breakdownBars(WEIGHTS, breakdown);
    expect(view.effectiveWeight).toBe(127);
    const bedroom = view.bars.find((b) => b.name === 'bedroomFit');
    expect(bedroom?.maxPoints).toBeCloseTo(27.56, 1);
    expect(bedroom?.ratio).toBeCloseTo(1, 2);
    const rent = view.bars.find((b) => b.name === 'rentBelowTarget');
    expect(rent?.maxPoints).toBeCloseTo(23.62, 1);
    expect(view.skipped).toEqual(['areaFit', 'bathrooms', 'buildingScore', 'parkingConfirmed']);
  });

  it('sums the parts back to the whole', () => {
    const breakdown = { bedroomFit: 20.83, rentBelowTarget: 17.86, daycareProximity: 11.9, areaFit: 8.93 };
    const view = breakdownBars(WEIGHTS, breakdown);
    expect(view.total).toBeCloseTo(59.52, 1);
    // Every ceiling together is 100: that is what "effective weight" means.
    expect(view.bars.reduce((sum, b) => sum + b.maxPoints, 0)).toBeCloseTo(100, 6);
  });

  it('orders the heaviest criterion first, so two listings line up row for row', () => {
    const view = breakdownBars(WEIGHTS, { locker: 5, bedroomFit: 35, rentBelowTarget: 30 });
    expect(view.bars.map((b) => b.name)).toEqual(['bedroomFit', 'rentBelowTarget', 'locker']);
  });

  it('ignores breakdown keys the profile gives no weight, and clamps an over-full bar', () => {
    const view = breakdownBars({ a: 10, b: 0 }, { a: 120, b: 3, c: 4 });
    expect(view.bars.map((b) => b.name)).toEqual(['a']);
    expect(view.bars[0]?.ratio).toBe(1);
    expect(view.skipped).toEqual([]);
  });
});
