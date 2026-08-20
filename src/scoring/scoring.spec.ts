import { describe, expect, it } from 'vitest';
import {
  GeoIndex,
  reachableLines,
  type DaycarePoint,
  type ScorableListing,
  type TransitPoint,
} from './context';
import { scoreListing, UnknownComponentError } from './scorer';
import { applyHardFilters, type FilterableListing } from './hard-filters';
import { buildSisterProfile } from '@/seed/sister-profile';
import type { TenantProfile } from '@/profiles/profile.schema';

const PROFILE = buildSisterProfile(['test-chat']);

const ORIGIN = { lat: 43.7, lng: -79.4 };

function daycare(overrides: Partial<DaycarePoint> & Pick<DaycarePoint, 'id' | 'lat' | 'lng'>): DaycarePoint {
  return {
    name: overrides.id,
    infantSpace: 0,
    toddlerSpace: 20,
    preschoolSpace: 0,
    kindergartenSpace: 0,
    schoolageSpace: 0,
    subsidy: false,
    cwelcc: false,
    ...overrides,
  };
}

function station(overrides: Partial<TransitPoint> & Pick<TransitPoint, 'id' | 'lat' | 'lng'>): TransitPoint {
  return {
    name: overrides.id,
    line: 'Line 5 Eglinton',
    status: 'operational',
    expectedYear: null,
    ...overrides,
  };
}

/** ~290 m walking from ORIGIN. */
const CLOSE = { lat: 43.702, lng: -79.4 };
/** ~1.4 km walking from ORIGIN — outside every radius in the profile. */
const FAR = { lat: 43.71, lng: -79.4 };

function listing(overrides: Partial<ScorableListing> = {}): ScorableListing {
  return {
    totalMonthlyCost: 2700,
    beds: 3,
    dens: 0,
    lat: ORIGIN.lat,
    lng: ORIGIN.lng,
    hasLocker: null,
    inSuiteLaundry: null,
    buildingBuiltBefore2018: null,
    ...overrides,
  };
}

const RICH_GEO = new GeoIndex(
  [
    daycare({ id: 'dc-close-cwelcc', ...CLOSE, cwelcc: true, subsidy: true }),
    daycare({ id: 'dc-close-2', lat: 43.7015, lng: -79.4005, cwelcc: true }),
    daycare({ id: 'dc-close-3', lat: 43.7018, lng: -79.3995, subsidy: true }),
    // Preschool-only: must be invisible to a toddler profile.
    daycare({ id: 'dc-preschool-only', lat: 43.7005, lng: -79.4, toddlerSpace: 0, preschoolSpace: 60 }),
    daycare({ id: 'dc-far', ...FAR }),
  ],
  [station({ id: 'st-close', ...CLOSE }), station({ id: 'st-far', ...FAR, status: 'future', expectedYear: 2031 })],
);

const EMPTY_GEO = new GeoIndex([], []);

describe('rentBelowTarget — the curve that carries the search', () => {
  const at = (total: number): number =>
    scoreListing({ listing: listing({ totalMonthlyCost: total }), profile: PROFILE, geo: RICH_GEO })
      .rawComponents.rentBelowTarget!;

  it('gives full credit at or below the target', () => {
    expect(at(2700)).toBe(1);
    expect(at(2400)).toBe(1);
  });

  it('decays linearly between target and ceiling instead of collapsing to zero', () => {
    // This is the whole point: a listing above target must still be rankable.
    expect(at(2950)).toBeCloseTo(0.5, 6);
    expect(at(2825)).toBeCloseTo(0.75, 6);
    expect(at(3075)).toBeCloseTo(0.25, 6);
  });

  it('reaches zero at the ceiling', () => {
    expect(at(3200)).toBe(0);
  });

  it('still discriminates across the band where the inventory actually sits', () => {
    expect(at(2750)).toBeGreaterThan(at(3150));
  });
});

describe('scoreListing', () => {
  it('produces a breakdown whose parts sum to the score', () => {
    const result = scoreListing({ listing: listing(), profile: PROFILE, geo: RICH_GEO });
    const sum = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(result.score, 1);
  });

  it('always reports a breakdown — it is the only way to calibrate weights', () => {
    const result = scoreListing({ listing: listing(), profile: PROFILE, geo: RICH_GEO });
    expect(Object.keys(result.breakdown).length).toBeGreaterThan(0);
    expect(result.breakdown.rentBelowTarget).toBeGreaterThan(0);
  });

  it('excludes unknown components from the average rather than scoring them zero', () => {
    const unknownLocker = scoreListing({
      listing: listing({ hasLocker: null }),
      profile: PROFILE,
      geo: RICH_GEO,
    });
    const noLocker = scoreListing({
      listing: listing({ hasLocker: false }),
      profile: PROFILE,
      geo: RICH_GEO,
    });
    // A silent ad must not be punished as though it had said "no locker".
    expect(unknownLocker.skipped).toContain('locker');
    expect(unknownLocker.score).toBeGreaterThan(noLocker.score);
  });

  it('scores 0..100 and never leaves the range', () => {
    const best = scoreListing({
      listing: listing({ totalMonthlyCost: 2000, hasLocker: true, inSuiteLaundry: true, buildingBuiltBefore2018: true }),
      profile: PROFILE,
      geo: RICH_GEO,
    });
    const worst = scoreListing({
      listing: listing({ totalMonthlyCost: 3200, hasLocker: false, inSuiteLaundry: false, buildingBuiltBefore2018: false }),
      profile: PROFILE,
      geo: EMPTY_GEO,
    });
    expect(best.score).toBeLessThanOrEqual(100);
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(best.score).toBeGreaterThan(worst.score);
  });

  it('fails loudly on a weight key that names no component', () => {
    const typo: TenantProfile = {
      ...PROFILE,
      soft: { ...PROFILE.soft, weights: { ...PROFILE.soft.weights, dacyareProximity: 20 } },
    };
    expect(() => scoreListing({ listing: listing(), profile: typo, geo: RICH_GEO })).toThrow(UnknownComponentError);
  });

  it('returns null components when the listing has no coordinates', () => {
    const result = scoreListing({
      listing: listing({ lat: null, lng: null }),
      profile: PROFILE,
      geo: RICH_GEO,
    });
    expect(result.skipped).toEqual(expect.arrayContaining(['daycareProximity', 'transitOperational']));
    // Rent is still knowable, so the listing is still scored.
    expect(result.breakdown.rentBelowTarget).toBeGreaterThan(0);
  });
});

describe('daycare components respect the profile age group', () => {
  it('ignores centres with no capacity in the requested band', () => {
    const preschoolOnly = new GeoIndex(
      [daycare({ id: 'p', ...CLOSE, toddlerSpace: 0, preschoolSpace: 60 })],
      [],
    );
    const result = scoreListing({ listing: listing(), profile: PROFILE, geo: preschoolOnly });
    // A 60-place preschool is worth nothing to a toddler profile.
    expect(result.rawComponents.daycareProximity).toBe(0);
    expect(result.rawComponents.daycareRedundancy).toBe(0);
  });

  it('rewards redundancy, not just the nearest centre', () => {
    const one = new GeoIndex([daycare({ id: 'a', ...CLOSE })], []);
    const three = new GeoIndex(
      [
        daycare({ id: 'a', ...CLOSE }),
        daycare({ id: 'b', lat: 43.7015, lng: -79.4005 }),
        daycare({ id: 'c', lat: 43.7018, lng: -79.3995 }),
      ],
      [],
    );
    const oneScore = scoreListing({ listing: listing(), profile: PROFILE, geo: one }).rawComponents;
    const threeScore = scoreListing({ listing: listing(), profile: PROFILE, geo: three }).rawComponents;
    expect(threeScore.daycareRedundancy).toBeGreaterThan(oneScore.daycareRedundancy!);
  });

  it('rewards cheap childcare separately from close childcare', () => {
    const priceyButClose = new GeoIndex([daycare({ id: 'a', ...CLOSE })], []);
    const cheapAndClose = new GeoIndex(
      [daycare({ id: 'a', ...CLOSE, cwelcc: true }), daycare({ id: 'b', lat: 43.7015, lng: -79.4005, cwelcc: true })],
      [],
    );
    const a = scoreListing({ listing: listing(), profile: PROFILE, geo: priceyButClose }).rawComponents;
    const b = scoreListing({ listing: listing(), profile: PROFILE, geo: cheapAndClose }).rawComponents;
    expect(a.daycareAffordability).toBe(0);
    expect(b.daycareAffordability).toBeGreaterThan(0.6);
  });
});

describe('transit as a score rather than a cut', () => {
  /** ~1,060 m walking from ORIGIN — the distance band that used to be eliminated outright. */
  const JUST_TOO_FAR = { lat: 43.7073, lng: -79.4 };

  it('admits a listing beyond the old 900 m limit and scores it down', () => {
    const geo = new GeoIndex([daycare({ id: 'dc', ...CLOSE })], [station({ id: 'st', ...JUST_TOO_FAR })]);
    const result = scoreListing({ listing: listing(), profile: PROFILE, geo });
    // Scored, not zero, and certainly not rejected: it is about a minute further to walk.
    expect(result.rawComponents.transitOperational).toBeGreaterThan(0);
    expect(result.rawComponents.transitOperational).toBeLessThan(0.5);
  });

  it('no longer rejects on distance at all', () => {
    const geo = new GeoIndex([daycare({ id: 'dc', ...CLOSE })], [station({ id: 'st', ...FAR })]);
    const outcome = applyHardFilters(
      {
        beds: 3,
        dens: 0,
        totalMonthlyCost: 2900,
        parkingIncluded: true,
        parkingCost: null,
        city: 'Toronto',
        lat: ORIGIN.lat,
        lng: ORIGIN.lng,
        availableFrom: null,
      },
      PROFILE,
      geo,
    );
    expect(outcome.rejections.map((r) => r.reason)).not.toContain('transit_distance');
  });

  it('still honours a hard limit for a profile that wants one', () => {
    const strict: TenantProfile = {
      ...PROFILE,
      hard: { ...PROFILE.hard, maxTransitWalkM: 900 },
      soft: { ...PROFILE.soft, transitWalkZeroM: undefined },
    };
    const geo = new GeoIndex([daycare({ id: 'dc', ...CLOSE })], [station({ id: 'st', ...FAR })]);
    const outcome = applyHardFilters(
      {
        beds: 3,
        dens: 0,
        totalMonthlyCost: 2900,
        parkingIncluded: true,
        parkingCost: null,
        city: 'Toronto',
        lat: ORIGIN.lat,
        lng: ORIGIN.lng,
        availableFrom: null,
      },
      strict,
      geo,
    );
    expect(outcome.rejections.map((r) => r.reason)).toContain('transit_distance');
  });

  it('never lets a future line stand in for an operational one', () => {
    const futureOnly = new GeoIndex([], [station({ id: 'f', ...CLOSE, status: 'future', expectedYear: 2031 })]);
    const result = scoreListing({ listing: listing(), profile: PROFILE, geo: futureOnly });
    expect(result.rawComponents.transitOperational).toBe(0);
    expect(result.rawComponents.transitFuture).toBe(1);
    // The future line is worth 3 weight against 15; it cannot rescue the listing.
    expect(result.breakdown.transitFuture!).toBeLessThan(5);
  });
});

describe('bedroomFit — the layout ladder', () => {
  const fit = (beds: number | null, dens: number): number | null =>
    scoreListing({ listing: listing({ beds, dens }), profile: PROFILE, geo: RICH_GEO }).rawComponents
      .bedroomFit ?? null;

  it('gives full credit to three bedrooms or more', () => {
    expect(fit(3, 0)).toBe(1);
    expect(fit(4, 0)).toBe(1);
  });

  it('puts a 3BR+den on the 3BR rung, not the den rung — order matters', () => {
    // A 3+den satisfies both `min:3` and nothing else; if the ladder were ordered the other
    // way round a 3BR+den could score below a plain 3BR, which would be absurd.
    expect(fit(3, 1)).toBe(1);
  });

  it('discounts 2BR+den, where the den becomes the office', () => {
    expect(fit(2, 1)).toBeCloseTo(0.7, 6);
  });

  it('heavily discounts a plain 2BR, where the office moves into the bedroom', () => {
    expect(fit(2, 0)).toBeCloseTo(0.15, 6);
  });

  it('is indeterminate — not zero — when the layout is unknown', () => {
    const result = scoreListing({ listing: listing({ beds: null, dens: 0 }), profile: PROFILE, geo: RICH_GEO });
    expect(result.skipped).toContain('bedroomFit');
  });

  it('disappears cleanly for a profile that declares no ladder', () => {
    const noTiers: TenantProfile = {
      ...PROFILE,
      soft: { ...PROFILE.soft, bedroomTiers: undefined },
    };
    const result = scoreListing({ listing: listing(), profile: noTiers, geo: RICH_GEO });
    expect(result.breakdown.bedroomFit).toBeUndefined();
    expect(result.skipped).toContain('bedroomFit');
  });
});

/**
 * The calibration this profile was tuned to. These two assertions are the contract behind
 * "a plain 2BR should only surface when it is exceptional" — if a weight changes and these
 * still pass, the intent survived; if they fail, the trade-off moved and someone should
 * have meant it.
 */
describe('bedroomFit vs rentBelowTarget — where the trade-off sits', () => {
  // Amenities pinned so both sides share the same denominator and only layout/rent differ.
  const known = { hasLocker: true, inSuiteLaundry: true, buildingBuiltBefore2018: true };
  const score = (beds: number, dens: number, totalMonthlyCost: number): number =>
    scoreListing({
      listing: listing({ beds, dens, totalMonthlyCost, ...known }),
      profile: PROFILE,
      geo: RICH_GEO,
    }).score;

  it('lets a 2BR at the target merely tie a 3BR at the ceiling', () => {
    const cheapTwoBed = score(2, 0, 2700);
    const expensiveThreeBed = score(3, 0, 3200);
    // A dead heat: the 2BR spends its entire price advantage buying back the lost bedroom.
    expect(Math.abs(cheapTwoBed - expensiveThreeBed)).toBeLessThan(1);
  });

  it('ranks the ladder correctly when price is held equal', () => {
    expect(score(3, 0, 2900)).toBeGreaterThan(score(2, 1, 2900));
    expect(score(2, 1, 2900)).toBeGreaterThan(score(2, 0, 2900));
  });

  it('makes a 3BR beat a plain 2BR that is 200 cheaper', () => {
    expect(score(3, 0, 3100)).toBeGreaterThan(score(2, 0, 2900));
  });

  /**
   * A 2BR+den is a genuine fallback, not a consolation prize — the den becomes the office.
   * So the rung below full costs about 175 of rent, and a 2BR+den that is meaningfully
   * cheaper is allowed to win. Recorded here because it is a deliberate choice, not a bug.
   */
  it('lets a 2BR+den outrank a 3BR once it is a few hundred cheaper', () => {
    expect(score(2, 1, 2800)).toBeGreaterThan(score(3, 0, 3000));
    expect(score(2, 1, 2950)).toBeLessThan(score(3, 0, 3000));
  });

  it('costs a plain 2BR about 21 points of the final score', () => {
    const penalty = score(3, 0, 2900) - score(2, 0, 2900);
    expect(penalty).toBeGreaterThan(20);
    expect(penalty).toBeLessThan(22);
  });
});

/**
 * The same layout penalty, seen where it actually decides something. In an excellent
 * location a 2BR still clears the notification threshold — which is the point, since an
 * outstanding 2BR should reach you. In an ordinary one it does not.
 */
describe('bedroomFit — what reaches the notification threshold', () => {
  const known = { hasLocker: true, inSuiteLaundry: true, buildingBuiltBefore2018: true };

  /** One plain daycare ~650 m away, one station ~720 m away: unremarkable, not bad. */
  const MODEST_GEO = new GeoIndex(
    [daycare({ id: 'dc-ok', lat: 43.7045, lng: -79.4 })],
    [station({ id: 'st-ok', lat: 43.705, lng: -79.4 })],
  );

  const scoreIn = (geo: GeoIndex, beds: number, dens: number): number =>
    scoreListing({
      listing: listing({ beds, dens, totalMonthlyCost: 2700, ...known }),
      profile: PROFILE,
      geo,
    }).score;

  it('still notifies an outstanding 2BR', () => {
    expect(scoreIn(RICH_GEO, 2, 0)).toBeGreaterThanOrEqual(PROFILE.notify.minScore);
  });

  it('silences an ordinary 2BR while the same unit as a 3BR would notify', () => {
    expect(scoreIn(MODEST_GEO, 3, 0)).toBeGreaterThanOrEqual(PROFILE.notify.minScore);
    expect(scoreIn(MODEST_GEO, 2, 0)).toBeLessThan(PROFILE.notify.minScore);
  });
});

describe('stationsWithin', () => {
  const geo = new GeoIndex(
    [],
    [
      station({ id: 'near', ...CLOSE }),
      station({ id: 'far', ...FAR }),
      station({ id: 'future-near', ...CLOSE, status: 'future', expectedYear: 2031 }),
    ],
  );

  it('returns only what is inside the radius, closest first', () => {
    const found = geo.stationsWithin(ORIGIN, 500, 'operational');
    expect(found.map((f) => f.station.id)).toEqual(['near']);
  });

  it('widens with the radius', () => {
    const found = geo.stationsWithin(ORIGIN, 2000, 'operational');
    expect(found.map((f) => f.station.id)).toEqual(['near', 'far']);
    expect(found[0]!.distanceM).toBeLessThan(found[1]!.distanceM);
  });

  it('keeps future lines out of an operational query', () => {
    expect(geo.stationsWithin(ORIGIN, 2000, 'operational').map((f) => f.station.id)).not.toContain(
      'future-near',
    );
    expect(geo.stationsWithin(ORIGIN, 2000, 'future').map((f) => f.station.id)).toEqual(['future-near']);
  });
});

/**
 * Lines, not stations. A second stop on a line already covered changes nothing about where
 * you can go; a different line changes everything — which is why counting stations would
 * describe two very different listings identically.
 */
describe('reachableLines', () => {
  const at = (id: string, line: string, distanceM: number): { station: TransitPoint; distanceM: number } => ({
    station: station({ id, ...CLOSE, line, name: id }),
    distanceM,
  });

  it('splits an interchange into each line it serves', () => {
    const lines = reachableLines([at('Sheppard-Yonge', 'Line 1 Yonge-University / Line 4 Sheppard', 640)]);
    expect(lines.map((l) => l.line)).toEqual(['Line 1 Yonge-University', 'Line 4 Sheppard']);
    // Both are reached through the same station.
    expect(lines.every((l) => l.station === 'Sheppard-Yonge')).toBe(true);
  });

  it('keeps the closest station serving each line', () => {
    const lines = reachableLines([
      at('Bayview', 'Line 4 Sheppard', 360),
      at('Sheppard-Yonge', 'Line 1 Yonge-University / Line 4 Sheppard', 640),
    ]);
    const line4 = lines.find((l) => l.line === 'Line 4 Sheppard');
    // Coordinates ride along for the walking-route link; this assertion is about which
    // station won, not where it is.
    expect(line4).toMatchObject({ line: 'Line 4 Sheppard', station: 'Bayview', distanceM: 360 });
  });

  it('does not report the same line twice', () => {
    const lines = reachableLines([
      at('Dundas', 'Line 1 Yonge-University', 400),
      at('Queen', 'Line 1 Yonge-University', 500),
      at('King', 'Line 1 Yonge-University', 700),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.station).toBe('Dundas');
  });

  it('orders by walking distance', () => {
    const lines = reachableLines([
      at('Union', 'Line 1 Yonge-University', 880),
      at('St Andrew', 'Line 2 Bloor-Danforth', 300),
    ]);
    expect(lines.map((l) => l.line)).toEqual(['Line 2 Bloor-Danforth', 'Line 1 Yonge-University']);
  });

  it('returns nothing when nothing is in range', () => {
    // Liberty Village: streetcar territory, and streetcars are deliberately not indexed.
    expect(reachableLines([])).toEqual([]);
  });
});

describe('applyHardFilters', () => {
  function filterable(overrides: Partial<FilterableListing> = {}): FilterableListing {
    return {
      beds: 3,
      dens: 0,
      totalMonthlyCost: 3000,
      parkingIncluded: true,
      parkingCost: null,
      city: 'City of Toronto',
      lat: ORIGIN.lat,
      lng: ORIGIN.lng,
      availableFrom: null,
      ...overrides,
    };
  }

  it('passes a listing that satisfies everything', () => {
    expect(applyHardFilters(filterable(), PROFILE, RICH_GEO).decision).toBe('pass');
  });

  it('accepts 2BR+den on the same footing as 3BR', () => {
    expect(applyHardFilters(filterable({ beds: 2, dens: 1 }), PROFILE, RICH_GEO).decision).toBe('pass');
  });

  it('now admits a plain 2BR — it is ranked down, not eliminated', () => {
    // Deliberate change: bedrooms became a scored ladder so that an exceptional 2BR can
    // still surface. The penalty lives in the bedroomFit component, not here.
    expect(applyHardFilters(filterable({ beds: 2, dens: 0 }), PROFILE, RICH_GEO).decision).toBe('pass');
  });

  it('still eliminates anything below the two-bedroom floor', () => {
    const result = applyHardFilters(filterable({ beds: 1, dens: 1 }), PROFILE, RICH_GEO);
    expect(result.decision).toBe('reject');
    expect(result.rejections[0]?.reason).toBe('bedroom_rule');
  });

  it('records the overshoot when the rent ceiling bites, so the guard can be tuned', () => {
    const result = applyHardFilters(filterable({ totalMonthlyCost: 3400 }), PROFILE, RICH_GEO);
    expect(result.rejections[0]?.reason).toBe('rent_ceiling');
    expect(result.rejections[0]?.detail.overshoot).toBe(200);
  });

  it('treats paid parking as satisfying the requirement, since the cost is already in the total', () => {
    const result = applyHardFilters(
      filterable({ parkingIncluded: false, parkingCost: 150 }),
      PROFILE,
      RICH_GEO,
    );
    expect(result.decision).toBe('pass');
  });

  it('rejects an ad that explicitly has no parking', () => {
    const result = applyHardFilters(filterable({ parkingIncluded: false, parkingCost: null }), PROFILE, RICH_GEO);
    expect(result.rejections[0]?.reason).toBe('no_parking');
  });

  it('sends a silent-on-parking ad to review, not to the bin', () => {
    const result = applyHardFilters(filterable({ parkingIncluded: null, parkingCost: null }), PROFILE, RICH_GEO);
    expect(result.decision).toBe('review');
    expect(result.reviews[0]?.field).toBe('parkingIncluded');
  });

  it('rejects the 905', () => {
    const result = applyHardFilters(filterable({ city: 'Mississauga' }), PROFILE, RICH_GEO);
    expect(result.rejections[0]?.reason).toBe('city');
  });

  /**
   * The three areas she refuses outright. Worth its own block because it is the one cut the
   * city allowlist cannot make: Scarborough and East York *are* Toronto, so these listings
   * pass every name-based test there is.
   */
  describe('refused areas', () => {
    /** 567 Scarborough Golf Club Rd — a real CAPREIT building, advertised as Scarborough. */
    const IN_SCARBOROUGH = { lat: 43.7608, lng: -79.21562 };
    /** Thorncliffe Park, which sources routinely label Toronto. */
    const IN_EAST_YORK = { lat: 43.7043, lng: -79.3445 };

    it('rejects a Scarborough listing that calls itself Toronto', () => {
      const result = applyHardFilters(filterable({ city: 'City of Toronto', ...IN_SCARBOROUGH }), PROFILE, RICH_GEO);
      const excluded = result.rejections.find((r) => r.reason === 'excluded_area');
      expect(excluded?.detail).toMatchObject({ area: 'Scarborough', determinedBy: 'coordinates' });
    });

    it('rejects East York the same way', () => {
      const result = applyHardFilters(filterable({ city: 'Toronto', ...IN_EAST_YORK }), PROFILE, RICH_GEO);
      expect(result.rejections.map((r) => r.reason)).toContain('excluded_area');
    });

    it('rejects a listing whose own label admits the area', () => {
      const result = applyHardFilters(filterable({ city: 'Scarborough', ...IN_SCARBOROUGH }), PROFILE, RICH_GEO);
      const excluded = result.rejections.find((r) => r.reason === 'excluded_area');
      expect(excluded?.detail).toMatchObject({ area: 'Scarborough', determinedBy: 'label' });
    });

    it('rejects Brampton by name, before the allowlist gets to it', () => {
      const result = applyHardFilters(filterable({ city: 'Brampton' }), PROFILE, RICH_GEO);
      const reasons = result.rejections.map((r) => r.reason);
      expect(reasons).toContain('excluded_area');
      // Both fire, and both are true: it is neither on the allowlist nor acceptable.
      expect(reasons).toContain('city');
    });

    it('leaves the rest of the city alone', () => {
      const result = applyHardFilters(filterable(), PROFILE, RICH_GEO);
      expect(result.decision).toBe('pass');
      expect(result.rejections.map((r) => r.reason)).not.toContain('excluded_area');
    });

    it('holds back a listing with no coordinates instead of passing it', () => {
      const result = applyHardFilters(filterable({ city: 'Toronto', lat: null, lng: null }), PROFILE, RICH_GEO);
      expect(result.decision).toBe('review');
      expect(result.reviews.some((r) => r.reason.includes('cannot be told apart'))).toBe(true);
    });
  });

  it('rejects when no toddler daycare is in range', () => {
    const result = applyHardFilters(filterable(), PROFILE, EMPTY_GEO);
    const reasons = result.rejections.map((r) => r.reason);
    expect(reasons).toContain('daycare_coverage');
  });

  it('sends a listing with no coordinates to review rather than rejecting it', () => {
    const result = applyHardFilters(filterable({ lat: null, lng: null }), PROFILE, RICH_GEO);
    expect(result.decision).toBe('review');
  });

  it('never decides silently: every outcome carries a reason or a review', () => {
    const result = applyHardFilters(filterable({ beds: 1, dens: 0, city: 'Vaughan' }), PROFILE, EMPTY_GEO);
    expect(result.decision).toBe('reject');
    expect(result.rejections.length).toBeGreaterThan(0);
    for (const r of result.rejections) {
      expect(r.reason).toBeTruthy();
      expect(r.detail).toBeTypeOf('object');
    }
  });
});

/**
 * Phase 4's acceptance criterion, asserted in Phase 0: a second tenant is a row, not a
 * commit. If this test ever needs a code change to keep passing, the foundation failed.
 */
describe('configurability — adding a profile must not touch code', () => {
  const hugo: TenantProfile = {
    id: 'hugo',
    label: 'Hugo — 1BR+den, walkable',
    active: true,
    hard: {
      totalRentMax: 2600,
      bedroomRule: { kind: 'bedsPlusDen', beds: 1 },
      availableFrom: null,
      requireParking: false,
      minDaycaresWithin: null,
      allowSplitDwelling: true,
      maxTransitWalkM: 600,
      cities: ['Toronto'],
      // Refuses nowhere: this tenant would take Scarborough happily.
      excludeAreas: [],
    },
    soft: {
      targetRent: 2200,
      weights: { rentBelowTarget: 40, transitOperational: 40, inSuiteLaundry: 20 },
    },
    notify: { telegramChatIds: ['hugo-chat'], minScore: 60, includeMap: false },
  };

  it('evaluates a completely different bedroom rule with the same engine', () => {
    const oneBedDen = { beds: 1, dens: 1, totalMonthlyCost: 2200, parkingIncluded: null, parkingCost: null, city: 'Toronto', lat: ORIGIN.lat, lng: ORIGIN.lng, availableFrom: null };
    expect(applyHardFilters(oneBedDen, hugo, RICH_GEO).decision).toBe('pass');
    // The same unit fails the sister's rule, from the same code.
    expect(applyHardFilters(oneBedDen, PROFILE, RICH_GEO).decision).toBe('reject');
  });

  it('scores against a different weight set, ignoring components it does not name', () => {
    const result = scoreListing({ listing: listing({ totalMonthlyCost: 2200, inSuiteLaundry: true }), profile: hugo, geo: RICH_GEO });
    expect(Object.keys(result.breakdown).sort()).toEqual(['inSuiteLaundry', 'rentBelowTarget', 'transitOperational']);
    // No daycare component appears at all — this profile never asked for one.
    expect(result.breakdown.daycareProximity).toBeUndefined();
  });
});

/**
 * Verification step 6 from the plan: an ordering sanity check before any real data exists,
 * so the starting weights can be judged rather than assumed.
 */
describe('calibration sanity — three synthetic listings', () => {
  it('ranks a cheap, well-served unit above an expensive, poorly-served one', () => {
    const cheapWithCwelcc = scoreListing({
      listing: listing({ totalMonthlyCost: 2650, hasLocker: true }),
      profile: PROFILE,
      geo: RICH_GEO,
    });
    const midNoLocker = scoreListing({
      listing: listing({ totalMonthlyCost: 3150, hasLocker: false }),
      profile: PROFILE,
      geo: RICH_GEO,
    });
    const atCeiling = scoreListing({
      listing: listing({ totalMonthlyCost: 3200, hasLocker: false }),
      profile: PROFILE,
      geo: RICH_GEO,
    });

    expect(cheapWithCwelcc.score).toBeGreaterThan(midNoLocker.score);
    expect(midNoLocker.score).toBeGreaterThan(atCeiling.score);
    // The cheap, well-served listing should clear the notify threshold; the ceiling one should not.
    expect(cheapWithCwelcc.score).toBeGreaterThanOrEqual(PROFILE.notify.minScore);
  });
});
