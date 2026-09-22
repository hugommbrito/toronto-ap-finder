import { describe, expect, it } from 'vitest';
import type { BedroomTier } from '@/profiles/profile.schema';
import type { FeedItem, ListingStatus, MapSurroundings } from './api-types';
import { applyFilters, capLocated, facetsOf, skippedComponents, sortItems, tierOf, toMapListing } from './listings-view.service';

const TIERS: BedroomTier[] = [
  { label: '3BR+', rule: { kind: 'min', beds: 3 }, value: 1 },
  { label: '2BR + den', rule: { kind: 'bedsPlusDen', beds: 2 }, value: 0.7 },
  { label: '2BR', rule: { kind: 'min', beds: 2 }, value: 0.15 },
];

function item(over: {
  id?: string;
  score?: number;
  rent?: number;
  firstSeenAt?: string;
  postedAt?: string | null;
  areaSqft?: number | null;
  source?: string;
  city?: string | null;
  area?: string | null;
  tier?: number | null;
  lat?: number;
  lng?: number;
  status?: ListingStatus;
  delistedAt?: string;
}): FeedItem {
  const id = over.id ?? 'x';
  return {
    listing: {
      id,
      source: over.source ?? 'kijiji',
      sourceId: id,
      url: `https://example.test/${id}`,
      fingerprint: `fp-${id}`,
      title: id,
      rentBase: over.rent ?? 2800,
      parkingIncluded: null,
      parkingCost: null,
      parkingAvailable: null,
      utilitiesIncluded: [],
      totalMonthlyCost: over.rent ?? 2800,
      beds: 2,
      dens: 0,
      baths: null,
      areaSqft: over.areaSqft ?? null,
      hasLocker: null,
      inSuiteLaundry: null,
      address: null,
      city: over.city === undefined ? 'Toronto' : over.city,
      lat: over.lat ?? null,
      lng: over.lng ?? null,
      postedAt: over.postedAt ?? null,
      availableFrom: null,
      buildingBuiltBefore2018: null,
      firstSeenAt: over.firstSeenAt ?? '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-02T00:00:00.000Z',
      hydratedAt: null,
      delistedAt: over.delistedAt ?? null,
    },
    score: over.score ?? 70,
    breakdown: {},
    firstScoredAt: '2026-09-01T00:00:00.000Z',
    state: { status: over.status ?? 'none', note: null, updatedAt: null },
    rentsafe: null,
    notifiedAt: null,
    duplicates: 0,
    area: over.area === undefined ? null : over.area,
    tier: over.tier === undefined || over.tier === null ? null : { index: over.tier, label: `tier ${over.tier}` },
  };
}

describe('tierOf', () => {
  it('walks the ladder strictest first, so a 3BR lands on the top tier and not on "min 2"', () => {
    expect(tierOf(TIERS, { beds: 3, dens: 0 })).toEqual({ index: 0, label: '3BR+' });
    expect(tierOf(TIERS, { beds: 2, dens: 1 })).toEqual({ index: 1, label: '2BR + den' });
    expect(tierOf(TIERS, { beds: 2, dens: 0 })).toEqual({ index: 2, label: '2BR' });
  });

  it('places nothing when the layout is unknown or below every tier', () => {
    expect(tierOf(TIERS, { beds: null, dens: 0 })).toBeNull();
    expect(tierOf(TIERS, { beds: 1, dens: 1 })).toBeNull();
  });

  it('places nothing for a profile without a ladder', () => {
    expect(tierOf(undefined, { beds: 3, dens: 0 })).toBeNull();
  });
});

describe('skippedComponents', () => {
  it('names the weighted components missing from the breakdown, and only those', () => {
    const weights = { bedroomFit: 35, areaFit: 15, buildingScore: 15, transitFuture: 0 };
    const breakdown = { bedroomFit: 27.6 };
    // areaFit and buildingScore returned null and left the denominator; transitFuture carries no
    // weight, so its absence means nothing.
    expect(skippedComponents(weights, breakdown)).toEqual(['areaFit', 'buildingScore']);
    expect(skippedComponents(weights, { bedroomFit: 1, areaFit: 1, buildingScore: 1 })).toEqual([]);
  });
});

describe('applyFilters', () => {
  const items = [
    item({ id: 'a', tier: 0, city: 'Toronto', area: 'North York', source: 'kijiji' }),
    item({ id: 'b', tier: 2, city: 'North York', area: 'North York', source: 'zumper' }),
    item({ id: 'c', tier: 1, city: 'Mississauga', area: null, source: 'kijiji' }),
    item({ id: 'd', tier: null, city: null, area: null, source: 'capreit' }),
  ];
  const ids = (xs: FeedItem[]): string[] => xs.map((x) => x.listing.id);

  it('returns everything when nothing narrows', () => {
    expect(ids(applyFilters(items, {}))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('narrows by tier index', () => {
    expect(ids(applyFilters(items, { tier: 0 }))).toEqual(['a']);
    expect(ids(applyFilters(items, { tier: 5 }))).toEqual([]);
  });

  it('treats the amalgamated names as one city, the way the hard filter does', () => {
    // "North York" is Toronto since 1998; asking for Toronto must find both spellings.
    expect(ids(applyFilters(items, { city: 'Toronto' }))).toEqual(['a', 'b']);
    expect(ids(applyFilters(items, { city: 'City of Mississauga' }))).toEqual(['c']);
  });

  it('narrows by area and by any of several sources', () => {
    expect(ids(applyFilters(items, { area: 'North York' }))).toEqual(['a', 'b']);
    expect(ids(applyFilters(items, { sources: ['zumper', 'capreit'] }))).toEqual(['b', 'd']);
    expect(ids(applyFilters(items, { sources: [] }))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('facetsOf', () => {
  it('counts sources, canonical cities and areas, most common first', () => {
    const facets = facetsOf([
      item({ id: 'a', city: 'Toronto', area: 'North York', source: 'kijiji' }),
      item({ id: 'b', city: 'North York', area: 'North York', source: 'zumper' }),
      item({ id: 'c', city: 'Mississauga', area: null, source: 'kijiji' }),
      item({ id: 'd', city: null, area: null, source: 'kijiji' }),
    ]);
    expect(facets.sources).toEqual([
      { value: 'kijiji', count: 3 },
      { value: 'zumper', count: 1 },
    ]);
    expect(facets.cities).toEqual([
      { value: 'toronto', count: 2 },
      { value: 'mississauga', count: 1 },
    ]);
    expect(facets.areas).toEqual([{ value: 'North York', count: 2 }]);
  });
});

describe('sortItems', () => {
  const items = [
    item({ id: 'cheap-old', score: 60, rent: 2500, firstSeenAt: '2026-09-01T00:00:00.000Z', postedAt: null, areaSqft: 900 }),
    item({ id: 'best', score: 80, rent: 3100, firstSeenAt: '2026-09-03T00:00:00.000Z', postedAt: '2026-09-02T00:00:00.000Z', areaSqft: null }),
    item({ id: 'mid', score: 70, rent: 2800, firstSeenAt: '2026-09-02T00:00:00.000Z', postedAt: '2026-09-03T00:00:00.000Z', areaSqft: 1100 }),
  ];
  const ids = (xs: FeedItem[]): string[] => xs.map((x) => x.listing.id);

  it('orders by score, rent, and first sighting', () => {
    expect(ids(sortItems(items, 'score'))).toEqual(['best', 'mid', 'cheap-old']);
    expect(ids(sortItems(items, 'rent'))).toEqual(['cheap-old', 'mid', 'best']);
    expect(ids(sortItems(items, 'newest'))).toEqual(['best', 'mid', 'cheap-old']);
  });

  it('puts listings without the sort key last, whichever direction the sort runs', () => {
    expect(ids(sortItems(items, 'posted'))).toEqual(['mid', 'best', 'cheap-old']);
    expect(ids(sortItems(items, 'area'))).toEqual(['mid', 'cheap-old', 'best']);
  });

  it('breaks ties on score and leaves the input untouched', () => {
    const tied = [item({ id: 'a', score: 50, rent: 3000 }), item({ id: 'b', score: 90, rent: 3000 })];
    expect(ids(sortItems(tied, 'rent'))).toEqual(['b', 'a']);
    expect(ids(tied)).toEqual(['a', 'b']);
  });
});

describe('capLocated', () => {
  const items = [
    item({ id: 'a', score: 90, lat: 43.7, lng: -79.4 }),
    item({ id: 'b', score: 80 }), // no coordinates: nothing to draw
    item({ id: 'c', score: 70, lat: 43.71, lng: -79.41 }),
    item({ id: 'd', score: 60, lat: 43.72, lng: -79.42 }),
  ];
  const ids = (xs: FeedItem[]): string[] => xs.map((x) => x.listing.id);

  it('drops what cannot be drawn and counts it, keeping the order', () => {
    const cap = capLocated(items, 100);
    expect(ids(cap.kept)).toEqual(['a', 'c', 'd']);
    expect(cap).toMatchObject({ located: 3, unlocated: 1, truncated: false });
  });

  it('keeps the best when there are more than the cap, and says so', () => {
    // The input is score-descending from SQL, so a plain slice is the top of the ranking.
    const cap = capLocated(items, 2);
    expect(ids(cap.kept)).toEqual(['a', 'c']);
    expect(cap).toMatchObject({ located: 3, unlocated: 1, truncated: true });
  });

  it('is not truncated exactly at the cap', () => {
    expect(capLocated(items, 3).truncated).toBe(false);
    expect(capLocated([], 3)).toEqual({ kept: [], located: 0, unlocated: 0, truncated: false });
  });
});

describe('toMapListing', () => {
  const surroundings: MapSurroundings = { reachableLines: [], nearestDaycare: null, daycareCoverage: 'full' };

  it('carries the tier label, the decision, and whether the ad is gone', () => {
    const point = toMapListing(
      item({ id: 'a', score: 82, rent: 2950, lat: 43.7, lng: -79.4, tier: 1, status: 'favourite', delistedAt: '2026-09-10T00:00:00.000Z' }),
      surroundings,
    );
    expect(point).toMatchObject({
      id: 'a',
      lat: 43.7,
      lng: -79.4,
      score: 82,
      totalMonthlyCost: 2950,
      tier: 'tier 1',
      status: 'favourite',
      delisted: true,
      surroundings,
    });
    expect(toMapListing(item({ id: 'b', lat: 43.7, lng: -79.4 }), surroundings)).toMatchObject({ tier: null, delisted: false, status: 'none' });
  });

  it('refuses a listing without coordinates, which capLocated should have removed', () => {
    expect(() => toMapListing(item({ id: 'x' }), surroundings)).toThrow(/no coordinates/);
  });
});
