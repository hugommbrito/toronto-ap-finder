import {
  buildingKeys,
  geoMatchAllowed,
  houseNumber,
  listingKey,
  preferred,
  withoutTrailingDirection,
  type MatchTier,
} from './address-match';

export interface RentSafeBuilding {
  rsn: string;
  siteAddress: string;
  score: number;
  evaluatedOn: string | null;
  yearBuilt: number | null;
  lat: number | null;
  lng: number | null;
}

export interface RentSafeMatch {
  building: RentSafeBuilding;
  tier: MatchTier;
}

/**
 * The City's inspected buildings, in memory, keyed for lookup.
 *
 * Held in memory for the same reason the geography index is: 3,585 buildings is a few hundred
 * kilobytes, the scoring maths runs over an in-memory snapshot so that every component can be
 * unit tested without a database, and a per-listing address query would be a round trip inside
 * the hot path for a fact that changes twice a year.
 */
export class RentSafeIndex {
  private readonly byKey = new Map<string, RentSafeBuilding>();
  /** Only the buildings with a coordinate; the geographic tier cannot use the others. */
  private readonly located: Array<{ building: RentSafeBuilding; numbers: number[] }> = [];

  constructor(buildings: RentSafeBuilding[]) {
    for (const building of buildings) {
      const keys = buildingKeys(building.siteAddress);
      for (const key of keys) {
        const held = this.byKey.get(key);
        // Two buildings can normalise onto one key. Resolved deterministically rather than by
        // arrival order, so the same input gives the same answer on every run.
        this.byKey.set(key, held ? preferred(held, building) : building);
      }
      if (building.lat !== null && building.lng !== null) {
        const numbers = keys.map(houseNumber).filter((n): n is number => n !== null);
        this.located.push({ building, numbers });
      }
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * The building an advertisement is in, if it can be established.
   *
   * Three tiers, tried in order, and the order is the point: an address match is a fact, and a
   * coordinate match is an inference that is only allowed to confirm a house number the address
   * already agreed on. A listing with no house number gets `null` rather than a nearby guess —
   * 72 of 219 Kijiji listings are in that state, and attaching a real inspection score to a
   * postal-code centroid would be inventing evidence, not extending coverage.
   */
  match(listing: { address: string | null; lat: number | null; lng: number | null }): RentSafeMatch | null {
    const key = listingKey(listing.address);
    if (key === null) return null;

    const exact = this.byKey.get(key);
    if (exact) return { building: exact, tier: this.tierFor(exact, key) };

    // A trailing compass direction is frequently spurious on the listing side.
    const undirected = withoutTrailingDirection(key);
    if (undirected) {
      const hit = this.byKey.get(undirected);
      if (hit) return { building: hit, tier: this.tierFor(hit, undirected) };
    }

    const number = houseNumber(key);
    for (const candidate of this.located) {
      if (
        geoMatchAllowed(
          { lat: listing.lat, lng: listing.lng, houseNumber: number },
          { lat: candidate.building.lat, lng: candidate.building.lng, numbers: candidate.numbers },
        )
      ) {
        return { building: candidate.building, tier: 'geo' };
      }
    }

    return null;
  }

  /** `exact` when the key is the building's own address, `range` when it came from an expansion. */
  private tierFor(building: RentSafeBuilding, key: string): MatchTier {
    return /^\s*\d+\s*-\s*\d+\s/.test(building.siteAddress) && key !== building.siteAddress
      ? 'range'
      : 'exact';
  }
}

/** Empty, for a database that has never been seeded — every buildingScore is simply null. */
export const EMPTY_RENTSAFE_INDEX = new RentSafeIndex([]);
