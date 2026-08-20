import { afterEach, describe, expect, it } from 'vitest';
import { areaContaining, excludedAreaOf, setMunicipalBoundaries } from './areas';

/** Real addresses, checked against the committed 1998 boundaries. */
const SCARBOROUGH_GOLF = { lat: 43.7608, lng: -79.21562 }; // 567 Scarborough Golf Club Rd
const THORNCLIFFE_PARK = { lat: 43.7043, lng: -79.3445 };
const LEASIDE = { lat: 43.7085, lng: -79.369 };
const UNION_STATION = { lat: 43.6453, lng: -79.3806 };
const NORTH_YORK_CENTRE = { lat: 43.7683, lng: -79.4128 };
const KIPLING_STATION = { lat: 43.6375, lng: -79.5356 };
const MISSISSAUGA = { lat: 43.5931, lng: -79.6425 };

const REFUSED = ['Scarborough', 'East York', 'Brampton'];

afterEach(() => {
  // Back to reading the committed boundaries.
  setMunicipalBoundaries(null);
});

describe('areaContaining', () => {
  it('places real addresses in the municipality they were in before 1998', () => {
    expect(areaContaining(SCARBOROUGH_GOLF)).toBe('Scarborough');
    expect(areaContaining(THORNCLIFFE_PARK)).toBe('East York');
    expect(areaContaining(LEASIDE)).toBe('East York');
    expect(areaContaining(UNION_STATION)).toBe('Old Toronto');
    expect(areaContaining(NORTH_YORK_CENTRE)).toBe('North York');
    expect(areaContaining(KIPLING_STATION)).toBe('Etobicoke');
  });

  it('separates the two sides of Victoria Park Avenue', () => {
    // The Scarborough line runs down Victoria Park Ave, so on Danforth the refusal turns on
    // about 300 m. Being able to resolve that is why these are real outlines and not boxes.
    expect(areaContaining({ lat: 43.685, lng: -79.2855 })).toBe('Scarborough');
    expect(areaContaining({ lat: 43.685, lng: -79.2895 })).toBe('Old Toronto');
  });

  it('returns null outside the city', () => {
    expect(areaContaining(MISSISSAUGA)).toBeNull();
  });
});

describe('excludedAreaOf', () => {
  it('cuts a Scarborough listing that calls itself Toronto', () => {
    // The case the city allowlist cannot catch: amalgamation makes the label truthful.
    expect(excludedAreaOf({ city: 'Toronto', ...SCARBOROUGH_GOLF }, REFUSED)).toEqual({
      kind: 'inside',
      area: 'Scarborough',
      by: 'coordinates',
    });
  });

  it('cuts an East York listing labelled City of Toronto', () => {
    const verdict = excludedAreaOf({ city: 'City of Toronto', ...THORNCLIFFE_PARK }, REFUSED);
    expect(verdict).toMatchObject({ kind: 'inside', area: 'East York' });
  });

  it('cuts on the label when there are no coordinates', () => {
    expect(excludedAreaOf({ city: 'Scarborough', lat: null, lng: null }, REFUSED)).toEqual({
      kind: 'inside',
      area: 'Scarborough',
      by: 'label',
    });
  });

  it('cuts Brampton by name, which needs no geometry', () => {
    expect(excludedAreaOf({ city: 'Brampton', lat: 43.685, lng: -79.76 }, REFUSED)).toEqual({
      kind: 'inside',
      area: 'Brampton',
      by: 'label',
    });
  });

  it('keeps the rest of the 416', () => {
    expect(excludedAreaOf({ city: 'Toronto', ...UNION_STATION }, REFUSED).kind).toBe('outside');
    expect(excludedAreaOf({ city: 'North York', ...NORTH_YORK_CENTRE }, REFUSED).kind).toBe('outside');
    expect(excludedAreaOf({ city: 'Etobicoke', ...KIPLING_STATION }, REFUSED).kind).toBe('outside');
  });

  it('is inert for a profile that excludes nothing', () => {
    expect(excludedAreaOf({ city: 'Toronto', ...SCARBOROUGH_GOLF }, []).kind).toBe('outside');
  });

  it('holds back a listing whose area cannot be determined rather than passing it', () => {
    // A Toronto label with no coordinates could be anywhere in the city, Scarborough included.
    const verdict = excludedAreaOf({ city: 'Toronto', lat: null, lng: null }, REFUSED);
    expect(verdict.kind).toBe('unknown');
    expect(verdict).toMatchObject({ field: 'coordinates' });
  });

  it('needs no coordinates when every refused area names its own municipality', () => {
    expect(excludedAreaOf({ city: 'Toronto', lat: null, lng: null }, ['Brampton']).kind).toBe('outside');
  });

  it('refuses to guess when the boundary data is missing', () => {
    // Losing the seed file must not quietly turn a hard cut into a pass.
    setMunicipalBoundaries([]);
    const verdict = excludedAreaOf({ city: 'Toronto', ...SCARBOROUGH_GOLF }, REFUSED);
    expect(verdict.kind).toBe('unknown');
    expect(verdict).toMatchObject({ field: 'excludeAreas' });
  });
});
