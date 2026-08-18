import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PipelineService } from './pipeline.service';

/** Every 20 minutes. Roughly four genuinely new Toronto listings appear in that window. */
export const CYCLE_CRON = '*/20 * * * *';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  /**
   * A cycle can run for minutes — twenty hydrations at 12 s is four on its own. Without this
   * guard a slow cycle would overlap the next one and double the request rate against a
   * source that has already rate-limited us twice.
   */
  private running = false;

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
}
