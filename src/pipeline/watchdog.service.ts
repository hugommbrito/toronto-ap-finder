import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { loadEnv } from '@/config/env';
import { ListingsRepository } from '@/listings/listings.repository';
import { TelegramNotifier } from '@/notifications/telegram.notifier';
import { ProfilesService } from '@/profiles/profiles.service';

/** Checked every fifteen minutes; the threshold is what decides, not the check interval. */
export const WATCHDOG_CRON = '*/15 * * * *';
/** Three cycles' worth of silence at the old fixed cadence. */
export const STALE_AFTER_MS = 90 * 60_000;

export type WatchdogAction = 'quiet' | 'alert' | 'recovered';

/**
 * Decides whether the silence has gone on too long.
 *
 * Pure so the rule can be tested without a clock, a database or Telegram. Section 3 of the
 * addendum asks for a collector heartbeat; with the fetcher staying in the cloud there is no
 * collector to hear from, but the failure it guards against is the same one and is just as real
 * here — the monitor stops working and nothing says so, because a system that has collected
 * nothing looks exactly like a market with nothing in it.
 */
export function watchdogAction(input: {
  lastFinishedAt: Date | null;
  now: Date;
  alerted: boolean;
  staleAfterMs?: number;
}): WatchdogAction {
  const { lastFinishedAt, now, alerted, staleAfterMs = STALE_AFTER_MS } = input;

  // Never having run is a fresh install, not an outage. Announcing it would train you to ignore
  // the alert on exactly the day it means something.
  if (lastFinishedAt === null) return 'quiet';

  const stale = now.getTime() - lastFinishedAt.getTime() > staleAfterMs;
  if (stale) return alerted ? 'quiet' : 'alert';
  return alerted ? 'recovered' : 'quiet';
}

@Injectable()
export class WatchdogService {
  private readonly logger = new Logger(WatchdogService.name);
  private alerted = false;

  constructor(
    private readonly repo: ListingsRepository,
    private readonly notifier: TelegramNotifier,
    private readonly profilesService: ProfilesService,
  ) {}

  @Cron(WATCHDOG_CRON, { name: 'cycle-watchdog' })
  async check(now: Date = new Date()): Promise<WatchdogAction> {
    // With polling off, cycles are driven by hand and silence is the expected state — a watchdog
    // that fired then would be reporting the operator's own decision back to them.
    if (process.env.CYCLE_ENABLED === 'false') return 'quiet';

    let lastFinishedAt: Date | null;
    try {
      lastFinishedAt = await this.repo.lastCycleFinishedAt();
    } catch (err) {
      this.logger.error(`watchdog could not read the cycle history: ${(err as Error).message}`);
      return 'quiet';
    }

    const action = watchdogAction({ lastFinishedAt, now, alerted: this.alerted });

    if (action === 'alert') {
      this.alerted = true;
      const minutes = Math.round((now.getTime() - lastFinishedAt!.getTime()) / 60_000);
      this.logger.error(`no cycle has finished in ${minutes} minutes`);
      await this.notifier.alert(
        await this.recipients(),
        `⚠️ <b>No cycle has finished in ${minutes} minutes</b>\n` +
          `Last one ended ${lastFinishedAt!.toISOString()}.\n\n` +
          `Nothing new is being collected. Check <code>/operations</code> for what failed.`,
      );
    }

    if (action === 'recovered') {
      this.alerted = false;
      this.logger.log('cycles are running again');
      await this.notifier.alert(await this.recipients(), '✅ <b>Cycles are running again</b>');
    }

    return action;
  }

  /** Operational alerts follow the deployment's chat ids, with the profiles as a fallback. */
  private async recipients(): Promise<string[]> {
    const configured = loadEnv().TELEGRAM_CHAT_IDS;
    if (configured && configured.length > 0) return configured;
    const profiles = await this.profilesService.findActive();
    return [...new Set(profiles.flatMap((p) => p.notify.telegramChatIds))];
  }
}
