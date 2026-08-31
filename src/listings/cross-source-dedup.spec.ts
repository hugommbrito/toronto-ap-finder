import { describe, expect, it } from 'vitest';
import { buildFingerprint, normalizeAddress } from '@/geo/address';

/**
 * The Phase 3 promise: the same physical unit advertised on two sites is notified once.
 *
 * Written against the shapes the two adapters actually produce, not invented ones — Kijiji
 * sends the address with the city and postal code appended and knows about dens; Zumper sends
 * a bare street line, inherits the building's address for every floorplan, and has no den
 * field anywhere.
 */
const fp = (
  address: string | null,
  beds: number | null,
  dens: number,
  rentBase: number,
  fallback: string,
  // Defaulted because these cases are all about *address formatting* across sources, and both
  // adapters do carry a city field regardless of whether they inline it into the address.
  city: string | null = 'Toronto',
) => buildFingerprint({ address, city, beds, dens, rentBase, fallback });

describe('cross-source dedup', () => {
  it('matches the same unit across the two sources despite different address formats', () => {
    const kijiji = fp('2770 Jane Street, Toronto, ON, M3N 2J1', 3, 0, 2750, 'kijiji:1');
    const zumper = fp('2770 Jane St', 3, 0, 2750, 'zumper:2');
    expect(zumper).toBe(kijiji);
  });

  it('absorbs the small price differences a landlord posts on different sites', () => {
    // Same unit, $2,740 on one site and $2,755 on the other: one $50 bucket.
    expect(fp('100 Queens Quay W', 2, 0, 2740, 'a')).toBe(fp('100 Queens Quay W', 2, 0, 2755, 'b'));
  });

  it('survives the unit number Zumper omits and Kijiji includes', () => {
    const withUnit = fp('Unit 501, 100 Queens Quay West', 2, 0, 2900, 'kijiji:3');
    const without = fp('100 Queens Quay W.', 2, 0, 2900, 'zumper:4');
    expect(without).toBe(withUnit);
  });

  it('collapses identical floorplans in one building into a single fingerprint', () => {
    // The Diamond advertises three separate 3BR floorplans at $3,738. For someone deciding
    // where to live these are one offering, and one notification is the right number.
    const a = fp('950 Lansdowne Ave', 3, 0, 3738, 'zumper:10');
    const b = fp('950 Lansdowne Ave', 3, 0, 3738, 'zumper:11');
    expect(b).toBe(a);
  });

  it('keeps genuinely different units in the same building apart', () => {
    const twoBed = fp('950 Lansdowne Ave', 2, 0, 2825, 'zumper:20');
    const threeBed = fp('950 Lansdowne Ave', 3, 0, 3025, 'zumper:21');
    expect(threeBed).not.toBe(twoBed);
  });

  it('does not collide two addressless listings into one', () => {
    expect(fp(null, 2, 0, 2500, 'kijiji:30')).not.toBe(fp(null, 2, 0, 2500, 'zumper:31'));
  });

  /**
   * A known, accepted gap — asserted so it stays visible rather than being discovered as a
   * duplicate notification months from now.
   *
   * Zumper has no den field and publishes no prose in which a den could be named, so every
   * unit it reports has `dens: 0`. A 2BR+den that appears on both sites is therefore
   * `2+1` on Kijiji and `2+0` on Zumper, and the two do not match.
   *
   * Leaving dens out of the fingerprint would fix this and cause something worse: a 2BR and
   * a 2BR+den at the same address and price are different homes, and the whole bedroom
   * ladder rests on telling them apart. A duplicate notification is the cheaper error.
   */
  it('cannot match a den unit across the two sources, and that is the accepted trade', () => {
    const kijiji = fp('100 Queens Quay W', 2, 1, 2900, 'kijiji:40');
    const zumper = fp('100 Queens Quay W', 2, 0, 2900, 'zumper:41');
    expect(zumper).not.toBe(kijiji);
  });

  it('normalizes the street forms the two sources disagree about', () => {
    const canonical = normalizeAddress('2770 Jane Street, Toronto, ON, M3N 2J1');
    for (const variant of ['2770 Jane St', '2770 Jane St.', '2770 jane street', 'Unit 4, 2770 Jane Street']) {
      expect(normalizeAddress(variant)).toBe(canonical);
    }
  });
});

/**
 * The 905 expansion's sharpest hazard, pinned here because nothing about it looks like a bug.
 *
 * `normalizeAddress` discards the city deliberately, so before the city joined the fingerprint
 * these two hashed identically. `notifications` is uniquely indexed on
 * (profile_id, fingerprint), so the consequence was not a mis-grouped pair — it was the second
 * city's listing never being sent, with a clean log.
 */
describe('cross-city collisions', () => {
  it('keeps the same street in two cities apart', () => {
    const toronto = fp('100 Main Street', 2, 0, 2500, 'kijiji:1', 'Toronto');
    const mississauga = fp('100 Main Street', 2, 0, 2500, 'kijiji:2', 'Mississauga');
    const cambridge = fp('100 Main Street', 2, 0, 2500, 'kijiji:3', 'Cambridge');
    expect(new Set([toronto, mississauga, cambridge]).size).toBe(3);
  });

  /** Street names that actually repeat across Ontario municipalities. */
  it.each(['King Street West', 'Queen Street', 'Victoria Street', 'Main Street North'])(
    'separates %s across cities',
    (street) => {
      expect(fp(`50 ${street}`, 3, 0, 2900, 'a', 'Mississauga')).not.toBe(
        fp(`50 ${street}`, 3, 0, 2900, 'b', 'Cambridge'),
      );
    },
  );

  /**
   * And the flip side: amalgamation must keep working. A Kijiji ad labelled "North York" and a
   * CAPREIT building labelled "Toronto" at the same address are the same unit, and grouping
   * them is the entire point of canonicalising rather than using the raw label.
   */
  it('still groups an amalgamated label with Toronto', () => {
    expect(fp('2770 Jane Street', 3, 0, 2750, 'a', 'North York')).toBe(
      fp('2770 Jane St', 3, 0, 2750, 'b', 'Toronto'),
    );
  });
});
