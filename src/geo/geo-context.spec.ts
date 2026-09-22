import { describe, expect, it } from 'vitest';
import type { TenantProfile } from '@/profiles/profile.schema';
import { GeoIndex, type DaycarePoint, type TransitPoint } from '@/scoring/context';
import { geoContextFor, mapPointsFor, transitRadiusOf } from './geo-context';

/** A profile shaped like the live one where it matters here: toddler places within 800 m. */
const PROFILE: TenantProfile = {
  id: 'p',
  label: 'test',
  active: true,
  hard: {
    totalRentMax: 3200,
    bedroomRule: { kind: 'min', beds: 2 },
    availableFrom: null,
    requireParking: false,
    minDaycaresWithin: { radiusM: 800, count: 1, ageGroup: 'toddler' },
    allowSplitDwelling: true,
    maxTransitWalkM: null,
    cities: ['Toronto', 'Mississauga'],
    excludeAreas: [],
  },
  soft: { weights: { daycareProximity: 1 }, transitWalkZeroM: 1200 },
  notify: { telegramChatIds: ['c'], minScore: 0, includeMap: true },
};

function daycare(over: Partial<DaycarePoint> & Pick<DaycarePoint, 'id' | 'lat' | 'lng'>): DaycarePoint {
  return {
    name: over.id,
    infantSpace: 0,
    toddlerSpace: 10,
    preschoolSpace: 0,
    kindergartenSpace: 0,
    schoolageSpace: 0,
    subsidy: false,
    cwelcc: false,
    capacityKnown: true,
    ...over,
  };
}

function station(over: Partial<TransitPoint> & Pick<TransitPoint, 'id' | 'lat' | 'lng'>): TransitPoint {
  return { name: over.id, line: 'Line 1 Yonge-University', status: 'operational', expectedYear: null, ...over };
}

// Roughly 0.001° of latitude is 111 m; walking distance is haversine × 1.3.
const HOME = { lat: 43.7, lng: -79.4 };
const geo = new GeoIndex(
  [
    daycare({ id: 'close-cwelcc', lat: 43.702, lng: -79.4, cwelcc: true }),
    daycare({ id: 'mid', lat: 43.704, lng: -79.4 }),
    daycare({ id: 'far', lat: 43.72, lng: -79.4 }),
    daycare({ id: 'no-toddler', lat: 43.701, lng: -79.4, toddlerSpace: 0, preschoolSpace: 40 }),
    daycare({ id: 'peel-unknown', lat: 43.592, lng: -79.64, capacityKnown: false, toddlerSpace: 0 }),
  ],
  [
    station({ id: 'Eglinton', lat: 43.701, lng: -79.4 }),
    station({ id: 'Davisville', lat: 43.697, lng: -79.397 }),
    station({ id: 'Future stop', lat: 43.703, lng: -79.402, line: 'Line 5 Eglinton', status: 'future', expectedYear: 2031 }),
    station({ id: 'Cooksville', lat: 43.59, lng: -79.64, line: 'Hurontario LRT' }),
  ],
);

describe('transitRadiusOf', () => {
  it('prefers the soft decay distance, then the hard cut, then 900 m', () => {
    expect(transitRadiusOf(PROFILE)).toBe(1200);
    expect(transitRadiusOf({ ...PROFILE, soft: { weights: {} }, hard: { ...PROFILE.hard, maxTransitWalkM: 700 } })).toBe(700);
    expect(transitRadiusOf({ ...PROFILE, soft: { weights: {} } })).toBe(900);
  });
});

describe('geoContextFor', () => {
  it('claims nothing about a listing without coordinates', () => {
    // Nothing was searched, so coverage is 'none' and no count is offered — the message must not
    // be able to print "0 daycares within 800 m" about a place nobody located.
    const ctx = geoContextFor({ lat: null, lng: -79.4, city: 'Toronto' }, PROFILE, geo);
    expect(ctx).toEqual({
      reachableLines: [],
      transitRadiusM: 1200,
      daycaresNearby: { total: 0, cwelcc: 0, radiusM: 800, coverage: 'none' },
      nearestDaycare: null,
      mapStops: [],
    });
  });

  it('reports full coverage in Toronto, counting only centres with a toddler place', () => {
    const ctx = geoContextFor({ ...HOME, city: 'Toronto' }, PROFILE, geo);
    expect(ctx.daycaresNearby).toEqual({ total: 2, cwelcc: 1, radiusM: 800, coverage: 'full' });
    expect(ctx.nearestDaycare?.name).toBe('close-cwelcc');
    expect(ctx.nearestDaycare?.cwelcc).toBe(true);
  });

  it('lists lines rather than stations, closest station per line first', () => {
    const ctx = geoContextFor({ ...HOME, city: 'Toronto' }, PROFILE, geo);
    // Two Line 1 stations in range collapse to one line, served by the nearer of them; the future
    // stop is not reachable today and so is not a line you can take.
    expect(ctx.reachableLines.map((l) => [l.line, l.station])).toEqual([['Line 1 Yonge-University', 'Eglinton']]);
  });

  it('puts the nearest station first on the map, then at most three daycares', () => {
    const ctx = geoContextFor({ ...HOME, city: 'Toronto' }, PROFILE, geo);
    expect(ctx.mapStops.map((s) => s.label)).toEqual(['Eglinton', 'close-cwelcc', 'mid']);
  });

  it('reports presence only where the counted centres publish no capacity', () => {
    const ctx = geoContextFor({ lat: 43.59, lng: -79.64, city: 'Mississauga' }, PROFILE, geo);
    expect(ctx.daycaresNearby).toEqual({ total: 1, cwelcc: 0, radiusM: 800, coverage: 'presenceOnly' });
    expect(ctx.reachableLines[0]?.line).toBe('Hurontario LRT');
  });

  it('reports no coverage outside every seeded region, without searching', () => {
    // Same coordinates as the Mississauga case, so the only difference is the municipality.
    const ctx = geoContextFor({ lat: 43.59, lng: -79.64, city: 'Oakville' }, PROFILE, geo);
    expect(ctx.daycaresNearby).toEqual({ total: 0, cwelcc: 0, radiusM: 800, coverage: 'none' });
    expect(ctx.nearestDaycare).toBeNull();
  });
});

describe('mapPointsFor', () => {
  it('draws nothing without coordinates', () => {
    expect(mapPointsFor({ lat: null, lng: null, city: 'Toronto' }, PROFILE, geo)).toBeNull();
  });

  it('draws operational and future stations in range, and the daycares that were counted', () => {
    const points = mapPointsFor({ ...HOME, city: 'Toronto' }, PROFILE, geo);
    expect(points?.stations.map((s) => [s.name, s.status])).toEqual([
      ['Eglinton', 'operational'],
      ['Davisville', 'operational'],
      ['Future stop', 'future'],
    ]);
    expect(points?.daycares.map((d) => d.name)).toEqual(['close-cwelcc', 'mid']);
    expect(points?.stations.every((s) => s.distanceM > 0)).toBe(true);
  });
});
