import { createHash } from 'node:crypto';
import { canonicalMunicipality } from './city';

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
 * Street types, in expanded form. Deliberately **not** derived from STREET_ABBREVIATIONS'
 * values, which also contain the compass directions — those qualify a street, they do not make
 * one, and treating them as street types made `cityFromAddress` reject real municipalities like
 * "Perth East" and "Stoney Creek West".
 *
 * Checked against 77 Ontario municipality names with no false positives.
 */
const STREET_TYPES = new Set([
  'street', 'avenue', 'road', 'drive', 'boulevard', 'crescent', 'court', 'place', 'lane',
  'highway', 'parkway', 'square', 'terrace', 'trail', 'gardens', 'heights', 'circle', 'close',
  'grove', 'mews', 'path', 'ridge', 'row', 'walk', 'way', 'gate', 'green', 'park', 'quay',
]);

const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

const PROVINCE_OR_POSTAL = /^(?:on|ont|ontario|canada)?[\s,]*(?:[a-z]\d[a-z]\s*\d?[a-z]?\d?)?$/i;

/**
 * Whether an address segment is a street line rather than a municipality.
 *
 * Only the **last** word is expanded through the abbreviation table, and that restriction is
 * load-bearing: expanding every word turns "St. Marys" and "St. Catharines" into "street ..."
 * and throws away two real cities. A trailing direction is dropped first, so "Queens Quay W"
 * still resolves to `quay` while "Perth East" resolves to `perth`.
 */
function looksLikeStreet(words: string[]): boolean {
  const trimmed = [...words];
  while (trimmed.length > 1 && DIRECTIONS.has(trimmed[trimmed.length - 1]!)) trimmed.pop();
  if (trimmed.length === 0) return false;

  const last = trimmed[trimmed.length - 1]!;
  if (STREET_TYPES.has(STREET_ABBREVIATIONS[last] ?? last)) return true;
  // A fully spelled street type anywhere also settles it, without expanding — so "st" in
  // "St. Marys" stays a saint.
  return trimmed.some((w) => STREET_TYPES.has(w));
}

/**
 * The municipality named inside a full address, or null when the address does not carry one.
 *
 * Needed because a source's own city field is not always a municipality. Kijiji labels an ad
 * with the *region* it was found in — "Mississauga / Peel Region", "Kitchener / Waterloo" —
 * while `location.address` says where it actually is, and those disagree for most of Peel. It
 * matters twice over: `cityMatches` was discarding genuine Mississauga listings because the
 * label was a region rather than a city, and the dedup fingerprint includes the canonical
 * municipality, so a wrong city splits one unit into two fingerprints and notifies it twice.
 *
 * Scans from the end, past the province and postal code, for the last segment that is neither
 * numbered nor a street line. Returns null rather than guessing, so the caller can fall back.
 */
export function cityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;

  const segments = address
    .split(',')
    .map((seg) => seg.trim())
    .filter(Boolean)
    // "ON", "M3C 0S1" and "ON M3C 0S1" all carry no municipality.
    .filter((seg) => !PROVINCE_OR_POSTAL.test(seg));

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i]!;
    if (/\d/.test(seg)) continue;
    const words = seg.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 0 || looksLikeStreet(words)) continue;
    return seg;
  }

  return null;
}

/**
 * Groups the same physical unit across sources. The $50 rent bucket absorbs the small
 * price differences the same landlord posts on different sites.
 */
export function buildFingerprint(params: {
  address: string | null;
  /**
   * Required, because leaving it out is a real duplicate-suppression bug once the search spans
   * more than one municipality.
   *
   * `normalizeAddress` drops the city on purpose — sources disagree about whether to append it,
   * and keeping that tail would give one building two fingerprints. That was correct while
   * every listing was in Toronto. It stops being correct the moment Mississauga is in scope:
   * "100 Main Street, 2BR, $2,500" exists in both, street names repeat heavily across Ontario
   * (Main, King, Queen, Victoria), and the $50 rent bucket widens the window further. Since
   * `notifications` is uniquely indexed on (profile_id, fingerprint), the second city's listing
   * would not merely be mis-grouped — it would never be sent, and nothing would look wrong.
   *
   * Canonicalised, so the amalgamated Toronto names still collapse onto one another: a source
   * calling a listing "North York" and one calling it "Toronto" must keep agreeing.
   */
  city: string | null;
  beds: number | null;
  dens: number;
  rentBase: number;
  fallback: string;
}): string {
  const normalized = normalizeAddress(params.address);
  const place = canonicalMunicipality(params.city) || '?';

  // Without an address there is nothing to match on; fall back to a source-unique value so
  // the ad still gets a stable fingerprint instead of colliding with every other addressless ad.
  const key = normalized
    ? `${normalized}|${place}|${params.beds ?? '?'}+${params.dens}|${Math.round(params.rentBase / 50)}`
    : `nofp|${params.fallback}`;

  return createHash('sha256').update(key).digest('hex');
}

export function addressCacheKey(address: string): string {
  return createHash('sha256').update(normalizeAddress(address)).digest('hex');
}
