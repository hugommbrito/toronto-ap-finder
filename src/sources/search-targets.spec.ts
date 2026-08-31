import { describe, expect, it } from 'vitest';
import { pickLeastRecentlyVisited, type SearchTarget } from './source.interface';
import { KIJIJI_TARGETS, buildSearchUrl as kijijiUrl } from './kijiji/kijiji.parser';
import { ZUMPER_TARGETS, buildSearchUrl as zumperUrl } from './zumper/zumper.parser';

/**
 * Region rotation — one target per cycle, least recently visited first.
 *
 * Kijiji's rate limit is a rolling budget rather than a gap between calls, so visiting all
 * three regions at full depth in one cycle (~75 requests) is the shape that earned a 429. These
 * tests pin the rule that keeps a cycle at its original size.
 */
describe('pickLeastRecentlyVisited', () => {
  const targets: SearchTarget[] = [
    { key: 'toronto', label: 'Toronto' },
    { key: 'peel', label: 'Peel' },
    { key: 'waterloo', label: 'Waterloo' },
  ];
  const at = (iso: string) => new Date(iso);

  it('starts with the first target when nothing has been visited', () => {
    expect(pickLeastRecentlyVisited(targets, new Map()).key).toBe('toronto');
  });

  /**
   * The property that matters when a region is added: it backfills before the established ones
   * refresh, rather than queueing behind them forever.
   */
  it('prefers a target that has never been visited over any that has', () => {
    const visited = new Map([
      ['toronto', at('2026-08-23T12:00:00Z')],
      ['peel', at('2026-08-23T11:00:00Z')],
    ]);
    expect(pickLeastRecentlyVisited(targets, visited).key).toBe('waterloo');
  });

  it('picks the oldest visit once every target has been seen', () => {
    const visited = new Map([
      ['toronto', at('2026-08-23T12:00:00Z')],
      ['peel', at('2026-08-23T10:00:00Z')],
      ['waterloo', at('2026-08-23T11:00:00Z')],
    ]);
    expect(pickLeastRecentlyVisited(targets, visited).key).toBe('peel');
  });

  /** Visiting a target must move it to the back, or one region would monopolise the rotation. */
  it('cycles through every target rather than repeating one', () => {
    const visited = new Map<string, Date>();
    const order: string[] = [];
    let clock = Date.parse('2026-08-23T00:00:00Z');

    for (let i = 0; i < 6; i += 1) {
      const next = pickLeastRecentlyVisited(targets, visited);
      order.push(next.key);
      clock += 15 * 60 * 1000;
      visited.set(next.key, new Date(clock));
    }

    expect(order).toEqual(['toronto', 'peel', 'waterloo', 'toronto', 'peel', 'waterloo']);
  });

  it('is deterministic when two targets tie', () => {
    const same = at('2026-08-23T12:00:00Z');
    const visited = new Map([['peel', same], ['waterloo', same], ['toronto', same]]);
    expect(pickLeastRecentlyVisited(targets, visited).key).toBe('toronto');
  });

  it('ignores targets the source no longer declares', () => {
    const visited = new Map([['simcoe', at('1999-01-01T00:00:00Z')]]);
    expect(pickLeastRecentlyVisited(targets, visited).key).toBe('toronto');
  });
});

/**
 * The URLs the targets actually produce. Kijiji's slug and numeric id have to agree — the id
 * used to be a parameter while the slug stayed hardcoded, so passing another id emitted a URL
 * that pointed at Toronto's path with another region's id.
 */
describe('search target URLs', () => {
  it('keeps Kijiji unchanged for Toronto', () => {
    expect(kijijiUrl(1)).toBe('https://www.kijiji.ca/b-apartments-condos/city-of-toronto/c37l1700273');
  });

  it('pairs each Kijiji slug with its own location id', () => {
    const peel = KIJIJI_TARGETS.find((t) => t.key === 'peel')!;
    const waterloo = KIJIJI_TARGETS.find((t) => t.key === 'waterloo')!;
    expect(kijijiUrl(1, peel)).toBe(
      'https://www.kijiji.ca/b-apartments-condos/mississauga-peel-region/c37l1700276',
    );
    expect(kijijiUrl(2, waterloo)).toBe(
      'https://www.kijiji.ca/b-apartments-condos/kitchener-waterloo/page-2/c37l1700212',
    );
  });

  /** Path-based only: every query-string search filter is disallowed by Kijiji's robots.txt. */
  it('never puts a Kijiji search filter in the query string', () => {
    for (const target of KIJIJI_TARGETS) {
      expect(kijijiUrl(3, target)).not.toContain('?');
    }
  });

  it('gives every Zumper target its own city path', () => {
    const slugs = ZUMPER_TARGETS.map((t) => zumperUrl(1, t.citySlug));
    expect(slugs).toEqual([
      'https://www.zumper.com/apartments-for-rent/toronto-on',
      'https://www.zumper.com/apartments-for-rent/mississauga-on',
      'https://www.zumper.com/apartments-for-rent/cambridge-on',
    ]);
    expect(new Set(slugs).size).toBe(3);
  });

  /** The two sources are rotated together, so their keys have to line up. */
  it('uses the same target keys across sources', () => {
    expect(KIJIJI_TARGETS.map((t) => t.key)).toEqual(ZUMPER_TARGETS.map((t) => t.key));
  });
});
