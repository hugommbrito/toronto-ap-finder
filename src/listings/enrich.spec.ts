import { describe, expect, it } from 'vitest';
import { computeTotalMonthlyCost, enrichFromText, layoutConflictOf } from './enrich';
import type { TriageListing } from './listing.types';

function triage(overrides: Partial<TriageListing> = {}): TriageListing {
  return {
    source: 'kijiji',
    sourceId: '1',
    url: 'https://www.kijiji.ca/v-apartments-condos/city-of-toronto/x/1',
    title: 'Test',
    rawText: null,
    rentBase: 3000,
    parkingIncluded: null,
    parkingCost: null,
    parkingAvailable: null,
    utilitiesIncluded: [],
    totalMonthlyCost: 3000,
    beds: 2,
    dens: 0,
    baths: 1,
    areaSqft: null,
    hasLocker: null,
    inSuiteLaundry: null,
    address: '100 Queens Quay W, Toronto, ON',
    city: 'City of Toronto',
    lat: 43.64,
    lng: -79.38,
    availableFrom: null,
    postedAt: null,
    buildingBuiltBefore2018: null,
    ...overrides,
  };
}

describe('computeTotalMonthlyCost', () => {
  it('adds paid parking to the rent', () => {
    expect(computeTotalMonthlyCost(3000, false, 150)).toBe(3150);
  });

  it('adds nothing when parking is already included', () => {
    expect(computeTotalMonthlyCost(3000, true, 150)).toBe(3000);
  });

  it('adds nothing when parking is simply unknown', () => {
    expect(computeTotalMonthlyCost(3000, null, null)).toBe(3000);
  });
});

describe('enrichFromText', () => {
  it('fills the gaps the structured data left open', () => {
    const result = enrichFromText(
      triage(),
      '<p>Bright suite with in-suite laundry and a storage locker. Parking available for $150/month.</p>',
    );
    expect(result.hasLocker).toBe(true);
    expect(result.inSuiteLaundry).toBe(true);
    expect(result.parkingCost).toBe(150);
    expect(result.totalMonthlyCost).toBe(3150);
  });

  it('never argues with a structured positive', () => {
    // The source asserted parking is included; ad text mentioning a price must not undo that.
    const result = enrichFromText(
      triage({ parkingIncluded: true }),
      '<p>Extra parking available for $200/month.</p>',
    );
    expect(result.parkingIncluded).toBe(true);
    expect(result.parkingCost).toBeNull();
    expect(result.totalMonthlyCost).toBe(3000);
  });

  it('upgrades a missed den from the text', () => {
    // Posters write "2+1" in the title and leave the dropdown at 2.
    const result = enrichFromText(triage({ beds: 2, dens: 0 }), '<p>Spacious 2+1 with a large den.</p>');
    expect(result.dens).toBe(1);
  });

  it('reads the title too, where the den often is', () => {
    // Verbatim from a live cycle: the den was in the title and nowhere in the body, so
    // matching the body alone scored a genuine 2BR+den as a plain 2BR.
    const result = enrichFromText(
      triage({ title: "Renovated 2 Bdm. + Den for Rent in Toronto's Danforth Village", beds: 2, dens: 0 }),
      '<p>Live well at Main Square Apartments, surrounded by convenience.</p>',
    );
    expect(result.dens).toBe(1);
  });

  /**
   * The bug that let 1BR+den listings arrive highly ranked. Kijiji's dropdown said 2
   * bedrooms; the ad said "1 bedroom plus den". Upgrading the den on top of the inflated
   * count produced beds:2 dens:1 — the 2BR+den rung, second-best on the ladder.
   */
  it('does not upgrade the den when the text disagrees about the bedroom count', () => {
    const result = enrichFromText(
      triage({ beds: 2, dens: 0 }),
      '<p>Beautiful 1 bedroom plus den, perfect for a couple.</p>',
    );
    expect(result.dens).toBe(0);
  });

  it('still upgrades when the text agrees about the bedroom count', () => {
    const agreeing = enrichFromText(triage({ beds: 2, dens: 0 }), '<p>Spacious 2 bedroom + den.</p>');
    expect(agreeing.dens).toBe(1);
    // "2+1" states the same count in Toronto shorthand.
    const shorthand = enrichFromText(triage({ beds: 2, dens: 0 }), '<p>Bright 2+1 unit.</p>');
    expect(shorthand.dens).toBe(1);
  });

  it('never removes a den the source already reported', () => {
    const result = enrichFromText(triage({ beds: 2, dens: 1 }), '<p>Two bedroom suite.</p>');
    expect(result.dens).toBe(1);
  });

  it('merges structured and textual utilities without duplicates', () => {
    const result = enrichFromText(
      triage({ utilitiesIncluded: ['heat'] }),
      '<p>Rent includes heat and water.</p>',
    );
    expect(result.utilitiesIncluded).toContain('heat');
    expect(result.utilitiesIncluded).toContain('water');
    expect(result.utilitiesIncluded.filter((u) => u === 'heat')).toHaveLength(1);
  });

  it('leaves genuinely unmentioned fields unknown rather than false', () => {
    const result = enrichFromText(triage(), '<p>Close to transit and shops.</p>');
    expect(result.hasLocker).toBeNull();
    expect(result.inSuiteLaundry).toBeNull();
    expect(result.parkingIncluded).toBeNull();
  });

  it('stores the ad body as plain text for later review', () => {
    const result = enrichFromText(triage(), '<p><b>Features</b></p><ul><li>Balcony</li></ul>');
    expect(result.rawText).toContain('Features');
    expect(result.rawText).toContain('Balcony');
    expect(result.rawText).not.toContain('<');
  });

  it('reads the floor area from the text', () => {
    const result = enrichFromText(triage(), '<p>Bright corner suite, 1,050 sq ft with a balcony.</p>');
    expect(result.areaSqft).toBe(1050);
  });

  it('never argues with a structured area', () => {
    const result = enrichFromText(triage({ areaSqft: 950 }), '<p>Approximately 800 sq ft.</p>');
    expect(result.areaSqft).toBe(950);
  });

  /**
   * Regression: the structured parking cost used to be discarded — `parkingFinding.cost`
   * was read where `listing.parkingCost ?? parkingFinding.cost` was meant, so a source's
   * own $175 vanished whenever the ad text stayed silent, and the monthly total with it.
   */
  it('keeps a structured parking cost when the text says nothing', () => {
    const result = enrichFromText(
      triage({ parkingIncluded: false, parkingCost: 175 }),
      '<p>Close to transit and shops.</p>',
    );
    expect(result.parkingCost).toBe(175);
    expect(result.totalMonthlyCost).toBe(3175);
  });

  it('records priceless "parking available" as existence on unstated terms', () => {
    const result = enrichFromText(triage(), '<p>Parking available. Ask the landlord.</p>');
    expect(result.parkingAvailable).toBe(true);
    expect(result.parkingIncluded).toBeNull();
    expect(result.parkingCost).toBeNull();
    // Nothing invented: the unknown cost never reaches the total.
    expect(result.totalMonthlyCost).toBe(3000);
  });

  it('drops the availability claim once stronger parking facts exist', () => {
    const priced = enrichFromText(
      triage({ parkingAvailable: true }),
      '<p>Parking available for $150/month.</p>',
    );
    expect(priced.parkingCost).toBe(150);
    expect(priced.parkingAvailable).toBeNull();
  });
});

describe('layoutConflictOf', () => {
  const withBody = (beds: number, title: string, body: string): TriageListing =>
    enrichFromText(triage({ beds, dens: 0, title }), `<p>${body}</p>`);

  it('reports the disagreement seen in live data', () => {
    // Verbatim shape from a notified listing: dropdown said 2, the ad said 1 + den.
    const listing = withBody(2, '1507 - 135 EAST LIBERTY STREET N', 'Bright 1 bedroom plus den suite.');
    expect(layoutConflictOf(listing)).toEqual({ textBeds: 1, structuredBeds: 2 });
  });

  it('says nothing when the two agree', () => {
    expect(layoutConflictOf(withBody(2, 'Nice suite', 'Spacious 2 bedroom apartment.'))).toBeNull();
  });

  it('says nothing when the ad never states a count', () => {
    expect(layoutConflictOf(withBody(3, 'Nice suite', 'Close to transit and shops.'))).toBeNull();
  });

  it('needs a body — an unhydrated listing cannot conflict', () => {
    expect(layoutConflictOf(triage({ beds: 2, rawText: null }))).toBeNull();
  });
});
