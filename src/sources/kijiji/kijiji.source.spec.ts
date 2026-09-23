import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Hoisted above the imports by vitest, so the source is built against the mock.
const fetchPageMock = vi.fn();
vi.mock('@/seed/http', () => ({
  fetchPage: (...args: unknown[]) => fetchPageMock(...args),
  fetchText: async (...args: unknown[]) => ((await fetchPageMock(...args)) as { text: string }).text,
  sleep: () => Promise.resolve(),
}));

import { KijijiSource } from './kijiji.source';
import { REMOVED_STATUS } from './kijiji.parser';
import type { TriageListing } from '@/listings/listing.types';

/**
 * The I/O seam the parser tests cannot reach: whether the adapter looks at where the response
 * came from before it looks at what it says.
 *
 * A removed Kijiji ad is a 200 — the category's search page, behind a redirect that names the ad
 * in `adRemoved`. Parsed as a detail page that body raises "no RealEstateListing entry", which the
 * re-check counted as an unreadable page three times and then gave up on, so removed ads were never
 * marked delisted. These tests pin the order: URL first, body second.
 */
const AD: TriageListing = {
  source: 'kijiji',
  sourceId: '1733830893',
  url: 'https://www.kijiji.ca/v-apartments-condos/city-of-toronto/2-bedroom-den/1733830893',
} as TriageListing;

const REMOVED_URL =
  'https://www.kijiji.ca/b-apartments-condos/city-of-toronto/c37l1700273?radius=50.0&ll=43.67%2C-79.35&adRemoved=1733830893';

const DETAIL_HTML = `<html><body><script id="__NEXT_DATA__" type="application/json">${readFileSync(
  resolve('test/fixtures/kijiji/detail-page.json'),
  'utf8',
)}</script></body></html>`;

describe('KijijiSource.fetchDetail', () => {
  beforeEach(() => fetchPageMock.mockReset());

  it('reports a removed ad from the redirect, without parsing the search page it landed on', async () => {
    // No __NEXT_DATA__ at all: if the body were parsed this would throw, not return.
    fetchPageMock.mockResolvedValueOnce({ text: '<html><body>search results</body></html>', url: REMOVED_URL });

    const detail = await new KijijiSource('test@example.com').fetchDetail(AD);

    expect(detail).toEqual({ descriptionHtml: '', status: REMOVED_STATUS });
    expect(fetchPageMock).toHaveBeenCalledWith(AD.url, expect.objectContaining({ retries: 2 }));
  });

  it('parses the detail page when the request was answered in place', async () => {
    fetchPageMock.mockResolvedValueOnce({ text: DETAIL_HTML, url: AD.url });

    const detail = await new KijijiSource('test@example.com').fetchDetail(AD);

    expect(detail.status).toBe('ACTIVE');
    expect(detail.descriptionHtml.length).toBeGreaterThan(0);
  });
});
