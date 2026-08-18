import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { GeoService } from '@/geo/geo.service';
import { ProfilesService } from '@/profiles/profiles.service';
import { PipelineService } from '@/pipeline/pipeline.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly geo: GeoService,
    private readonly profilesService: ProfilesService,
    private readonly pipeline: PipelineService,
  ) {}

  /**
   * Reports the things that can be silently wrong: an unseeded geography index or zero
   * active profiles both produce a monitor that runs happily and finds nothing.
   */
  @Get()
  async check(): Promise<Record<string, unknown>> {
    const checks: Record<string, unknown> = {};
    let ok = true;

    try {
      await this.db.execute(sql`select 1`);
      checks.database = 'ok';
    } catch (err) {
      ok = false;
      checks.database = `error: ${(err as Error).message}`;
    }

    const index = this.geo.get();
    checks.daycares = index.daycareCount;
    checks.transitStations = index.stationCount;
    if (index.daycareCount === 0 || index.stationCount === 0) {
      ok = false;
      checks.geo = 'not seeded — run "pnpm seed"';
    }

    try {
      const active = await this.profilesService.findActive();
      checks.activeProfiles = active.map((p) => p.id);
      if (active.length === 0) {
        ok = false;
        checks.profiles = 'no active profiles';
      }
    } catch (err) {
      ok = false;
      checks.activeProfiles = `error: ${(err as Error).message}`;
    }

    // A paused source is the failure that looks most like success: empty cycles read
    // exactly like a quiet market. It has to show up here.
    const { source, lastCycleAt, lastCycle } = this.pipeline.status;
    checks.source = source;
    checks.lastCycleAt = lastCycleAt;
    if (lastCycle) {
      checks.lastCycle = {
        listingsSeen: lastCycle.listingsSeen,
        hydrated: lastCycle.hydrated,
        scored: lastCycle.scored,
        notified: lastCycle.notified,
        delisted: lastCycle.delisted,
        errors: lastCycle.errors.length,
      };
    }
    if (source.paused) ok = false;

    return { status: ok ? 'ok' : 'degraded', ...checks };
  }
}
