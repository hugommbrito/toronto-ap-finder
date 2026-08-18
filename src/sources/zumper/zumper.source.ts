import { fetchText } from '@/seed/http';
import type { TriageListing } from '@/listings/listing.types';
import type { BuildingEntry, BuildingListingSource, BuildingPage } from '../source.interface';
import { RateLimiter } from '../rate-limiter';
import { buildSearchUrl, parseBuildingPage, parseSearchPage } from './zumper.parser';

/**
 * Zumper I/O. Parsing lives in zumper.parser.ts so it stays testable without a network.
 *
 * Conduct (see docs/sources/zumper.md): robots.txt is readable and allows both paths we use;
 * every JSON endpoint it disallows is left alone and the rendered page is read instead. No
 * crawl-delay binds `user-agent: *`, so the interval below is our own choice.
 */
export class ZumperSource implements BuildingListingSource {
  readonly name = 'zumper';
  readonly granularity = 'building' as const;

  /**
   * 6 s — half of Kijiji's 12 s, and deliberately so rather than by inattention. Zumper
   * returned no 429 while this adapter was being written, and one request here opens a whole
   * building: 38 floorplans in the case that was measured. Fewer requests do far more work,
   * so a shorter gap still means a much lighter footprint per listing obtained.
   */
  readonly minIntervalMs = 6_000;

  private readonly limiter: RateLimiter;

  constructor(private readonly contactEmail?: string) {
    this.limiter = new RateLimiter({ name: this.name, minIntervalMs: this.minIntervalMs });
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

  async fetchBuildingPage(page: number): Promise<BuildingPage> {
    const html = await this.limiter.run(() =>
      fetchText(buildSearchUrl(page), { contactEmail: this.contactEmail, retries: 2 }),
    );
    return parseSearchPage(html);
  }

  async fetchUnits(building: BuildingEntry): Promise<TriageListing[]> {
    const html = await this.limiter.run(() =>
      fetchText(building.url, { contactEmail: this.contactEmail, retries: 2 }),
    );
    return parseBuildingPage(html, building);
  }
}
