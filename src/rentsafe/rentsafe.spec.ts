import { describe, expect, it } from 'vitest';
import { SCORE_COMPONENTS } from '@/scoring/components';
import { builtBeforeRentControl } from '@/seed/rentsafe';
import { applyRentSafe } from './apply';
import { RentSafeIndex } from './rentsafe.index';
import type { TriageListing } from '@/listings/listing.types';
import type { ScoringContext } from '@/scoring/context';

const score = (raw: number | null): number | null =>
  SCORE_COMPONENTS.buildingScore!({ building: raw === null ? null : { rsn: 'x', score: raw, yearBuilt: null } } as ScoringContext);

describe('buildingScore', () => {
  it('is neutral for a typical building, and half the stock is either side of it', () => {
    expect(score(91)).toBeCloseTo(0.5, 4);
  });

  it('rewards the top of the range and reaches 1.0 at a perfect score', () => {
    expect(score(100)).toBeCloseTo(1, 4);
    expect(score(95)).toBeGreaterThan(0.7);
  });

  it('penalises below the typical building without collapsing the populated band', () => {
    // p05 is 74 and p25 is 85; both must stay well clear of zero or the component stops
    // discriminating exactly where most of the stock sits.
    expect(score(85)).toBeGreaterThan(0.35);
    expect(score(74)).toBeGreaterThan(0.25);
  });

  it('bottoms out at the City’s own audit line, which 0.4% of buildings reach', () => {
    expect(score(50)).toBeCloseTo(0, 4);
    expect(score(17)).toBe(0);
  });

  it('does not pay a typical building the way a linear curve would', () => {
    // score/100 would hand 0.91 to a merely typical building. Since a null component drops out of
    // the average entirely, and 90% of purpose-built units match against ~15% of condo listings,
    // that would promote a whole segment on a criterion the other segment cannot have.
    expect(score(91)).toBeLessThan(0.91 - 0.3);
  });

  it('is null when no building was matched, so the component is skipped rather than zeroed', () => {
    expect(score(null)).toBeNull();
  });
});

describe('applyRentSafe', () => {
  const listing = { buildingBuiltBefore2018: null } as TriageListing;
  const building = { rsn: '1', siteAddress: 'x', score: 90, evaluatedOn: null, lat: null, lng: null };

  it('lights up rentControlled, which has been null for every listing ever scored', () => {
    expect(applyRentSafe(listing, { ...building, yearBuilt: 1968 }).buildingBuiltBefore2018).toBe(true);
    expect(applyRentSafe(listing, { ...building, yearBuilt: 2021 }).buildingBuiltBefore2018).toBe(false);
  });

  it('leaves 2018 undecided rather than guessing which side of 15 November it fell', () => {
    expect(applyRentSafe(listing, { ...building, yearBuilt: 2018 }).buildingBuiltBefore2018).toBeNull();
    expect(builtBeforeRentControl(2018)).toBeNull();
  });

  it('never overrules what the source already stated', () => {
    const stated = { ...listing, buildingBuiltBefore2018: false } as TriageListing;
    expect(applyRentSafe(stated, { ...building, yearBuilt: 1950 }).buildingBuiltBefore2018).toBe(false);
  });
});

describe('RentSafeIndex', () => {
  const index = new RentSafeIndex([
    { rsn: '1', siteAddress: '100 WELLESLEY ST E', score: 95, evaluatedOn: '2026-01-01', yearBuilt: 1970, lat: 43.666, lng: -79.378 },
    { rsn: '2', siteAddress: '68-72 SPADINA RD', score: 80, evaluatedOn: '2026-01-01', yearBuilt: 1960, lat: 43.67, lng: -79.4 },
  ]);

  it('matches an address exactly', () => {
    const hit = index.match({ address: '100 Wellesley Street East, Toronto, ON', lat: null, lng: null });
    expect(hit?.building.rsn).toBe('1');
    expect(hit?.tier).toBe('exact');
  });

  it('matches into an expanded range, and says that is what happened', () => {
    const hit = index.match({ address: '70 Spadina Road', lat: null, lng: null });
    expect(hit?.building.rsn).toBe('2');
    expect(hit?.tier).toBe('range');
  });

  it('matches through a unit designator the listing carries', () => {
    expect(index.match({ address: 'MAIN #2 - 100 Wellesley St E', lat: null, lng: null })?.building.rsn).toBe('1');
  });

  it('refuses a listing with no house number, however close its coordinates', () => {
    // The invented-fact case: a postal code centroid landing near a real building.
    expect(index.match({ address: 'Toronto, ON M4Y 1H5', lat: 43.666, lng: -79.378 })).toBeNull();
  });

  it('returns null for a building nobody inspected', () => {
    expect(index.match({ address: '1 Nowhere Lane', lat: null, lng: null })).toBeNull();
  });
});
