/**
 * City matching for hard filters.
 *
 * Two things make naive string equality wrong here. Sources label the same place
 * differently ("City of Toronto" vs "Toronto"), and North York, Etobicoke, Scarborough,
 * East York and York have been the same municipality as Toronto since the 1998
 * amalgamation — they are neighbourhood names, not separate cities. A profile listing
 * them individually means "anywhere in the 416", and the filter has to agree.
 */
const PREFIXES = /^(?:the\s+)?(?:city|town|borough|municipality|township)\s+of\s+/;
const PROVINCE_SUFFIX = /[,\s]+(?:on|ont|ontario|canada)\s*$/;
/**
 * A parenthesised qualifier narrows a municipality; it never changes which one it is.
 *
 * Kijiji sends "Mississauga (City Centre)", which is Mississauga by any reading, but the
 * non-alpha scrub below turned it into "mississauga city centre" and the allowlist rejected it.
 * Dropping the qualifier is safe even where it names a refused area — "Toronto (Scarborough)"
 * becomes Toronto, and the Scarborough cut is decided by position anyway (see areas.ts),
 * precisely because a label cannot be trusted to make it.
 */
const PARENTHETICAL = /\s*\([^)]*\)/g;

/** Former municipalities amalgamated into the present City of Toronto. */
const TORONTO_AMALGAMATED = new Set([
  'toronto',
  'old toronto',
  'downtown toronto',
  'north york',
  'etobicoke',
  'scarborough',
  'east york',
  'york',
]);

export function normalizeCity(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.toLowerCase().trim();
  s = s.replace(PARENTHETICAL, '');
  s = s.replace(PROVINCE_SUFFIX, '');
  s = s.replace(PREFIXES, '');
  s = s.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/** Canonical municipality, so amalgamated names collapse onto one another. */
export function canonicalMunicipality(raw: string | null | undefined): string {
  const s = normalizeCity(raw);
  return TORONTO_AMALGAMATED.has(s) ? 'toronto' : s;
}

export function cityMatches(listingCity: string | null | undefined, allowed: string[]): boolean {
  if (!listingCity) return false;
  const listing = normalizeCity(listingCity);
  if (allowed.some((a) => normalizeCity(a) === listing)) return true;

  const canonical = canonicalMunicipality(listingCity);
  return allowed.some((a) => canonicalMunicipality(a) === canonical);
}
