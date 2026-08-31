import { describe, expect, it } from 'vitest';
import { daycareCoverageOf, regionOf, SEEDED_REGIONS } from './coverage';

/**
 * Coverage is a claim about our data, never about the place — so the two things worth pinning are
 * that every allowlisted municipality resolves, and that an unknown one degrades to "we do not
 * know" rather than to "there is nothing there".
 */
describe('daycare coverage by municipality', () => {
  it('treats the whole amalgamated 416 as fully covered', () => {
    for (const label of [
      'Toronto',
      'City of Toronto',
      'North York',
      'Etobicoke',
      'Scarborough',
      'East York',
      'York',
      'Old Toronto',
      'Toronto, ON',
    ]) {
      expect(daycareCoverageOf(label)).toBe('full');
    }
  });

  it('covers every municipality of a seeded region, not just the ones in the profile', () => {
    // The dataset covers all of Peel and all of Waterloo; claiming otherwise would be a lie the
    // moment a profile adds Brampton.
    for (const label of ['Mississauga', 'Brampton', 'Caledon']) {
      expect(regionOf(label)?.key).toBe('peel');
    }
    for (const label of ['Cambridge', 'Kitchener', 'Waterloo', 'North Dumfries']) {
      expect(regionOf(label)?.key).toBe('waterloo');
    }
    expect(daycareCoverageOf('Mississauga')).toBe('presenceOnly');
    expect(daycareCoverageOf('Cambridge')).toBe('presenceOnly');
  });

  it('reads through the label shapes the sources actually send', () => {
    expect(daycareCoverageOf('Mississauga (City Centre)')).toBe('presenceOnly');
    expect(daycareCoverageOf('City of Cambridge')).toBe('presenceOnly');
  });

  /** A region label is not a municipality; it must not be resolved as one. */
  it('does not resolve a region label', () => {
    expect(regionOf('Mississauga / Peel Region')).toBeNull();
    expect(regionOf('Kitchener / Waterloo')).toBeNull();
  });

  it('degrades to none for anything unseeded, including nothing at all', () => {
    for (const label of ['Wasaga Beach', 'Hamilton', 'Ottawa', '', null, undefined]) {
      expect(daycareCoverageOf(label)).toBe('none');
    }
  });

  /**
   * SEEDED_REGIONS is what `needsSeeding` compares the table against, so a region declared here
   * without a seeder would make every boot re-seed forever.
   */
  it('declares exactly the regions the seed inserts', () => {
    expect(SEEDED_REGIONS.map((r) => r.key)).toEqual(['toronto', 'peel', 'waterloo']);
  });
});
