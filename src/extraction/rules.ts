/**
 * Free-text extraction.
 *
 * Outside the MLS, locker / parking / den / laundry are almost never structured fields;
 * they live in the ad body. Every rule here returns `null` when the text says nothing —
 * never `false`. An unmentioned locker is unknown, not absent, and the difference decides
 * whether a good listing reaches you or goes in the bin.
 *
 * Rules run over text already put through normalizeText().
 */

export interface ParkingFinding {
  /** true = included in rent, false = explicitly none, null = not mentioned. */
  included: boolean | null;
  /** Monthly cost when parking is offered as a paid extra. */
  cost: number | null;
  /** Parking exists on unstated terms — "parking available" with no price attached. */
  available: boolean;
}

const NEGATION_WINDOW = 24;

/** True when a negation word sits just before the match — "no locker", "without parking". */
function isNegated(text: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - NEGATION_WINDOW);
  const before = text.slice(start, matchIndex);
  return /\b(?:no|not|without|none|excludes?|exclude|extra|additional)\s+(?:\w+\s+){0,2}$/.test(before);
}

function findFirst(text: string, patterns: RegExp[]): RegExpExecArray | null {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    if (m) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locker
// ---------------------------------------------------------------------------

const LOCKER_POSITIVE = [
  /\b(?:storage\s+)?locker(?:s)?\s+(?:included|available|provided)\b/g,
  /\b(?:1|one|a)\s+(?:storage\s+)?locker\b/g,
  /\bparking\s*\+\s*locker\b/g,
  /\blocker\s*\+\s*parking\b/g,
  /\bwith\s+(?:a\s+)?(?:storage\s+)?locker\b/g,
  /\b(?:storage\s+)?locker\b/g,
];

const LOCKER_NEGATIVE = [/\bno\s+(?:storage\s+)?locker\b/g, /\blocker\s+not\s+included\b/g];

export function extractLocker(text: string): boolean | null {
  if (findFirst(text, LOCKER_NEGATIVE)) return false;
  const hit = findFirst(text, LOCKER_POSITIVE);
  if (!hit) return null;
  if (isNegated(text, hit.index)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Den
// ---------------------------------------------------------------------------

const DEN_PATTERNS = [
  /\b\d\s*\+\s*den\b/g,
  /\bplus\s+den\b/g,
  /\b\d\s*(?:bed|bedroom|br|bdrm)s?\s*\+\s*den\b/g,
  /\b\d\s*(?:bed|bedroom|br|bdrm)s?\s+plus\s+(?:a\s+)?den\b/g,
  /\bden\b/g,
];

/** "2+1" is Toronto shorthand for two bedrooms plus a den. */
const NUMERIC_DEN_PATTERN = /\b(\d)\s*\+\s*1\b/g;

const DEN_NEGATIVE = [/\bno\s+den\b/g, /\bwithout\s+(?:a\s+)?den\b/g];

/** Number of dens the text asserts, or null when it says nothing either way. */
export function extractDens(text: string): number | null {
  if (findFirst(text, DEN_NEGATIVE)) return 0;
  if (findFirst(text, DEN_PATTERNS)) return 1;
  NUMERIC_DEN_PATTERN.lastIndex = 0;
  if (NUMERIC_DEN_PATTERN.exec(text)) return 1;
  return null;
}

/** Bedroom count asserted by the text, for sources that do not provide it structurally. */
const BEDROOM_PATTERNS = [
  /\b(\d)\s*(?:bed|bedroom|br|bdrm)s?\b/g,
  /\b(\d)\s*\+\s*1\b/g,
];

export function extractBeds(text: string): number | null {
  for (const pattern of BEDROOM_PATTERNS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    const raw = m?.[1];
    if (raw !== undefined) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 9) return n;
    }
  }
  if (/\b(?:bachelor|studio)\b/.test(text)) return 0;
  return null;
}

// ---------------------------------------------------------------------------
// Parking
// ---------------------------------------------------------------------------

/**
 * The distinction that matters: "parking included" satisfies a hard parking requirement,
 * "parking available for $150" only satisfies it once $150 is added to the monthly total.
 * Conflating the two is how a 3,150 listing quietly becomes a 3,300 one.
 */
const PARKING_INCLUDED = [
  /\bparking\s+(?:is\s+)?included\b/g,
  /\bincludes?\s+(?:1\s+|one\s+)?(?:underground\s+|garage\s+|surface\s+)?parking\b/g,
  /\bparking\s*\+\s*locker\b/g,
  /\b(?:1|one)\s+(?:underground\s+|garage\s+)?parking\s+(?:spot|space|spr?ace)?\s*included\b/g,
  /\bwith\s+(?:1\s+|one\s+)?(?:underground\s+|garage\s+)?parking\b/g,
  /\bfree\s+parking\b/g,
];

const PARKING_COST = [
  /\bparking\s*(?:is\s*)?(?:available|offered|extra|additional)?\s*(?:for|at|@|:)?\s*\$\s*(\d{2,4})\b/g,
  /\bparking\s*\$\s*(\d{2,4})\b/g,
  /\$\s*(\d{2,4})\s*(?:\/|\s+per\s+)?\s*(?:mo|month|monthly)?\s*for\s+parking\b/g,
  /\badditional\s+\$\s*(\d{2,4})\s+for\s+parking\b/g,
];

const PARKING_NONE = [
  /\bno\s+parking\b/g,
  /\bparking\s+not\s+(?:included|available)\b/g,
  /\bstreet\s+parking\s+only\b/g,
  /\bwithout\s+parking\b/g,
];

/**
 * The weakest claim, checked last: parking exists, terms unstated. "Parking available" with
 * a price hits PARKING_COST first; "parking included" hits PARKING_INCLUDED. What is left
 * here is the ad that offers parking and never says on what terms.
 */
const PARKING_AVAILABLE = [
  /\bparking\s+(?:is\s+)?available\b/g,
  /\bparking\s+(?:spot|space)s?\s+available\b/g,
];

export function extractParking(text: string): ParkingFinding {
  if (findFirst(text, PARKING_NONE)) return { included: false, cost: null, available: false };

  const priced = findFirst(text, PARKING_COST);
  if (priced?.[1] !== undefined) {
    const cost = Number.parseInt(priced[1], 10);
    if (Number.isFinite(cost)) return { included: false, cost, available: false };
  }

  const included = findFirst(text, PARKING_INCLUDED);
  if (included && !isNegated(text, included.index)) {
    return { included: true, cost: null, available: false };
  }

  const available = findFirst(text, PARKING_AVAILABLE);
  if (available && !isNegated(text, available.index)) {
    return { included: null, cost: null, available: true };
  }

  return { included: null, cost: null, available: false };
}

// ---------------------------------------------------------------------------
// Floor area
// ---------------------------------------------------------------------------

/**
 * normalizeText turns every comma into a space, so "1,200 Sq. Ft." arrives here as
 * "1 200 sq. ft." — the thousands form is digits split by a single space, and it must be
 * tried first or the plain form would read the "200" and call the loft a bachelor.
 */
const SQFT_UNIT = String.raw`(?:sq\.?\s*(?:ft\b\.?|feet\b|foot\b)|sqft\b|sf\b|square\s+f(?:ee|oo)t\b)`;

const SQFT_PATTERNS = [
  new RegExp(String.raw`\b(\d{1,2}) (\d{3})\s*${SQFT_UNIT}`, 'g'),
  new RegExp(String.raw`\b(\d{3,4})\s*${SQFT_UNIT}`, 'g'),
];

/** "Up to 1210 sq ft" is a ceiling over a whole building, not this unit's area. */
const SQFT_UPPER_BOUND = /\bup\s+to\s*$/;

/** Nothing rentable is under 250 sq ft, and five digits is a lot, not a unit. */
const SQFT_MIN = 250;
const SQFT_MAX = 10_000;

export function extractSqft(text: string): number | null {
  const hit = findFirst(text, SQFT_PATTERNS);
  if (!hit) return null;
  if (SQFT_UPPER_BOUND.test(text.slice(Math.max(0, hit.index - NEGATION_WINDOW), hit.index))) {
    return null;
  }
  const raw = hit[2] !== undefined ? `${hit[1]}${hit[2]}` : hit[1];
  if (raw === undefined) return null;
  const sqft = Number.parseInt(raw, 10);
  if (!Number.isFinite(sqft) || sqft < SQFT_MIN || sqft > SQFT_MAX) return null;
  return sqft;
}

// ---------------------------------------------------------------------------
// Laundry
// ---------------------------------------------------------------------------

const LAUNDRY_IN_SUITE = [
  /\b(?:en\s*suite|in\s*suite|in\s*unit|in\s*the\s*unit)\s+laundry\b/g,
  /\blaundry\s+(?:en\s*suite|in\s*suite|in\s*unit|in\s+the\s+unit)\b/g,
  /\b(?:private|own)\s+(?:washer|laundry)\b/g,
  /\bwasher\s*(?:\/|\s+and\s+|\s*&\s*)\s*dryer\s+in\s+(?:suite|unit)\b/g,
];

/** Shared building laundry is explicitly not in-suite; matching it would be a false positive. */
const LAUNDRY_SHARED = [
  /\b(?:shared|common|coin)\s*(?:\s|-)?\s*(?:operated\s+)?laundry\b/g,
  /\blaundry\s+(?:room\s+)?in\s+(?:the\s+)?building\b/g,
  /\blaundry\s+on\s+(?:each\s+)?floor\b/g,
];

export function extractInSuiteLaundry(text: string): boolean | null {
  if (findFirst(text, LAUNDRY_IN_SUITE)) return true;
  if (findFirst(text, LAUNDRY_SHARED)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export type Utility = 'heat' | 'water' | 'hydro' | 'gas' | 'internet' | 'cable';

const ALL_UTILITIES: Utility[] = ['heat', 'water', 'hydro', 'gas'];

const UTILITY_WORDS: Record<Utility, RegExp> = {
  heat: /\bheat(?:ing)?\b/,
  water: /\bwater\b/,
  hydro: /\b(?:hydro|electricity|electric)\b/,
  gas: /\bgas\b/,
  internet: /\b(?:internet|wifi|wi\s*fi)\b/,
  cable: /\b(?:cable|cable\s*tv)\b/,
};

const INCLUSION_MARKER = /\bincl(?:udes?|uded|usive)\b/g;
/**
 * Deliberately narrow. A bare "separate" would match "separate walkout entrance" and
 * silently strip a utility the ad actually includes, which then understates the monthly
 * total — the one number the whole ranking turns on.
 */
const EXCLUSION_MARKER =
  /\b(?:not\s+included|excludes?|excluded|tenant\s+pays|paid\s+separately|billed\s+separately|separately\s+metered?|separate\s+meter|extra)\b/g;

/** Ads list what is included right after the word; "heat and water included" puts it before. */
const INCLUSION_LOOKBEHIND = 60;
const INCLUSION_LOOKAHEAD = 150;
const EXCLUSION_WINDOW = 60;

/**
 * Windows must not reach across a sentence boundary. "All utilities included. Hydro is
 * extra." means three utilities are covered and one is not; a window that spans the full
 * stop reads it as covering none.
 */
function utilitiesNear(text: string, marker: RegExp, before: number, after: number): Set<Utility> {
  const out = new Set<Utility>();

  for (const segment of text.split(/[.\n]+/)) {
    marker.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(segment)) !== null) {
      const window = segment.slice(Math.max(0, m.index - before), m.index + m[0].length + after);
      if (/\butilities\b/.test(window)) {
        for (const u of ALL_UTILITIES) out.add(u);
      }
      for (const [utility, pattern] of Object.entries(UTILITY_WORDS) as [Utility, RegExp][]) {
        if (pattern.test(window)) out.add(utility);
      }
    }
  }

  return out;
}

/**
 * Which utilities the rent covers. "All inclusive" expands to the standard set rather
 * than being treated as an opaque flag, so downstream cost estimation has something to work with.
 *
 * Matching is windowed around the inclusion/exclusion marker rather than clause-wide:
 * many ads are one long run-on line, where a single stray word would otherwise swing
 * every utility at once.
 */
export function extractUtilities(text: string): Utility[] {
  const found = new Set<Utility>();

  if (/\b(?:all\s+utilities\s+(?:are\s+)?included|all\s*[- ]?\s*inclusive|utilities\s+included)\b/.test(text)) {
    for (const u of ALL_UTILITIES) found.add(u);
  }

  for (const u of utilitiesNear(text, INCLUSION_MARKER, INCLUSION_LOOKBEHIND, INCLUSION_LOOKAHEAD)) {
    found.add(u);
  }

  // An explicit exclusion overrides a blanket "all inclusive".
  for (const u of utilitiesNear(text, EXCLUSION_MARKER, EXCLUSION_WINDOW, EXCLUSION_WINDOW)) {
    found.delete(u);
  }

  return [...found];
}

// ---------------------------------------------------------------------------
// Rent control proxy
// ---------------------------------------------------------------------------

/**
 * Ontario caps annual increases only for units first occupied before 15 November 2018.
 * The ad never states this, so we look for the giveaways: a stated build year, or the
 * marketing language of a new building.
 */
const YEAR_BUILT = /\b(?:built|constructed|completed)\s+(?:in\s+)?(19\d{2}|20[0-2]\d)\b/g;
const BRAND_NEW = /\b(?:brand\s*new|newly\s+(?:built|constructed)|new\s+construction|never\s+lived\s+in)\b/;

export function extractBuiltBefore2018(text: string): boolean | null {
  YEAR_BUILT.lastIndex = 0;
  const m = YEAR_BUILT.exec(text);
  const raw = m?.[1];
  if (raw !== undefined) {
    const year = Number.parseInt(raw, 10);
    if (Number.isFinite(year)) return year < 2018;
  }
  if (BRAND_NEW.test(text)) return false;
  return null;
}
