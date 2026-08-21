import { fetchText } from '@/seed/http';
import type { TriageListing } from '@/listings/listing.types';
import type { ListingDetail, TriagePage, UnitListingSource } from '../source.interface';
import { RateLimiter } from '../rate-limiter';
import { buildSearchUrl, extractNextData, parseDetailPage, parseSearchPage } from './kijiji.parser';

/**
 * Kijiji I/O. All parsing lives in kijiji.parser.ts so that it stays testable without a
 * network; this file is only fetching and pacing.
 *
 * Conduct (see docs/sources/kijiji.md): path-based URLs only — every query-string search
 * filter is disallowed by robots.txt — an identifiable User-Agent, and at least 2 s between
 * requests.
 */
export class KijijiSource implements UnitListingSource {
  readonly name = 'kijiji';
  /**
   * 12 s, well above the 2 s floor the brief sets as a minimum.
   *
   * Measured, not guessed. At 2 s a cycle earned an HTTP 429 after roughly two dozen
   * requests; at 6 s a 23-request cycle succeeded but the next one was refused immediately,
   * so the limit is a rolling budget rather than a simple gap between calls. The brief's own
   * reasoning settles it: being more aggressive only brings the block forward. At 12 s a
   * 20-listing hydration budget takes about four minutes, which fits the shortest cycle gap.
   */
  readonly minIntervalMs = 12_000;

  private readonly limiter: RateLimiter;

  constructor(private readonly contactEmail?: string) {
    this.limiter = new RateLimiter({
      name: this.name,
      minIntervalMs: this.minIntervalMs,
      // 12–18 s. The floor is measured and stays; the tail is what stops the gap being a signature.
      jitterMs: 6_000,
    });
  }

  get paused(): boolean {
    return this.limiter.paused;
  }

  get stats(): { requests: number; paused: boolean; reason: string | null } {
    return { requests: this.limiter.requests, paused: this.limiter.paused, reason: this.limiter.reason };
  }

  /** Called at the start of a cycle: the gap between cycles is the backoff. */
  resetIfCooledDown(cooldownMs: number): boolean {
    return this.limiter.resetIfCooledDown(cooldownMs);
  }

  async fetchTriagePage(page: number): Promise<TriagePage> {
    const url = buildSearchUrl(page);
    const html = await this.limiter.run(() =>
      fetchText(url, { contactEmail: this.contactEmail, retries: 2 }),
    );
    return parseSearchPage(extractNextData(html));
  }

  async fetchDetail(listing: TriageListing): Promise<ListingDetail> {
    const html = await this.limiter.run(() =>
      fetchText(listing.url, { contactEmail: this.contactEmail, retries: 2 }),
    );
    return parseDetailPage(extractNextData(html));
  }
}
