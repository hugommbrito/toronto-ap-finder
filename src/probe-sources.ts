import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { ProbeService, type ProbeResult } from './sources/probe/probe.service';

/**
 * Measures every source and records the verdict.
 *
 * Section 4 of the addendum puts this before writing any new adapter, and it must run from the host
 * where the fetcher actually lives — IP reputation is the variable under test, so measuring from
 * the wrong place invalidates the result. On this deployment that host is Railway; a run from a
 * laptop is recorded under its own `probed_from` and cannot overwrite the deployment's verdict.
 *
 * `--dry-run` measures and prints without writing.
 *
 * Run it compiled — `pnpm probe`, never `tsx src/probe-sources.ts`. tsx uses esbuild, which does
 * not emit `emitDecoratorMetadata`, so Nest's type-based injection silently yields `undefined`:
 * everything reached through an explicit token still works, and the first dependency injected by
 * type alone throws. That is the same limitation vitest.config.ts pulls in unplugin-swc to avoid.
 */
function printResults(results: ProbeResult[], probedFrom: string): void {
  console.log(`\n=== source policy, probed from ${probedFrom} ===\n`);
  const header = ['source', 'HTTP', 'vendor', 'content', 'robots', 'verdict', 'ms'];
  const rows = results.map((r) => [
    r.sourceId,
    String(r.httpStatus),
    r.antibotVendor,
    r.contentInInitialHtml ? 'in html' : r.requiresJs ? 'needs js' : 'absent',
    r.robotsTxtVerdict,
    r.verdict,
    String(r.responseTimeMs),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));

  // The notes are the part worth reading: they say what to do about a yellow, and why a red is red.
  for (const r of results) {
    if (r.notes) console.log(`\n${r.sourceId}: ${r.notes}`);
    if (r.jsonEndpointHint) console.log(`${r.sourceId}: ${r.jsonEndpointHint}`);
  }

  const red = results.filter((r) => r.verdict === 'red').map((r) => r.sourceId);
  if (red.length > 0) {
    console.log(`\nred, and therefore closed — no adapter is to be written for: ${red.join(', ')}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  try {
    const probe = app.get(ProbeService);
    const logger = new Logger('probe-sources');
    logger.log(`probing from ${probe.probedFrom}${dryRun ? ' (dry run — nothing will be written)' : ''}`);
    printResults(await probe.probeAll({ persist: !dryRun }), probe.probedFrom);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
