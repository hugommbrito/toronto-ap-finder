import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '@/config/env';
import { KijijiSource } from './kijiji/kijiji.source';
import { ZumperSource } from './zumper/zumper.source';
import { CapreitSource } from './capreit/capreit.source';
import type { BuildingListingSource, SourceHealth, UnitListingSource } from './source.interface';

/**
 * Every source, built once for the life of the process.
 *
 * That lifetime is the whole point and it is not incidental: the `RateLimiter` circuit lives in
 * the source instance, so if Kijiji refused us at 10:00 a fresh instance at 10:20 would have
 * forgotten and gone straight back in. `PipelineService` used to guarantee this by holding the
 * instances as its own fields, which worked but made them unreachable from anywhere else — so
 * `/health` could only ever report Kijiji, and a paused Zumper alerted nobody.
 *
 * A Nest provider is a process-lifetime singleton, which is the same guarantee, reachable from
 * every consumer, and testable: `source.registry.spec.ts` asserts that two calls hand back the
 * same objects rather than trusting a comment to stay true.
 */
@Injectable()
export class SourceRegistry {
  private readonly logger = new Logger(SourceRegistry.name);
  private readonly units: UnitListingSource[];
  private readonly buildings: BuildingListingSource[];

  constructor() {
    const env = loadEnv();
    const disabled = new Set(
      (process.env.DISABLED_SOURCES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const units: UnitListingSource[] = [new KijijiSource(env.SCRAPER_CONTACT_EMAIL)];
    const buildings: BuildingListingSource[] = [
      new ZumperSource(env.SCRAPER_CONTACT_EMAIL),
      new CapreitSource(env.SCRAPER_CONTACT_EMAIL),
    ];

    this.units = units.filter((s) => !disabled.has(s.name));
    this.buildings = buildings.filter((s) => !disabled.has(s.name));

    // Printed at boot because "is that source actually running?" is otherwise a question you can
    // only answer by reading code, and a typo'd DISABLED_SOURCES looks exactly like a quiet market.
    this.logger.log(
      `sources: ${this.all().map((s) => s.name).join(', ') || 'none'}` +
        (disabled.size > 0 ? ` (disabled: ${[...disabled].join(', ')})` : ''),
    );
  }

  unitSources(): UnitListingSource[] {
    return this.units;
  }

  buildingSources(): BuildingListingSource[] {
    return this.buildings;
  }

  /** Everything that can be paused, for health, alerting and the operations route. */
  all(): SourceHealth[] {
    return [...this.units, ...this.buildings];
  }

  health(): Record<string, { requests: number; paused: boolean; reason: string | null }> {
    return Object.fromEntries(this.all().map((s) => [s.name, s.stats]));
  }

  pausedSources(): string[] {
    return this.all().filter((s) => s.paused).map((s) => s.name);
  }
}

/**
 * Sources that are paused and have not been announced yet.
 *
 * Pure so the "once per pause, not once per cycle" rule can be tested without Telegram or a
 * database. A long outage announcing itself every twenty minutes would become the very noise that
 * makes the alert worth ignoring.
 */
export function newlyPaused(sources: SourceHealth[], alerted: ReadonlySet<string>): SourceHealth[] {
  return sources.filter((s) => s.paused && !alerted.has(s.name));
}
