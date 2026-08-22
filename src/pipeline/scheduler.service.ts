import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PipelineService } from './pipeline.service';

/**
 * The window a cycle's gap is drawn from.
 *
 * An interval of exactly 1200 seconds is a machine signature — that is section 7's whole point,
 * and it is the reason this is no longer a cron expression. `@Cron` cannot express "again in 23
 * minutes and 41 seconds", and reaching for SchedulerRegistry to re-register a one-shot cron every
 * cycle would be a `setTimeout` chain wearing a costume.
 */
export const CYCLE_MIN_MS = 15 * 60_000;
export const CYCLE_MAX_MS = 35 * 60_000;
/** Roughly the old fixed offset, so the two chains still start apart. */
export const BUILDING_CYCLE_OFFSET_MS = 10 * 60_000;
/** Two cycles firing together makes a report impossible to read; push one aside if they collide. */
const COLLISION_WINDOW_MS = 90_000;
const COLLISION_PUSH_MIN_MS = 2 * 60_000;
const COLLISION_PUSH_MAX_MS = 4 * 60_000;

/**
 * How long until the next cycle.
 *
 * Pure and exported so the acceptance criterion — two consecutive cycles never share an interval —
 * is a unit test rather than something you squint at in a log. Rounded to whole seconds, because
 * "the same interval" has to mean something before it can be avoided, and nudged by a second when
 * a draw repeats, which is bounded and cannot loop.
 */
export function nextIntervalMs(previousMs: number, rand: () => number = Math.random): number {
  const span = CYCLE_MAX_MS - CYCLE_MIN_MS;
  let ms = Math.round((CYCLE_MIN_MS + Math.floor(rand() * span)) / 1000) * 1000;
  if (ms === previousMs) ms = ms + 1000 <= CYCLE_MAX_MS ? ms + 1000 : ms - 1000;
  return ms;
}

function humanise(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/**
 * Drives the cycles, at an interval that cannot be predicted from the outside.
 *
 * Two things changed with the move off cron, and both are worth knowing.
 *
 * The gap is now measured from **completion**, not from the previous start, so the effective
 * period is interval plus however long the cycle took: a four-minute run on a fifteen-minute gap
 * comes round every nineteen. That is desirable — the duration is itself a source of entropy —
 * but it means the 15–35 minute window describes the gap rather than the period.
 *
 * And self-overlap is now structurally impossible, since nothing is armed until the previous run
 * has returned. The `running` guards are kept anyway: the CLI shares this service, and a guard
 * that costs a boolean is cheaper than the reasoning required to prove it unnecessary.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;
  private runningBuildings = false;
  private unitTimer: NodeJS.Timeout | null = null;
  private buildingTimer: NodeJS.Timeout | null = null;
  private lastUnitInterval = 0;
  private lastBuildingInterval = 0;
  private nextUnitAt = 0;
  private nextBuildingAt = 0;
  private stopped = false;

  constructor(private readonly pipeline: PipelineService) {}

  onModuleInit(): void {
    // The first gap is jittered too. Starting both chains immediately would put every deployment's
    // first two cycles at a predictable distance from boot.
    this.armUnit(nextIntervalMs(0));
    this.armBuilding(BUILDING_CYCLE_OFFSET_MS + nextIntervalMs(0) / 4);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.unitTimer) clearTimeout(this.unitTimer);
    if (this.buildingTimer) clearTimeout(this.buildingTimer);
    // Deliberately not unref'd: the HTTP server holds the process open anyway, and an unref'd
    // timer would let a shutdown race a cycle that is midway through writing to the database.
  }

  /**
   * Keeps the two chains from firing together.
   *
   * Cron gave this for free with a fixed ten-minute offset. Two independently drifting clocks do
   * not, so the intention has to be restated as a rule: if the other chain is about to go, wait.
   */
  private deconflict(delayMs: number, otherAt: number): number {
    if (otherAt === 0) return delayMs;
    const firesAt = Date.now() + delayMs;
    if (Math.abs(firesAt - otherAt) > COLLISION_WINDOW_MS) return delayMs;
    const push = COLLISION_PUSH_MIN_MS + Math.floor(Math.random() * (COLLISION_PUSH_MAX_MS - COLLISION_PUSH_MIN_MS));
    return delayMs + push;
  }

  private armUnit(delayMs: number): void {
    if (this.stopped) return;
    const delay = this.deconflict(delayMs, this.nextBuildingAt);
    this.nextUnitAt = Date.now() + delay;
    this.logger.log(`next listings cycle in ${humanise(delay)}`);
    this.unitTimer = setTimeout(() => void this.runUnitCycle(), delay);
  }

  private armBuilding(delayMs: number): void {
    if (this.stopped) return;
    const delay = this.deconflict(delayMs, this.nextUnitAt);
    this.nextBuildingAt = Date.now() + delay;
    this.logger.log(`next building cycle in ${humanise(delay)}`);
    this.buildingTimer = setTimeout(() => void this.runBuildingCycle(), delay);
  }

  private async runUnitCycle(): Promise<void> {
    // Checked when the timer fires rather than when it is armed, and the chain re-arms either way,
    // so flipping the switch back does not need a restart.
    if (process.env.CYCLE_ENABLED === 'false') {
      this.lastUnitInterval = nextIntervalMs(this.lastUnitInterval);
      this.armUnit(this.lastUnitInterval);
      return;
    }
    if (this.running) {
      this.logger.warn('previous cycle still running — skipping this turn');
      this.lastUnitInterval = nextIntervalMs(this.lastUnitInterval);
      this.armUnit(this.lastUnitInterval);
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    try {
      const report = await this.pipeline.runCycle();
      this.logger.log(
        `cycle done in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
          `seen ${report.listingsSeen}, hydrated ${report.hydrated}, scored ${report.scored}, ` +
          `notified ${report.notified}` +
          (report.notifiedFromBacklog > 0 ? ` (${report.notifiedFromBacklog} from backlog)` : '') +
          `, delisted ${report.delisted}` +
          (report.errors.length > 0 ? ` — ${report.errors.length} error(s)` : ''),
      );
    } catch (err) {
      // Never let a bad cycle break the chain; that would stop the monitor silently.
      this.logger.error(`cycle failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.running = false;
      // Armed from completion, which is what makes overlap impossible.
      this.lastUnitInterval = nextIntervalMs(this.lastUnitInterval);
      this.armUnit(this.lastUnitInterval);
    }
  }

  private async runBuildingCycle(): Promise<void> {
    const rearm = (): void => {
      this.lastBuildingInterval = nextIntervalMs(this.lastBuildingInterval);
      this.armBuilding(this.lastBuildingInterval);
    };

    if (process.env.CYCLE_ENABLED === 'false' || process.env.BUILDING_CYCLE_ENABLED === 'false') {
      rearm();
      return;
    }
    if (this.runningBuildings) {
      this.logger.warn('previous building cycle still running — skipping this turn');
      rearm();
      return;
    }

    this.runningBuildings = true;
    const startedAt = Date.now();
    try {
      const report = await this.pipeline.runBuildingCycle();
      this.logger.log(
        `building cycle done in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
          `${report.buildingsSeen} buildings seen, ${report.buildingsExpanded} opened ` +
          `(${report.buildingsDeferred} waiting), ${report.unitsFound} units, ` +
          `scored ${report.scored}, notified ${report.notified}` +
          (report.notifiedFromBacklog > 0 ? ` (${report.notifiedFromBacklog} from backlog)` : '') +
          (report.errors.length > 0 ? ` — ${report.errors.length} error(s)` : ''),
      );
    } catch (err) {
      this.logger.error(`building cycle failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.runningBuildings = false;
      rearm();
    }
  }
}
