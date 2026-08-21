import { describe, expect, it } from 'vitest';
import {
  GEO_TOLERANCE_M,
  buildingKeys,
  geoMatchAllowed,
  houseNumber,
  listingKey,
  preferred,
  withoutTrailingDirection,
} from './address-match';

describe('buildingKeys', () => {
  it('keys a plain City address', () => {
    expect(buildingKeys('100 WELLESLEY ST E')).toContain('100 wellesley street east');
  });

  it('expands the street types the repository’s own table lacks', () => {
    // Measured: 18 City buildings use one of these four abbreviations, and every other unknown
    // token in the file is already a full word both sides spell the same way.
    expect(buildingKeys('20 GLEN EVEREST CRCT')).toContain('20 glen everest circuit');
    expect(buildingKeys('5 EDGECLIFF GRV')).toContain('5 edgecliff grove');
    expect(buildingKeys('12 BRIAR HILL GT')).toContain('12 briar hill gate');
  });

  it('expands a range across its own side of the street', () => {
    // `68-72 SPADINA RD` normalises to `68 72 spadina road`, which no listing will ever produce.
    // 72 City buildings are addressed this way; without this they are permanently unmatchable.
    const keys = buildingKeys('68-72 SPADINA RD');
    expect(keys).toContain('68 spadina road');
    expect(keys).toContain('70 spadina road');
    expect(keys).toContain('72 spadina road');
    // Even span, so the odd numbers belong to the other side of the street.
    expect(keys).not.toContain('69 spadina road');
  });

  it('agrees with the listing side even where normalizeAddress is surprising', () => {
    // `normalizeAddress` expands `st` to `street` in every position, so "ST GEORGE ST" becomes
    // "street george street". That looks wrong and is harmless: the same rule runs on both sides,
    // so the two meet. It is not ours to change — buildFingerprint calls the same function, and
    // the notifications index is on (profile_id, fingerprint).
    expect(buildingKeys('277-283 ST GEORGE ST')).toContain('279 street george street');
    expect(listingKey('279 St George St')).toBe('279 street george street');
  });

  it('misses a listing that spells out Saint, and that is a known miss', () => {
    // The cost of the rule above. Recorded rather than worked around: a building whose score we
    // cannot attach keeps buildingScore null, which the scorer already handles correctly.
    expect(listingKey('279 Saint George St')).toBe('279 saint george street');
    expect(buildingKeys('277-283 ST GEORGE ST')).not.toContain('279 saint george street');
  });

  it('walks a mixed-parity span one at a time rather than guessing a side', () => {
    const keys = buildingKeys('10-13 SOMEWHERE RD');
    expect(keys).toContain('11 somewhere road');
    expect(keys).toContain('12 somewhere road');
  });

  it('refuses a span too wide to be one building', () => {
    const keys = buildingKeys('2-900 IMPLAUSIBLE AVE');
    expect(keys.some((k) => k.startsWith('400 '))).toBe(false);
  });

  it('is empty for an address with nothing in it', () => {
    expect(buildingKeys('')).toEqual([]);
  });
});

describe('listingKey', () => {
  it('drops a unit designator normalizeAddress leaves behind', () => {
    // "main" only means a floor when followed by "floor", so normalisation keeps it.
    expect(listingKey('MAIN #2 - 591 OAKWOOD AVENUE')).toBe('591 oakwood avenue');
    expect(listingKey('LOWER - 1538 DAVENPORT ROAD')).toBe('1538 davenport road');
  });

  it('collapses a street type written twice', () => {
    // Real: `UNIT B2 - 32 HIGH PARK BLVD BOULEVARD`, abbreviated and expanded in the same line.
    expect(listingKey('UNIT B2 - 32 HIGH PARK BLVD BOULEVARD')).toBe('32 high park boulevard');
  });

  it('returns null when there is no house number to match on', () => {
    // 72 of 219 Kijiji listings look like this. They are unmatchable by address, and saying so is
    // the honest answer — the geographic tier deliberately will not rescue them either.
    expect(listingKey('Toronto, ON M6J 2V6')).toBeNull();
    expect(listingKey('BRIMLEY Road, Scarborough, ON')).toBeNull();
    expect(listingKey(null)).toBeNull();
  });

  it('keeps a full address untouched', () => {
    expect(listingKey('2770 Jane Street, Toronto, ON, M3N 2J1')).toBe('2770 jane street');
  });
});

describe('withoutTrailingDirection', () => {
  it('offers a retry without a direction that is often spurious', () => {
    expect(withoutTrailingDirection('5 richgrove drive east')).toBe('5 richgrove drive');
  });

  it('offers nothing when there was no direction to drop', () => {
    // Null rather than the same string, so a caller cannot silently retry the identical lookup.
    expect(withoutTrailingDirection('5 richgrove drive')).toBeNull();
  });
});

describe('houseNumber', () => {
  it('reads the leading number, and nothing else', () => {
    expect(houseNumber('591 oakwood avenue')).toBe(591);
    expect(houseNumber('oakwood avenue')).toBeNull();
  });
});

describe('preferred', () => {
  const a = { rsn: '1000', evaluatedOn: '2024-01-01' };
  const b = { rsn: '2000', evaluatedOn: '2026-05-01' };

  it('takes the most recent evaluation', () => {
    // Measured: two of 3,585 buildings collide on one key — 33 Flamborough Dr Unit B/C/D, scoring
    // 97, 100 and 97.
    expect(preferred(a, b)).toBe(b);
    expect(preferred(b, a)).toBe(b);
  });

  it('breaks a tie on rsn, so the answer is the same on every run', () => {
    const older = { rsn: '2000', evaluatedOn: '2024-01-01' };
    expect(preferred(a, older).rsn).toBe('1000');
    expect(preferred(older, a).rsn).toBe('1000');
  });
});

describe('geoMatchAllowed', () => {
  const building = { lat: 43.7, lng: -79.4, numbers: [100, 102] };

  it('allows a close match once the house number already agrees', () => {
    expect(geoMatchAllowed({ lat: 43.7001, lng: -79.4001, houseNumber: 100 }, building)).toBe(true);
  });

  it('refuses a listing with no house number, however close it is', () => {
    // Ungated, proximity alone matched "East York, ON M4B 1N7" to 2908 ST CLAIR AVE E — a postal
    // code centroid that lands near a building. That is not a weak match, it is an invented fact.
    expect(geoMatchAllowed({ lat: 43.7, lng: -79.4, houseNumber: null }, building)).toBe(false);
  });

  it('refuses a different house number at the same spot', () => {
    expect(geoMatchAllowed({ lat: 43.7, lng: -79.4, houseNumber: 999 }, building)).toBe(false);
  });

  it('refuses the right number too far away', () => {
    // Two streets can share a house number; distance is what says it is the same place.
    expect(geoMatchAllowed({ lat: 43.75, lng: -79.4, houseNumber: 100 }, building)).toBe(false);
  });

  it('refuses when either side has no coordinate', () => {
    // 214 of 6,090 City rows carry none.
    expect(geoMatchAllowed({ lat: null, lng: null, houseNumber: 100 }, building)).toBe(false);
    expect(geoMatchAllowed({ lat: 43.7, lng: -79.4, houseNumber: 100 }, { ...building, lat: null })).toBe(false);
  });

  it('holds the tolerance at the documented distance', () => {
    expect(GEO_TOLERANCE_M).toBe(150);
  });
});
