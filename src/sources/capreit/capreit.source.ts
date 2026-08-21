import { fetchText } from '@/seed/http';
import type { TriageListing } from '@/listings/listing.types';
import type { BuildingEntry, BuildingListingSource, BuildingPage } from '../source.interface';
import { RateLimiter } from '../rate-limiter';
import { SITEMAP_URL, parseBuildingPage, parseSitemap, toBuildingEntry } from './capreit.parser';

/**
 * CAPREIT I/O. Parsing lives in capreit.parser.ts so it stays testable without a network.
 *
 * Conduct (see docs/sources/pm_capreit.md): robots.txt is readable, disallows only the WordPress
 * admin, and **declares the sitemap this adapter reads** — which is as close to an invitation as
 * a site gets. Nothing here touches a path the file withholds.
 */
export class CapreitSource implements BuildingListingSource {
  readonly name = 'capreit';
  readonly granularity = 'building' as const;

  /**
   * 5 s, and provisional rather than measured.
   *
   * Nothing rate-limited the investigation — roughly fifteen requests over ten minutes at four
   * second gaps, no 429, no challenge, no cookie set — but an absence of refusals over fifteen
   * requests is not a measured limit, and Kijiji's 12 s exists precisely because a gap that looked
   * fine for one cycle was refused on the next. This sits above the brief's 2 s floor and below
   * the point where a 44-building backfill stops fitting in a cycle. Re-measure before lowering it.
   */
  readonly minIntervalMs = 5_000;

  /**
   * Seven days, matching Zumper, and for the same reason.
   *
   * The sitemap carries `<lastmod>` for all 569 properties, so the watermark does the work and
   * this rarely fires. It covers the failure the watermark cannot see: a source that stops
   * filling the field freezes its inventory at whatever was last read, and nothing about that
   * looks wrong from outside.
   */
  readonly refreshEveryMs = 7 * 24 * 60 * 60 * 1_000;

  private readonly limiter: RateLimiter;

  constructor(private readonly contactEmail?: string) {
    this.limiter = new RateLimiter({
      name: this.name,
      minIntervalMs: this.minIntervalMs,
      // 5–8 s. The floor here is provisional, so the tail is proportionally smaller.
      jitterMs: 3_000,
    });
  }

  get paused(): boolean {
    return this.limiter.paused;
  }

  get stats(): { requests: number; paused: boolean; reason: string | null } {
    return { requests: this.limiter.requests, paused: this.limiter.paused, reason: this.limiter.reason };
  }

  resetIfCooledDown(cooldownMs: number): boolean {
    return this.limiter.resetIfCooledDown(cooldownMs);
  }

  /**
   * The whole inventory, in one request, on the first page.
   *
   * Enumeration is a published sitemap rather than a paginated search, so there is no second page
   * to walk: page one returns every building in the profile's cities and anything after it is
   * empty, which is what tells the cycle to stop. Cheaper than Zumper, where the same knowledge
   * costs a request per fifty buildings — and the `<lastmod>` that decides which buildings are
   * worth opening arrives in the same response.
   */
  async fetchBuildingPage(page: number): Promise<BuildingPage> {
    if (page > 1) return { buildings: [], unparsable: [], pagination: { offset: 0, limit: 0, totalCount: 0 } };

    const xml = await this.limiter.run(() =>
      fetchText(SITEMAP_URL, { contactEmail: this.contactEmail, retries: 2 }),
    );
    const buildings = parseSitemap(xml).map(toBuildingEntry);

    return {
      buildings,
      unparsable: [],
      pagination: { offset: 0, limit: buildings.length, totalCount: buildings.length },
    };
  }

  /** One request, every rentable unit type in the building, with the building's own prose. */
  async fetchUnits(building: BuildingEntry): Promise<TriageListing[]> {
    const html = await this.limiter.run(() =>
      fetchText(building.url, { contactEmail: this.contactEmail, retries: 2 }),
    );
    return parseBuildingPage(html);
  }
}
