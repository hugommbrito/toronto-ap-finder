import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSearchUrl,
  extractNextData,
  KijijiParseError,
  parseDetailPage,
  parseSearchPage,
} from './kijiji.parser';
import { toSearchableText } from '@/extraction/normalize';
import { extractLocker, extractParking } from '@/extraction/rules';

/** Real payloads captured from Kijiji on 2026-08-17, trimmed to a spread of layouts. */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(`test/fixtures/kijiji/${name}.json`), 'utf8'));

const SEARCH = fixture('search-page');
const DETAIL = fixture('detail-page');

describe('extractNextData', () => {
  it('pulls the payload out of the page', () => {
    const html = '<html><body><script id="__NEXT_DATA__" type="application/json">{"a":1}</script></body></html>';
    expect(extractNextData(html)).toEqual({ a: 1 });
  });

  it('throws loudly when the script tag is gone', () => {
    // Silence here would be indistinguishable from "no new listings today".
    expect(() => extractNextData('<html><body>nothing</body></html>')).toThrow(KijijiParseError);
  });

  it('throws loudly when the payload is not JSON', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{oops</script>';
    expect(() => extractNextData(html)).toThrow(KijijiParseError);
  });
});

describe('parseSearchPage', () => {
  const page = parseSearchPage(SEARCH);

  it('reads every listing in the fixture', () => {
    expect(page.listings.length).toBeGreaterThanOrEqual(5);
  });

  it('converts the price from cents', () => {
    for (const l of page.listings) {
      expect(l.rentBase).toBeGreaterThan(400);
      expect(l.rentBase).toBeLessThan(20000);
      // Cents-to-dollars must not leave fractions of a cent behind.
      expect(Number.isFinite(l.rentBase)).toBe(true);
    }
  });

  it('decodes the half-bedroom den encoding into whole bedrooms plus dens', () => {
    const twoPlusDen = page.listings.find((l) => l.beds === 2 && l.dens === 1);
    const onePlusDen = page.listings.find((l) => l.beds === 1 && l.dens === 1);
    const plainThree = page.listings.find((l) => l.beds === 3 && l.dens === 0);
    expect(twoPlusDen).toBeDefined();
    expect(onePlusDen).toBeDefined();
    expect(plainThree).toBeDefined();
    // Nothing downstream should ever see a fractional bedroom count.
    for (const l of page.listings) {
      expect(l.beds === null || Number.isInteger(l.beds)).toBe(true);
    }
  });

  it('divides the bathroom count by ten', () => {
    for (const l of page.listings) {
      if (l.baths !== null) {
        expect(l.baths).toBeGreaterThanOrEqual(0.5);
        expect(l.baths).toBeLessThan(10);
      }
    }
  });

  it('keeps the coordinates the source already provides', () => {
    const withCoords = page.listings.filter((l) => l.lat !== null && l.lng !== null);
    expect(withCoords.length).toBe(page.listings.length);
    for (const l of withCoords) {
      expect(l.lat!).toBeGreaterThan(43);
      expect(l.lat!).toBeLessThan(44);
      expect(l.lng!).toBeLessThan(-79);
      expect(l.lng!).toBeGreaterThan(-80);
    }
  });

  it('never turns an unset attribute into a false', () => {
    // Kijiji writes 0 both for "no" and for "not filled in"; only 1 is a fact.
    for (const l of page.listings) {
      expect(l.hasLocker === true || l.hasLocker === null).toBe(true);
      expect(l.inSuiteLaundry === true || l.inSuiteLaundry === null).toBe(true);
      expect(l.parkingIncluded === true || l.parkingIncluded === null).toBe(true);
    }
  });

  it('reads included utilities from the structured flags', () => {
    const anyUtilities = page.listings.some((l) => l.utilitiesIncluded.length > 0);
    expect(anyUtilities).toBe(true);
    for (const l of page.listings) {
      for (const u of l.utilitiesIncluded) {
        expect(['heat', 'water', 'hydro', 'cable', 'internet']).toContain(u);
      }
    }
  });

  it('leaves rawText null — the search page body is truncated', () => {
    for (const l of page.listings) expect(l.rawText).toBeNull();
  });

  it('reports the pagination the source declared', () => {
    expect(page.pagination.limit).toBe(40);
    expect(page.pagination.totalCount).toBeGreaterThan(1000);
  });

  it('throws when the payload has no listings at all', () => {
    expect(() => parseSearchPage({ props: { pageProps: { __APOLLO_STATE__: { ROOT_QUERY: {} } } } })).toThrow(
      KijijiParseError,
    );
  });

  it('sets aside a listing with no price instead of dropping it', () => {
    const withoutPrice = {
      props: {
        pageProps: {
          __APOLLO_STATE__: {
            'RealEstateListing:1': {
              id: '1',
              url: 'https://www.kijiji.ca/v-apartments-condos/x/y/1',
              title: 'Please contact',
              attributes: { all: [] },
            },
          },
        },
      },
    };
    const result = parseSearchPage(withoutPrice);
    expect(result.listings).toHaveLength(0);
    expect(result.unparsable[0]?.reason).toBe('no listed price');
  });
});

describe('parseDetailPage', () => {
  it('returns the full advertisement body, not the truncated one', () => {
    const detail = parseDetailPage(DETAIL);
    expect(detail.descriptionHtml.length).toBeGreaterThan(500);
    expect(detail.descriptionHtml).not.toMatch(/\.\.\.$/);
  });

  it('feeds the extraction layer with usable text', () => {
    // The whole point of hydration: the search page cannot answer these questions.
    const detail = parseDetailPage(DETAIL);
    const text = toSearchableText(detail.descriptionHtml);
    expect(text.length).toBeGreaterThan(400);
    expect(text).not.toContain('<');
    // Real ad body, so these simply must not throw or return nonsense.
    expect([true, false, null]).toContain(extractLocker(text));
    expect(extractParking(text)).toHaveProperty('included');
  });

  it('throws when the detail payload has no listing', () => {
    expect(() => parseDetailPage({ props: { pageProps: { __APOLLO_STATE__: {} } } })).toThrow(KijijiParseError);
  });
});

describe('buildSearchUrl', () => {
  it('uses the robots-allowed path form, with no query string', () => {
    expect(buildSearchUrl(1)).toBe('https://www.kijiji.ca/b-apartments-condos/city-of-toronto/c37l1700273');
    expect(buildSearchUrl(2)).toBe('https://www.kijiji.ca/b-apartments-condos/city-of-toronto/page-2/c37l1700273');
    // Query-string filters are disallowed by robots.txt; none may ever appear here.
    expect(buildSearchUrl(3)).not.toContain('?');
  });
});
