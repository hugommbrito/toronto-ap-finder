import { normalizeAddress } from '@/geo/address';
import { haversineMeters } from '@/geo/distance';

/**
 * Joining an advertisement to a City-inspected building, by address.
 *
 * Measured before it was written, which is what shaped it. On the City side the data is almost
 * perfectly clean: 3,585 buildings produce 3,583 distinct normalised keys, there is not a single
 * letter-suffixed house number (`123A`) in the whole file, and no ampersands. Every difficulty is
 * on the listing side, where the address is whatever a landlord typed.
 *
 * So the City side gets extra *keys* and the listing side gets *canonicalisation*, and the two
 * meet in a map lookup. Nothing here mutates `normalizeAddress`: `buildFingerprint` calls it, and
 * the notifications index is on `(profile_id, fingerprint)`, so widening it would change the
 * fingerprint of every listing on the affected streets and re-notify each one once.
 */

/**
 * Street types the repository's own abbreviation table does not carry.
 *
 * Measured: 18 buildings are affected. Every other unknown token in the City file is already a
 * full word — `KINGSWAY`, `ESPLANADE`, `QUAY` — which both sides spell the same way.
 */
const EXTRA_STREET_TYPES: Record<string, string> = {
  crct: 'circuit',
  crcl: 'circle',
  grv: 'grove',
  gt: 'gate',
};

/** Longest span a range address may cover before it is treated as a typo rather than a building. */
const MAX_RANGE_SPAN = 80;
/** How close a coordinate match has to be, once the house number already agrees. */
export const GEO_TOLERANCE_M = 150;

export type MatchTier = 'exact' | 'range' | 'geo';

function expandStreetTypes(key: string): string {
  return key
    .split(' ')
    .map((token) => EXTRA_STREET_TYPES[token] ?? token)
    .join(' ');
}

/**
 * Every key under which a City building should be findable.
 *
 * The range expansion is not optional. `277-283 ST GEORGE ST` normalises to
 * `277 283 st george street`, which no listing will ever produce — 72 buildings are addressed
 * that way, and without expansion all of them are permanently unmatchable.
 */
export function buildingKeys(siteAddress: string): string[] {
  const plain = normalizeAddress(siteAddress);
  const keys = new Set<string>();
  if (plain) {
    keys.add(plain);
    keys.add(expandStreetTypes(plain));
  }

  const range = siteAddress.match(/^\s*(\d+)\s*-\s*(\d+)\s+(.+)$/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (high > low && high - low <= MAX_RANGE_SPAN) {
      // Addresses on a street run odd on one side and even on the other, so a span whose ends
      // share parity names only its own side. A mixed span is taken one by one rather than
      // guessing which side the building is on.
      const step = (high - low) % 2 === 0 ? 2 : 1;
      for (let n = low; n <= high; n += step) {
        const key = expandStreetTypes(normalizeAddress(`${n} ${range[3]}`));
        if (key) keys.add(key);
      }
    }
  }

  return [...keys];
}

/**
 * The listing's address, reduced to something the City index could plausibly hold.
 *
 * Three real shapes drive this, all from live Kijiji data:
 *
 * - `MAIN #2 - 591 OAKWOOD AVENUE` — a unit designator `normalizeAddress` does not strip,
 *   because "main" only means a floor when it is followed by "floor".
 * - `UNIT B2 - 32 HIGH PARK BLVD BOULEVARD` — the street type written twice, once abbreviated
 *   and once expanded, which normalisation turns into a doubled word.
 * - `Toronto, ON M6J 2V6` — no house number at all. 72 of 219 Kijiji listings look like this,
 *   and they are unmatchable by address: returning null is the honest answer, and the geographic
 *   tier deliberately will not rescue them.
 */
export function listingKey(address: string | null | undefined): string | null {
  const normalized = expandStreetTypes(normalizeAddress(address));
  if (!normalized) return null;

  // Everything before the first bare number is a unit designator, a floor, or a building name.
  const fromNumber = normalized.replace(/^\D*?(?=\b\d)/, '');
  if (!/^\d/.test(fromNumber)) return null;

  const tokens = fromNumber.split(' ').filter(Boolean);
  const deduped = tokens.filter((token, i) => i === 0 || token !== tokens[i - 1]);
  return deduped.join(' ');
}

/** A trailing compass direction is frequently spurious on the listing side (`5 RICHGROVE DRIVE E`). */
export function withoutTrailingDirection(key: string): string | null {
  const stripped = key.replace(/\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)$/, '');
  return stripped === key ? null : stripped;
}

/** The house number a key starts with, which is what the geographic tier is gated on. */
export function houseNumber(key: string): number | null {
  const match = key.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

export interface MatchCandidate {
  rsn: string;
  keys: string[];
  lat: number | null;
  lng: number | null;
  score: number;
  evaluatedOn: string | null;
}

export interface MatchResult<T> {
  building: T;
  tier: MatchTier;
}

/**
 * Two buildings can normalise onto one key — measured: two of 3,585, `33 FLAMBOROUGH DR UNIT
 * B/C/D` scoring 97, 100 and 97. Resolved by the most recent evaluation, then by the lower RSN,
 * so the answer is the same on every run rather than whichever row arrived first.
 */
export function preferred<T extends { rsn: string; evaluatedOn: string | null }>(a: T, b: T): T {
  const byDate = (b.evaluatedOn ?? '').localeCompare(a.evaluatedOn ?? '');
  if (byDate !== 0) return byDate < 0 ? a : b;
  return a.rsn.localeCompare(b.rsn) <= 0 ? a : b;
}

/**
 * Whether a coordinate match is allowed to stand.
 *
 * Gated on the house number agreeing, and that gate is the whole point. Ungated, proximity alone
 * matched `East York, ON M4B 1N7` to `2908 ST CLAIR AVE E` — a postal-code centroid that happens
 * to land near a building. That is not a weak match, it is an invented fact, and it would have
 * attached a real inspection score to the wrong address.
 */
export function geoMatchAllowed(
  listing: { lat: number | null; lng: number | null; houseNumber: number | null },
  building: { lat: number | null; lng: number | null; numbers: number[] },
): boolean {
  if (listing.lat === null || listing.lng === null) return false;
  if (building.lat === null || building.lng === null) return false;
  if (listing.houseNumber === null) return false;
  if (!building.numbers.includes(listing.houseNumber)) return false;

  const metres = haversineMeters(
    { lat: listing.lat, lng: listing.lng },
    { lat: building.lat, lng: building.lng },
  );
  return metres <= GEO_TOLERANCE_M;
}
