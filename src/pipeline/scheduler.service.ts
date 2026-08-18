import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PipelineService } from './pipeline.service';

/** Every 20 minutes. Roughly four genuinely new Toronto listings appear in that window. */
export const CYCLE_CRON = '*/20 * * * *';

/**
 * The same cadence, offset by ten minutes.
 *
 * The offset is the point: the two cycles talk to different hosts and hold separate rate
 * limiters, so they are safe to overlap, but starting both on the hour means every network
 * hiccup hits both at once and a report covering the two is impossible to read.
 */
export const BUILDING_CYCLE_CRON = '10,30,50 * * * *';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  /**
   * A cycle can run for minutes — twenty hydrations at 12 s is four on its own. Without this
   * guard a slow cycle would overlap the next one and double the request rate against a
   * source that has already rate-limited us twice.
   */
  private running = false;
  /** Its own guard: a slow Kijiji cycle must not silently cancel the Zumper one. */
  private runningBuildings = false;

  constructor(private readonly pipeline: PipelineService) {}

  @Cron(CYCLE_CRON, { name: 'rental-cycle' })
  async runScheduledCycle(): Promise<void> {
    // Set CYCLE_ENABLED=false to run the service without polling — useful when driving
    // cycles by hand with `pnpm cycle`, and when running two instances by accident.
    if (process.env.CYCLE_ENABLED === 'false') return;

    if (this.running) {
      this.logger.warn('previous cycle still running — skipping this tick');
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    try {
      const report = await this.pipeline.runCycle();
      this.logger.log(
        `cycle done in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
          `seen ${report.listingsSeen}, hydrated ${report.hydrated}, scored ${report.scored}, ` +
          `notified ${report.notified}, delisted ${report.delisted}` +
          (report.errors.length > 0 ? ` — ${report.errors.length} error(s)` : ''),
      );
    } catch (err) {
      // Never let a bad cycle kill the scheduler; the next tick is twenty minutes away.
      this.logger.error(`cycle failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.running = false;
    }
  }

  /**
   * Zumper, whose search results are buildings rather than units.
   *
   * The budget counts *buildings*, not listings: one opened building yielded 174 units across
   * four requests when this was measured, so twelve per cycle is far more inventory than the
   * Kijiji budget of twenty detail fetches. The first pass through all 229 Toronto buildings
   * takes about six hours of cycles; after that the `modified_on` watermark keeps it to
   * whatever actually changed.
   */
  @Cron(BUILDING_CYCLE_CRON, { name: 'building-cycle' })
  async runScheduledBuildingCycle(): Promise<void> {
    if (process.env.CYCLE_ENABLED === 'false') return;
    if (process.env.BUILDING_CYCLE_ENABLED === 'false') return;

    if (this.runningBuildings) {
      this.logger.warn('previous building cycle still running — skipping this tick');
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
          (report.errors.length > 0 ? ` — ${report.errors.length} error(s)` : ''),
      );
    } catch (err) {
      this.logger.error(`building cycle failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.runningBuildings = false;
    }
  }
}
