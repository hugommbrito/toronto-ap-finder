import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { GeoService } from '@/geo/geo.service';
import { ProfilesService } from '@/profiles/profiles.service';
import { PipelineService } from '@/pipeline/pipeline.service';
import { ProbeService } from '@/sources/probe/probe.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly geo: GeoService,
    private readonly profilesService: ProfilesService,
    private readonly pipeline: PipelineService,
    private readonly probe: ProbeService,
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
    // exactly like a quiet market. It has to show up here — for every source, not just the
    // first one, which is how a paused Zumper used to go unnoticed.
    const { sources, pausedSources, lastCycleAt, lastCycle } = this.pipeline.status;
    checks.sources = sources;
    checks.pausedSources = pausedSources;
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
    if (pausedSources.length > 0) ok = false;

    // Advisory, and deliberately not part of `ok`: a verdict is a weekly measurement, so a red
    // recorded last Monday would otherwise pin this endpoint to `degraded` for seven days. The
    // Telegram alert fires on the transition, which is when it is actually news.
    try {
      const policies = await this.probe.currentPolicies();
      checks.sourcePolicy =
        policies.length === 0
          ? 'never probed — run "pnpm probe"'
          : Object.fromEntries(
              policies.map((p) => [
                p.sourceId,
                { verdict: p.verdict, antibot: p.antibotVendor, robots: p.robotsTxtVerdict, at: p.probedAt },
              ]),
            );
      checks.probedFrom = this.probe.probedFrom;
    } catch (err) {
      checks.sourcePolicy = `error: ${(err as Error).message}`;
    }

    return { status: ok ? 'ok' : 'degraded', ...checks };
  }
}
