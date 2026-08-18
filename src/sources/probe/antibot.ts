import type { RobotsVerdict } from './robots';

export type AntibotVendor = 'cloudflare' | 'akamai' | 'datadome' | 'kasada' | 'none' | 'unknown';
export type ProbeVerdict = 'green' | 'yellow' | 'red';

export interface ResponseFacts {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Raw `set-cookie` values, as received. */
  setCookies: string[];
  body: string;
}

/**
 * Phrases that only appear on an interstitial, never on a results page.
 *
 * Kept narrow deliberately. A false positive here reports a working source as `red` and stops us
 * building an adapter we were entitled to build, which is a worse outcome than a missed detection:
 * a missed one shows up immediately as `contentInInitialHtml: false`.
 */
const CHALLENGE_MARKERS = [
  'cf_chl_opt',
  'challenge-platform',
  '/cdn-cgi/challenge',
  'just a moment',
  'enable javascript and cookies to continue',
  'checking your browser before accessing',
  'verifying you are human',
];

export function isChallengePage(body: string): boolean {
  const haystack = body.slice(0, 20_000).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
}

function hasCookie(setCookies: string[], name: string): boolean {
  const prefix = `${name.toLowerCase()}=`;
  return setCookies.some((c) => c.trim().toLowerCase().startsWith(prefix));
}

/**
 * Names the vendor from the fingerprints in section 4 of the addendum.
 *
 * Vendor identity is not the point in itself — the point is that it tells you what kind of wall
 * you are looking at, and therefore whether the wall is likely to move next week. Cookie and
 * header *names* are the evidence; values are never read or stored.
 */
export function classifyAntibot(facts: ResponseFacts): AntibotVendor {
  const { status, headers, setCookies, body } = facts;

  if (
    'cf-ray' in headers ||
    headers.server === 'cloudflare' ||
    hasCookie(setCookies, 'cf_clearance') ||
    hasCookie(setCookies, '__cf_bm')
  ) {
    return 'cloudflare';
  }

  if (hasCookie(setCookies, '_abck') || hasCookie(setCookies, 'bm_sz')) return 'akamai';
  if ('x-datadome' in headers || hasCookie(setCookies, 'datadome')) return 'datadome';

  // Kasada answers a request it does not like with a bare 429 and nothing to read. Checked last,
  // because a 429 from any of the above is that vendor's rate limit rather than this signature.
  if (status === 429 && body.trim() === '') return 'kasada';

  if (status >= 200 && status < 300) return 'none';
  return 'unknown';
}

export interface VerdictInput {
  status: number;
  vendor: AntibotVendor;
  /** Did a known listing marker match the raw HTML, with no JavaScript run? */
  contentInInitialHtml: boolean;
  challenged: boolean;
  robotsTxtVerdict: RobotsVerdict;
  /** True when robots.txt could not be read *because it was itself behind a challenge*. */
  robotsChallenged: boolean;
}

export interface Verdict {
  verdict: ProbeVerdict;
  requiresJs: boolean;
  notes: string | null;
}

/**
 * green — 200 with the content already in the HTML. An adapter is `undici` plus a parser.
 * yellow — 200, but the content only appears after JavaScript. Look for a published JSON endpoint
 *          before anyone reaches for a headless browser.
 * red — refused, challenged, or disallowed. **The source is closed.** Not a bypass to attempt:
 *       keeping a workaround alive is continuous work against a target that changes weekly, on a
 *       project whose useful life ends when a lease is signed.
 */
export function verdictFor(input: VerdictInput): Verdict {
  const { status, vendor, contentInInitialHtml, challenged, robotsTxtVerdict, robotsChallenged } = input;

  if (robotsTxtVerdict === 'disallow') {
    return { verdict: 'red', requiresJs: false, notes: 'robots.txt disallows the URL the adapter requests' };
  }
  if (robotsChallenged) {
    // The Rentals.ca case: absent permission is not permission. There is no basis on which to
    // claim any path is allowed when the file stating it cannot be read.
    return { verdict: 'red', requiresJs: false, notes: 'robots.txt itself sits behind a challenge — permission cannot be read' };
  }
  if (challenged) {
    return { verdict: 'red', requiresJs: false, notes: `challenge page served${vendor === 'none' ? '' : ` (${vendor})`}` };
  }
  if (status >= 400) {
    return { verdict: 'red', requiresJs: false, notes: `refused with HTTP ${status}` };
  }

  if (contentInInitialHtml) return { verdict: 'green', requiresJs: false, notes: null };

  // No marker and no vendor is more likely a stale marker than a JavaScript-rendered page, and
  // the two need different work, so do not assert `requiresJs` without a vendor to support it.
  if (vendor === 'none') {
    return {
      verdict: 'yellow',
      requiresJs: false,
      notes: 'marker absent with no anti-bot vendor present — the parser selector may have changed',
    };
  }

  return { verdict: 'yellow', requiresJs: true, notes: 'content absent from the initial HTML — look for a JSON endpoint before Playwright' };
}

const RANK: Record<ProbeVerdict, number> = { green: 3, yellow: 2, red: 1 };

/** True when the new verdict is worse than the old one for the same vantage point. */
export function isDegradation(previous: ProbeVerdict | null, next: ProbeVerdict): boolean {
  return previous !== null && RANK[next] < RANK[previous];
}

/**
 * Embedded application state, if the page carries any.
 *
 * This is the difference between the two things a `yellow` can mean. If the data is already in the
 * page as a JSON blob, our marker is stale and the fix is a parser — cheap, and entirely in our
 * hands. If there is no state at all, the page really is assembled client-side and the honest next
 * step is to look for a published endpoint. Both are `yellow`; only one is our own bug.
 */
const STATE_MARKERS: Array<[string, string]> = [
  ['__NEXT_DATA__', 'Next.js server-rendered state'],
  ['__APOLLO_STATE__', 'Apollo cache'],
  ['__INITIAL_STATE__', 'inline app state'],
  ['__NUXT__', 'Nuxt state'],
  ['application/ld+json', 'JSON-LD block'],
];

export function embeddedJsonHint(body: string): string | null {
  const found = STATE_MARKERS.filter(([marker]) => body.includes(marker)).map(([, label]) => label);
  return found.length === 0 ? null : `${found.join(', ')} present — the data may be in the page already`;
}
