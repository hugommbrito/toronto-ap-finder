import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Database } from '@/db/client';
import { rentsafeBuildings } from '@/db/schema';
import { RentSafeIndex } from './rentsafe.index';

/**
 * Loads the City's inspected buildings once at boot, exactly as GeoService loads the geography.
 *
 * Deliberately not fatal when empty. An unseeded table degrades to "every buildingScore is null",
 * which the scorer already handles correctly by dropping the component from the average — so the
 * monitor keeps working and simply stops discriminating on one axis. That is a very different
 * failure from an unseeded geography, which produces a monitor that runs happily and matches
 * nothing, and it is why this one warns rather than refusing to start.
 */
@Injectable()
export class RentSafeService implements OnModuleInit {
  private readonly logger = new Logger(RentSafeService.name);
  private index = new RentSafeIndex([]);

  constructor(@Inject('DATABASE') private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const rows = await this.db
      .select({
        rsn: rentsafeBuildings.rsn,
        siteAddress: rentsafeBuildings.siteAddress,
        score: rentsafeBuildings.score,
        evaluatedOn: rentsafeBuildings.evaluatedOn,
        yearBuilt: rentsafeBuildings.yearBuilt,
        lat: rentsafeBuildings.lat,
        lng: rentsafeBuildings.lng,
      })
      .from(rentsafeBuildings);

    this.index = new RentSafeIndex(rows);
    if (rows.length === 0) {
      this.logger.warn('no RentSafeTO buildings — every buildingScore will be null; run "pnpm seed"');
    } else {
      this.logger.log(`Loaded ${rows.length} RentSafeTO buildings (${this.index.size} address keys).`);
    }
  }

  get(): RentSafeIndex {
    return this.index;
  }

  get buildingCount(): number {
    return this.index.size;
  }
}
