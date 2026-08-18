import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Database } from '@/db/client';
import { daycares, transitStations } from '@/db/schema';
import { GeoIndex, type DaycarePoint, type TransitPoint } from '@/scoring/context';

/**
 * Holds the seeded geography in memory.
 *
 * Roughly 1,090 daycares and 140 stations — under 100 KB — so it is loaded once at boot
 * and refreshed on demand. Keeping it out of the scoring hot path is what allows every
 * scoring component to be tested without a database.
 */
@Injectable()
export class GeoService implements OnModuleInit {
  private readonly logger = new Logger(GeoService.name);
  private index: GeoIndex = new GeoIndex([], []);

  constructor(@Inject('DATABASE') private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const [daycareRows, stationRows] = await Promise.all([
      this.db.select().from(daycares),
      this.db.select().from(transitStations),
    ]);

    const daycarePoints: DaycarePoint[] = daycareRows.map((d) => ({
      id: d.id,
      name: d.name,
      lat: d.lat,
      lng: d.lng,
      infantSpace: d.infantSpace,
      toddlerSpace: d.toddlerSpace,
      preschoolSpace: d.preschoolSpace,
      kindergartenSpace: d.kindergartenSpace,
      schoolageSpace: d.schoolageSpace,
      subsidy: d.subsidy,
      cwelcc: d.cwelcc,
    }));

    const stationPoints: TransitPoint[] = stationRows.map((s) => ({
      id: s.id,
      name: s.name,
      line: s.line,
      status: s.status,
      expectedYear: s.expectedYear,
      lat: s.lat,
      lng: s.lng,
    }));

    this.index = new GeoIndex(daycarePoints, stationPoints);

    // An empty index would silently make every listing look badly served rather than error.
    if (daycarePoints.length === 0 || stationPoints.length === 0) {
      this.logger.error(
        `Geography index is empty (${daycarePoints.length} daycares, ${stationPoints.length} stations). Run "pnpm seed".`,
      );
    } else {
      this.logger.log(`Loaded ${daycarePoints.length} daycares and ${stationPoints.length} transit stations.`);
    }
  }

  get(): GeoIndex {
    return this.index;
  }
}
