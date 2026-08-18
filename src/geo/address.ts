import { createHash } from 'node:crypto';

const STREET_ABBREVIATIONS: Record<string, string> = {
  st: 'street',
  str: 'street',
  ave: 'avenue',
  av: 'avenue',
  rd: 'road',
  dr: 'drive',
  blvd: 'boulevard',
  cres: 'crescent',
  crt: 'court',
  ct: 'court',
  pl: 'place',
  ln: 'lane',
  hwy: 'highway',
  pkwy: 'parkway',
  sq: 'square',
  ter: 'terrace',
  trl: 'trail',
  gdns: 'gardens',
  hts: 'heights',
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
};

/** Unit/suite designators, stripped so that "12 Main St #501" and "12 Main Street" agree. */
const UNIT_PATTERN =
  /\b(?:unit|suite|ste|apt|apartment|ph|penthouse|basement|bsmt|lower|upper|main\s*floor)\b\.?\s*#?\s*[\w-]*/gi;
const HASH_UNIT_PATTERN = /#\s*[\w-]+/g;
/** Combining marks left behind by NFD decomposition. */
const DIACRITIC_PATTERN = /\p{M}/gu;
const POSTAL_CODE_PATTERN = /\b[a-z]\d[a-z]\s*\d[a-z]\d\b/g;

/**
 * Canonical form of a street address, used both for the dedup fingerprint and as the
 * geocode cache key. Aggressive on purpose: the same building is advertised as
 * "100 Queens Quay W. Unit 2201", "100 Queens Quay West #2201" and "100 queens quay w".
 *
 * Only the street line survives. Sources disagree about whether to append the city —
 * Kijiji sends "2770 Jane Street, Toronto, ON, M3N 2J1" where another site sends just
 * "2770 Jane Street" — and keeping that tail would give the same building two
 * fingerprints, which is precisely the duplicate notification this is meant to prevent.
 * The city is carried as its own field on the listing, so nothing is lost.
 */
export function normalizeAddress(input: string | null | undefined): string {
  if (!input) return '';

  let s = input.toLowerCase();

  // Units first: "Unit 501, 100 Queens Quay" must not leave "unit 501" as the street line.
  s = s.replace(POSTAL_CODE_PATTERN, ' ');
  s = s.replace(UNIT_PATTERN, ' ');
  s = s.replace(HASH_UNIT_PATTERN, ' ');

  s = s.normalize('NFD').replace(DIACRITIC_PATTERN, '');

  // A street line needs a number and a name; the first segment that has both is the address.
  const segments = s.split(',').map((seg) => seg.trim());
  const streetLine = segments.find((seg) => /\d/.test(seg) && /[a-z]/.test(seg)) ?? s;

  const tokens = streetLine
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_ABBREVIATIONS[t] ?? t)
    .filter((t) => t !== 'on' && t !== 'ontario' && t !== 'canada');

  return tokens.join(' ').trim();
}

/**
 * Groups the same physical unit across sources. The $50 rent bucket absorbs the small
 * price differences the same landlord posts on different sites.
 */
export function buildFingerprint(params: {
  address: string | null;
  beds: number | null;
  dens: number;
  rentBase: number;
  fallback: string;
}): string {
  const normalized = normalizeAddress(params.address);

  // Without an address there is nothing to match on; fall back to a source-unique value so
  // the ad still gets a stable fingerprint instead of colliding with every other addressless ad.
  const key = normalized
    ? `${normalized}|${params.beds ?? '?'}+${params.dens}|${Math.round(params.rentBase / 50)}`
    : `nofp|${params.fallback}`;

  return createHash('sha256').update(key).digest('hex');
}

export function addressCacheKey(address: string): string {
  return createHash('sha256').update(normalizeAddress(address)).digest('hex');
}
