import { describe, expect, it } from 'vitest';
import { haversineMeters, walkingMeters } from './distance';
import { buildFingerprint, normalizeAddress } from './address';
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
  const base = { address: '100 Queens Quay W, Toronto, ON', beds: 2, dens: 1, rentBase: 3000, fallback: 'a' };

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
