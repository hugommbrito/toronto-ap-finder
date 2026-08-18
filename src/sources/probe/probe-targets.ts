import { buildSearchUrl as kijijiSearchUrl } from '@/sources/kijiji/kijiji.parser';
import { buildSearchUrl as zumperSearchUrl } from '@/sources/zumper/zumper.parser';

export interface ProbeTarget {
  /** Matches `listings.source`, so a verdict can be read against the rows a source produced. */
  id: string;
  /**
   * The URL the fetcher actually requests.
   *
   * Built by the adapter's own `buildSearchUrl`, deliberately: probing a site's front page would
   * measure a page we never fetch, and front pages are routinely protected differently from the
   * paths a crawler uses. Reusing the builder also means a change to it is a change to what gets
   * measured, with no second place to update.
   */
  url: string;
  /** Proves the listing data is in the raw HTML, with no JavaScript run. */
  contentMarker: RegExp;
  /** Why this marker, so the next reader does not have to re-derive it. */
  markerNote: string;
}

/**
 * What to measure, as data.
 *
 * Section 4 of the addendum puts this before any new adapter: level of protection changes without
 * notice, and a scraping vendor's blog is marketing rather than a technical reference. So the two
 * sources already implemented are probed alongside any candidate — a green verdict for Kijiji is
 * only interesting because it is the same measurement a candidate gets.
 *
 * **Rentals.ca is deliberately absent.** It is a documented refusal
 * (`docs/sources/rentals-ca.md`): its own robots.txt sits behind a Cloudflare managed challenge, so
 * there is no readable basis on which to claim any path is permitted. Adding it here would mean
 * re-requesting a site that has already answered, which is not a measurement worth taking. PadMapper
 * is absent for a different reason — same backend as Zumper, so it would duplicate work for the same
 * inventory.
 */
export const PROBE_TARGETS: ProbeTarget[] = [
  {
    id: 'kijiji',
    url: kijijiSearchUrl(1),
    // The Apollo cache keys the parser reads; see listingEntries() in kijiji.parser.ts.
    contentMarker: /RealEstateListing:/,
    markerNote: 'Apollo cache key `RealEstateListing:<id>` inside __NEXT_DATA__',
  },
  {
    id: 'zumper',
    url: zumperSearchUrl(1),
    // Not `listables`: sixteen keys carry that name and most are empty decoys. A listing_id is
    // what proves real inventory was rendered.
    contentMarker: /"listing_id"\s*:/,
    markerNote: '`listing_id` in the inline app state (not `listables`, which has sixteen decoys)',
  },
];
