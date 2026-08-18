import { describe, expect, it } from 'vitest';
import {
  classifyAntibot,
  embeddedJsonHint,
  isChallengePage,
  isDegradation,
  verdictFor,
  type ResponseFacts,
} from './antibot';

function facts(overrides: Partial<ResponseFacts> = {}): ResponseFacts {
  return { status: 200, headers: {}, setCookies: [], body: '<html>ok</html>', ...overrides };
}

describe('classifyAntibot', () => {
  it('names Cloudflare from CF-RAY, from either cookie, or from the server header', () => {
    expect(classifyAntibot(facts({ headers: { 'cf-ray': '8a1b2c3d4e5f' } }))).toBe('cloudflare');
    expect(classifyAntibot(facts({ setCookies: ['cf_clearance=abc; Path=/'] }))).toBe('cloudflare');
    expect(classifyAntibot(facts({ setCookies: ['__cf_bm=xyz; HttpOnly'] }))).toBe('cloudflare');
    expect(classifyAntibot(facts({ headers: { server: 'cloudflare' } }))).toBe('cloudflare');
  });

  it('names Akamai from _abck', () => {
    expect(classifyAntibot(facts({ setCookies: ['_abck=0~-1~-1; Path=/'] }))).toBe('akamai');
  });

  it('names DataDome from the header or the cookie', () => {
    expect(classifyAntibot(facts({ headers: { 'x-datadome': 'protected' } }))).toBe('datadome');
    expect(classifyAntibot(facts({ setCookies: ['datadome=abc; Path=/'] }))).toBe('datadome');
  });

  it('names Kasada only for a bare 429 with nothing to read', () => {
    expect(classifyAntibot(facts({ status: 429, body: '' }))).toBe('kasada');
    // A 429 that says something is an ordinary rate limit, not this signature.
    expect(classifyAntibot(facts({ status: 429, body: 'slow down' }))).toBe('unknown');
  });

  it('attributes a 429 to the vendor whose fingerprint is present, not to Kasada', () => {
    // Order matters: Cloudflare rate-limiting us is a Cloudflare fact.
    expect(classifyAntibot(facts({ status: 429, body: '', headers: { 'cf-ray': 'x' } }))).toBe('cloudflare');
  });

  it('says none for a clean 200 and unknown for an unexplained failure', () => {
    expect(classifyAntibot(facts())).toBe('none');
    expect(classifyAntibot(facts({ status: 503, body: 'gateway' }))).toBe('unknown');
  });

  it('matches a cookie by name only, never by value', () => {
    // A body or another cookie mentioning the name must not be enough.
    expect(classifyAntibot(facts({ setCookies: ['session=cf_clearance'] }))).toBe('none');
  });
});

describe('isChallengePage', () => {
  it('recognises the Cloudflare interstitial that closed Rentals.ca', () => {
    const body = '<html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>';
    expect(isChallengePage(body)).toBe(true);
  });

  it('does not fire on an ordinary listings page', () => {
    expect(isChallengePage('<html>3 bedroom apartment, please contact us to arrange a moment</html>')).toBe(false);
  });
});

describe('verdictFor', () => {
  const base = {
    status: 200,
    vendor: 'none' as const,
    contentInInitialHtml: true,
    challenged: false,
    robotsTxtVerdict: 'allow' as const,
    robotsChallenged: false,
  };

  it('is green when the content is already in the HTML', () => {
    expect(verdictFor(base)).toEqual({ verdict: 'green', requiresJs: false, notes: null });
  });

  it('is yellow and asserts requiresJs when a vendor is present but the content is not', () => {
    const v = verdictFor({ ...base, contentInInitialHtml: false, vendor: 'cloudflare' });
    expect(v.verdict).toBe('yellow');
    expect(v.requiresJs).toBe(true);
    expect(v.notes).toContain('JSON endpoint');
  });

  it('is yellow but does NOT assert requiresJs when nothing explains the missing content', () => {
    // A stale parser marker and a JavaScript-rendered page look identical from here, and they
    // need different work, so the probe declines to guess.
    const v = verdictFor({ ...base, contentInInitialHtml: false, vendor: 'none' });
    expect(v.verdict).toBe('yellow');
    expect(v.requiresJs).toBe(false);
    expect(v.notes).toContain('selector may have changed');
  });

  it('is red for a challenge page, an HTTP failure, or a disallowing robots.txt', () => {
    expect(verdictFor({ ...base, challenged: true }).verdict).toBe('red');
    expect(verdictFor({ ...base, status: 403 }).verdict).toBe('red');
    expect(verdictFor({ ...base, robotsTxtVerdict: 'disallow' }).verdict).toBe('red');
  });

  it('is red when robots.txt itself cannot be read because it was challenged', () => {
    // The exact Rentals.ca finding: absent permission is not permission.
    const v = verdictFor({ ...base, robotsTxtVerdict: 'absent', robotsChallenged: true });
    expect(v.verdict).toBe('red');
    expect(v.notes).toContain('permission cannot be read');
  });

  it('does not turn a merely absent robots.txt into a refusal', () => {
    // A 404 on robots.txt means no rules exist, which RFC 9309 reads as permission.
    expect(verdictFor({ ...base, robotsTxtVerdict: 'absent' }).verdict).toBe('green');
  });

  it('lets a disallowing robots.txt outrank a page that would otherwise look fine', () => {
    const v = verdictFor({ ...base, robotsTxtVerdict: 'disallow', contentInInitialHtml: true });
    expect(v.verdict).toBe('red');
    expect(v.notes).toContain('disallows');
  });
});

describe('isDegradation', () => {
  it('fires only on a move to a worse verdict', () => {
    expect(isDegradation('green', 'yellow')).toBe(true);
    expect(isDegradation('green', 'red')).toBe(true);
    expect(isDegradation('yellow', 'red')).toBe(true);
    expect(isDegradation('yellow', 'green')).toBe(false);
    expect(isDegradation('red', 'red')).toBe(false);
  });

  it('does not fire on a first observation', () => {
    // Otherwise every new source would announce itself as a regression.
    expect(isDegradation(null, 'red')).toBe(false);
  });
});

describe('embeddedJsonHint', () => {
  it('reports the state block a stale-marker page still carries', () => {
    // The distinction that matters on a yellow: our own parser bug, or a genuinely client-rendered
    // page. Only the first is cheap to fix, and only the first is our fault.
    expect(embeddedJsonHint('<script id="__NEXT_DATA__">{}</script>')).toContain('Next.js');
    expect(embeddedJsonHint('window.__APOLLO_STATE__ = {}')).toContain('Apollo');
  });

  it('names every block it finds', () => {
    const hint = embeddedJsonHint('__NEXT_DATA__ and application/ld+json');
    expect(hint).toContain('Next.js');
    expect(hint).toContain('JSON-LD');
  });

  it('is null when the page really does carry no state', () => {
    expect(embeddedJsonHint('<html><body><div id="root"></div></body></html>')).toBeNull();
  });
});
