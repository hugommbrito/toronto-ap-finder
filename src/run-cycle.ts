import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { PipelineService, type CycleReport } from './pipeline/pipeline.service';

/**
 * Runs one pipeline cycle from the command line.
 *
 * Phase 2 puts this on a cron; until then it is the way to watch a real cycle and read the
 * funnel. `--dry-run` scores and stores everything but sends nothing.
 */
function arg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function printReport(report: CycleReport): void {
  const section = (title: string, rows: Record<string, number>): void => {
    const entries = Object.entries(rows).sort(([, a], [, b]) => b - a);
    if (entries.length === 0) return;
    console.log(`\n${title}`);
    for (const [key, count] of entries) console.log(`  ${key.padEnd(24)} ${count}`);
  };

  console.log('\n=== cycle report ===');
  console.log(`pages fetched        ${report.pagesFetched}`);
  if (report.buildingsSeen > 0) {
    console.log(`buildings seen       ${report.buildingsSeen}`);
    console.log(`  opened this cycle  ${report.buildingsExpanded}`);
    console.log(`  deferred to next   ${report.buildingsDeferred}`);
    console.log(`  units found        ${report.unitsFound}`);
  }
  console.log(`listings seen        ${report.listingsSeen}`);
  console.log(`  new to the db      ${report.storedNew}`);
  console.log(`  unparsable         ${report.unparsable}`);
  console.log(`hydrated (fetched)   ${report.hydrated}`);
  console.log(`  reused from db     ${report.reusedFromCache}`);
  console.log(`  deferred to next   ${report.hydrationDeferred}`);
  console.log(`scored               ${report.scored}`);
  console.log(`needs review         ${report.needsReview}`);
  console.log(`verified by model    ${report.verified}`);
  if (report.verificationCorrected > 0) console.log(`  layout corrected   ${report.verificationCorrected}`);
  if (report.verificationRejected > 0) console.log(`  rejected           ${report.verificationRejected}`);
  console.log(`re-checked           ${report.rechecked}`);
  if (report.delisted > 0) console.log(`  newly delisted     ${report.delisted}`);
  console.log(`notified             ${report.notified}`);
  if (report.suppressedQuietHours > 0) console.log(`held for quiet hours ${report.suppressedQuietHours}`);

  // The funnel. In the first weeks this is the main instrument for discovering that a hard
  // filter is strangling the search.
  section('rejected at triage (structured data only):', report.rejectedAtTriage);
  section('rejected after hydration (full ad text):', report.rejectedAfterHydration);

  if (report.errors.length > 0) {
    console.log('\nerrors:');
    for (const e of report.errors) console.log(`  ${e}`);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // Re-score what is already collected, with no requests to the source at all.
  const fromStored = process.argv.includes('--stored');
  const buildings = process.argv.includes('--buildings');
  // Deliberately verbose to type: this bypasses a setting the tenant chose.
  const ignoreQuietHours = process.argv.includes('--ignore-quiet-hours');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  try {
    const pipeline = app.get(PipelineService);
    if (ignoreQuietHours) {
      new Logger('run-cycle').warn('--ignore-quiet-hours: sending regardless of the profile window');
    }
    const mode = fromStored ? 'stored corpus, no network' : buildings ? 'live, buildings (zumper)' : 'live';
    new Logger('run-cycle').log(`starting cycle (${mode})${dryRun ? ' (dry run — nothing will be sent)' : ''}`);
    const report = fromStored
      ? await pipeline.runFromStored({ dryRun, ignoreQuietHours })
      : buildings
        ? await pipeline.runBuildingCycle({
            maxPages: arg('pages', 5),
            // One request opens a whole building, so the budget counts buildings, not units.
            hydrationBudget: arg('open', 12),
            dryRun,
            ignoreQuietHours,
          })
        : await pipeline.runCycle({
            maxPages: arg('pages', 5),
            hydrationBudget: arg('hydrate', 20),
            recheckBudget: arg('recheck', 3),
            dryRun,
            ignoreQuietHours,
          });
    printReport(report);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
