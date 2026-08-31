import { describe, expect, it } from 'vitest';
import { haversineMeters, walkingMeters } from './distance';
import { cityFromAddress, buildFingerprint, normalizeAddress } from './address';
import { canonicalMunicipality, cityMatches, normalizeCity } from './city';

describe('haversineMeters', () => {
  it('matches a known Toronto distance', () => {
    // Union Station to Bloor-Yonge, ~2.6 km straight line.
    const union = { lat: 43.6453, lng: -79.3806 };
    const bloorYonge = { lat: 43.6709, lng: -79.3857 };
    expect(haversineMeters(union, bloorYonge)).toBeGreaterThan(2700);
    expect(haversineMeters(union, bloorYonge)).toBeLessThan(3000);
  });

  it('is zero for the same point and symmetric', () => {
    const a = { lat: 43.65, lng: -79.38 };
    const b = { lat: 43.72, lng: -79.44 };
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it('applies the walking detour factor', () => {
    const a = { lat: 43.65, lng: -79.38 };
    const b = { lat: 43.66, lng: -79.38 };
    expect(walkingMeters(a, b)).toBeCloseTo(haversineMeters(a, b) * 1.3, 6);
  });
});

describe('normalizeAddress', () => {
  it('collapses the ways one building gets written', () => {
    const canonical = normalizeAddress('100 Queens Quay W, Toronto, ON, M5J 2N9');
    expect(normalizeAddress('100 Queens Quay West Unit 2201')).toBe(canonical);
    expect(normalizeAddress('100 Queens Quay W. #2201')).toBe(canonical);
    expect(normalizeAddress('100 queens quay w')).toBe(canonical);
  });

  it('expands street-type abbreviations', () => {
    expect(normalizeAddress('2770 Jane St')).toBe('2770 jane street');
    expect(normalizeAddress('55 Bloor Ave E')).toBe('55 bloor avenue east');
  });

  it('keeps only the street line, so a source that appends the city still matches one that does not', () => {
    expect(normalizeAddress('2770 Jane Street, Toronto, ON, M3N 2J1')).toBe('2770 jane street');
    expect(normalizeAddress('2770 Jane St')).toBe('2770 jane street');
  });

  it('finds the street line even when the unit comes first', () => {
    expect(normalizeAddress('Unit 501, 100 Queens Quay West')).toBe('100 queens quay west');
  });

  it('returns empty for nothing', () => {
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress('')).toBe('');
  });
});

describe('buildFingerprint', () => {
  const base = {
    address: '100 Queens Quay W, Toronto, ON',
    city: 'Toronto',
    beds: 2,
    dens: 1,
    rentBase: 3000,
    fallback: 'a',
  };

  it('groups the same unit advertised differently across sources', () => {
    const kijiji = buildFingerprint(base);
    const zumper = buildFingerprint({
      ...base,
      address: '100 Queens Quay West Unit 1502',
      rentBase: 3020, // same $50 bucket
      fallback: 'b',
    });
    expect(zumper).toBe(kijiji);
  });

  it('separates genuinely different units at the same address', () => {
    expect(buildFingerprint({ ...base, beds: 3 })).not.toBe(buildFingerprint(base));
    expect(buildFingerprint({ ...base, rentBase: 3400 })).not.toBe(buildFingerprint(base));
  });

  /**
   * The collision the 905 expansion would otherwise have caused. Same street, same layout,
   * same rent bucket, different city — and because `notifications` is uniquely indexed on
   * (profile_id, fingerprint), a shared key here means the second one is silently never sent.
   */
  it('separates the same address in two different cities', () => {
    const toronto = buildFingerprint({ ...base, address: '100 Main Street', city: 'Toronto' });
    const mississauga = buildFingerprint({ ...base, address: '100 Main Street', city: 'Mississauga' });
    expect(mississauga).not.toBe(toronto);
  });

  /** But the amalgamated names must keep agreeing, which is why the city is canonicalised. */
  it('still groups the amalgamated Toronto names together', () => {
    const asToronto = buildFingerprint({ ...base, city: 'Toronto' });
    const asNorthYork = buildFingerprint({ ...base, city: 'North York' });
    const asCityOf = buildFingerprint({ ...base, city: 'City of Toronto' });
    expect(asNorthYork).toBe(asToronto);
    expect(asCityOf).toBe(asToronto);
  });

  it('falls back to a source-unique key when there is no address', () => {
    const a = buildFingerprint({ ...base, address: null, fallback: 'kijiji:1' });
    const b = buildFingerprint({ ...base, address: null, fallback: 'kijiji:2' });
    // Two addressless ads must not collide into one "unit".
    expect(a).not.toBe(b);
  });
});

describe('city matching', () => {
  it('normalises the label Kijiji actually returns', () => {
    expect(normalizeCity('City of Toronto')).toBe('toronto');
    expect(normalizeCity('Toronto, ON')).toBe('toronto');
  });

  it('treats the amalgamated municipalities as one city', () => {
    expect(canonicalMunicipality('North York')).toBe('toronto');
    expect(canonicalMunicipality('Etobicoke')).toBe('toronto');
    expect(canonicalMunicipality('Scarborough')).toBe('toronto');
  });

  it('matches the sister profile city list against real source values', () => {
    const allowed = ['Toronto', 'North York', 'Etobicoke', 'Scarborough', 'East York'];
    expect(cityMatches('City of Toronto', allowed)).toBe(true);
    expect(cityMatches('North York', allowed)).toBe(true);
    expect(cityMatches('Toronto', allowed)).toBe(true);
  });

  it('still excludes the 905', () => {
    const allowed = ['Toronto', 'North York', 'Etobicoke', 'Scarborough', 'East York'];
    expect(cityMatches('Mississauga', allowed)).toBe(false);
    expect(cityMatches('Vaughan', allowed)).toBe(false);
    expect(cityMatches(null, allowed)).toBe(false);
  });
});

/**
 * The municipality inside an address, needed because a source's city field may name a region.
 *
 * Kijiji labels an ad with the region its search ran in, so "Mississauga / Peel Region" is worn
 * by ads in Brampton, Orangeville and Vaughan alike. Two things depended on getting this right:
 * a genuine Mississauga listing was being rejected because its label was not a municipality,
 * and the dedup fingerprint now includes the canonical city, so a wrong one splits a single unit
 * into two fingerprints and notifies it twice.
 */
describe('cityFromAddress', () => {
  it.each([
    ['140 Franklin St., Kitchener, ON, N2A 1Y2', 'Kitchener'],
    ['Eglinton Ave E, North York, ON M3C 0S1', 'North York'],
    ['2770 Jane Street, Toronto, ON, M3N 2J1', 'Toronto'],
    ['10480 Islington Ave., Vaughan, ON L0J 1C0', 'Vaughan'],
    ['8 First Avenue, Orangeville, ON, L9W 1H8', 'Orangeville'],
  ])('reads the municipality out of %s', (address, expected) => {
    expect(cityFromAddress(address)).toBe(expected);
  });

  /** Real Kijiji shapes: the province is often missing and the postal code sometimes truncated. */
  it.each([
    ['Earl Grey Crescent, Brampton, L7A 2L2', 'Brampton'],
    ['Linkdale Rd, Brampton, ON L6V', 'Brampton'],
    ['Brampton, ON L6R 0E2', 'Brampton'],
  ])('copes with a partial tail in %s', (address, expected) => {
    expect(cityFromAddress(address)).toBe(expected);
  });

  /** Null rather than a guess, so the caller can fall back to whatever label it has. */
  it.each([['L7A2G6'], ['100 Queens Quay W'], ['Earl Grey Crescent'], [''], [null]])(
    'returns null for %s, which names no municipality',
    (address) => {
      expect(cityFromAddress(address)).toBeNull();
    },
  );

  /** A street line must never be mistaken for a city, however city-like it reads. */
  it('never returns a street', () => {
    expect(cityFromAddress('42 Wellesley Street East')).toBeNull();
    expect(cityFromAddress('1 King Street West, Hamilton, ON')).toBe('Hamilton');
  });

  /**
   * Municipalities ending in a compass direction. The first version of this derived its street
   * types from the abbreviation table, which also holds north/south/east/west — so every one of
   * these returned null and fell back to the region label, quietly putting the wrong city on the
   * listing and therefore into its dedup fingerprint.
   */
  it.each([
    ['12 Main St, Stoney Creek West, ON L8E 1A1', 'Stoney Creek West'],
    ['1 King St, Perth East, ON', 'Perth East'],
    ['5 Elm Rd, Bradford West Gwillimbury, ON', 'Bradford West Gwillimbury'],
  ])('keeps the direction when it is part of the name: %s', (address, expected) => {
    expect(cityFromAddress(address)).toBe(expected);
  });

  /**
   * ...while still rejecting a street line that ends in one. This is why only the last word is
   * expanded through the abbreviation table.
   */
  it.each([['Main Street West'], ['Queens Quay W'], ['Eglinton Avenue East'], ['Linkdale Rd']])(
    'still rejects the street line %s',
    (address) => {
      expect(cityFromAddress(address)).toBeNull();
    },
  );

  /** "St." is a saint, not a street — expanding every word would lose two real cities. */
  it.each([
    ['20 Water St, St. Marys, ON', 'St. Marys'],
    ['9 Ontario St, St. Catharines, ON', 'St. Catharines'],
  ])('does not turn a saint into a street: %s', (address, expected) => {
    expect(cityFromAddress(address)).toBe(expected);
  });
});

/**
 * Label shapes the 905 targets actually produce. Each of these was rejected by the allowlist
 * before, for a reason that was ours rather than the source's.
 */
describe('city labels from the 905 targets', () => {
  it('reads through a parenthesised qualifier', () => {
    expect(canonicalMunicipality('Mississauga (City Centre)')).toBe('mississauga');
    expect(cityMatches('Mississauga (City Centre)', ['Mississauga'])).toBe(true);
    expect(cityMatches('Cambridge (Galt)', ['Cambridge'])).toBe(true);
  });

  /** A qualifier naming a refused area still resolves to the municipality: the cut is positional. */
  it('does not let a qualifier change which municipality it is', () => {
    expect(canonicalMunicipality('Toronto (Scarborough)')).toBe('toronto');
  });

  /** A region label is not a municipality, and must not be treated as one. */
  it('does not match a region label against a city', () => {
    expect(cityMatches('Mississauga / Peel Region', ['Mississauga'])).toBe(false);
    expect(cityMatches('Kitchener / Waterloo', ['Cambridge'])).toBe(false);
  });
});
