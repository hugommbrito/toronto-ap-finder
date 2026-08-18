import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots, pathAndQuery } from './robots';
import { buildSearchUrl as kijijiSearchUrl } from '@/sources/kijiji/kijiji.parser';
import { buildSearchUrl as zumperSearchUrl } from '@/sources/zumper/zumper.parser';

const TOKEN = 'toronto-rental-monitor';

/**
 * The excerpts below are the rules `docs/sources/kijiji.md` and `docs/sources/zumper.md` record as
 * having been read by hand. Testing against them is what turns those documents from notes into
 * assertions: if the parser cannot reproduce the conclusion a human reached, the parser is wrong.
 */
const KIJIJI_EXCERPT = `
User-agent: *
Disallow: /*?price=
Disallow: /*?bedrooms=
Disallow: /*?sort=
Disallow: /v-*/*/*/c*
`;

const ZUMPER_EXCERPT = `
User-agent: ImagesiftBot
Crawl-delay: 10

User-agent: *
Disallow: /api
Disallow: /json
Disallow: /map
Disallow: /*?bedrooms=
Disallow: /*?loc=
Disallow: /apartment-for-rent/
Sitemap: https://www.zumper.com/sitemap.xml.gz
`;

describe('parseRobots', () => {
  it('selects the wildcard group when no group names us', () => {
    const rules = parseRobots(KIJIJI_EXCERPT, TOKEN);
    expect(rules.group).toBe('*');
    expect(rules.rules).toHaveLength(4);
  });

  it('prefers a group that names our own product token over the wildcard', () => {
    const body = `
User-agent: *
Disallow: /

User-agent: toronto-rental-monitor
Disallow: /private
`;
    const rules = parseRobots(body, TOKEN);
    expect(rules.group).toBe(TOKEN);
    // The wildcard's blanket Disallow: / must not apply once a group names us.
    expect(isAllowed(rules, '/b-apartments-condos/city-of-toronto/c37l1700273')).toBe(true);
    expect(isAllowed(rules, '/private/thing')).toBe(false);
  });

  it('does not let a crawl-delay declared for another agent bind us', () => {
    // The measured fact from docs/sources/zumper.md: crawl-delay appears only under ImagesiftBot
    // and ias-va, so the wildcard group declares none.
    expect(parseRobots(ZUMPER_EXCERPT, TOKEN).crawlDelayMs).toBeNull();
  });

  it('reads a crawl-delay that does bind us, in milliseconds', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 2.5', TOKEN).crawlDelayMs).toBe(2500);
  });

  it('starts a new group when a user-agent line follows a rule', () => {
    const body = 'User-agent: a\nDisallow: /x\nUser-agent: *\nDisallow: /y';
    const rules = parseRobots(body, TOKEN);
    expect(rules.group).toBe('*');
    expect(rules.rules).toEqual([{ kind: 'disallow', pattern: '/y' }]);
  });

  it('treats an empty file as no rules at all', () => {
    expect(parseRobots('', TOKEN).rules).toEqual([]);
    expect(isAllowed(parseRobots('', TOKEN), '/anything')).toBe(true);
  });

  it('ignores comments and rules that precede any user-agent line', () => {
    const body = '# a comment\nDisallow: /orphan\nUser-agent: *\nDisallow: /real  # trailing';
    expect(parseRobots(body, TOKEN).rules).toEqual([{ kind: 'disallow', pattern: '/real' }]);
  });
});

describe('isAllowed', () => {
  it('treats an empty Disallow value as disallowing nothing', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:', TOKEN), '/anything')).toBe(true);
  });

  it('lets the longest matching pattern win', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b/c', TOKEN);
    expect(isAllowed(rules, '/a/x')).toBe(false);
    expect(isAllowed(rules, '/a/b/c/d')).toBe(true);
  });

  it('lets Allow win a tie of equal length, in either declaration order', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /p\nAllow: /p', TOKEN), '/p')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nAllow: /p\nDisallow: /p', TOKEN), '/p')).toBe(true);
  });

  it('honours a trailing $ as an end anchor', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /x$', TOKEN);
    expect(isAllowed(rules, '/x')).toBe(false);
    expect(isAllowed(rules, '/x/y')).toBe(true);
  });

  it('expands * inside a pattern', () => {
    // Kijiji's rule shape: the fourth segment must start with `c` for the rule to bite.
    const rules = parseRobots('User-agent: *\nDisallow: /v-*/*/*/c*', TOKEN);
    expect(isAllowed(rules, '/v-apartments-condos/toronto/slug/c37l1700273')).toBe(false);
    // A detail URL ends in a numeric id, so it does not match — the conclusion docs/sources
    // /kijiji.md reached by hand.
    expect(isAllowed(rules, '/v-apartments-condos/toronto/slug/1234567890')).toBe(true);
  });
});

describe('the URLs our adapters actually request', () => {
  const kijiji = parseRobots(KIJIJI_EXCERPT, TOKEN);
  const zumper = parseRobots(ZUMPER_EXCERPT, TOKEN);

  it('permits every Kijiji search URL the adapter can build', () => {
    for (const page of [1, 2, 5]) {
      expect(isAllowed(kijiji, pathAndQuery(kijijiSearchUrl(page))), `page ${page}`).toBe(true);
    }
  });

  it('permits every Zumper search URL the adapter can build', () => {
    for (const page of [1, 2, 5]) {
      expect(isAllowed(zumper, pathAndQuery(zumperSearchUrl(page))), `page ${page}`).toBe(true);
    }
  });

  it('would refuse the query-string filters the adapters deliberately never send', () => {
    // Not a hypothetical: these are the forms that made in-memory filtering necessary.
    expect(isAllowed(kijiji, '/b-apartments-condos/city-of-toronto/c37l1700273?bedrooms=3')).toBe(false);
    expect(isAllowed(zumper, '/apartments-for-rent/toronto-on?bedrooms=3')).toBe(false);
    expect(isAllowed(zumper, '/api/listings')).toBe(false);
  });
});

describe('pathAndQuery', () => {
  it('keeps the query string, because that is what the rules are written against', () => {
    expect(pathAndQuery('https://x.test/a/b?c=1&d=2')).toBe('/a/b?c=1&d=2');
    expect(pathAndQuery('https://x.test/a')).toBe('/a');
  });
});
