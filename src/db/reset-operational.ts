import 'dotenv/config';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { loadEnv } from '@/config/env';
import { createDb, type Database } from '@/db/client';
import * as schema from '@/db/schema';

/**
 * Empties the operational tables and leaves the expensive ones alone.
 *
 * Written as a script rather than documented as a `TRUNCATE` because the deployment has no
 * `psql` — the runtime image is node:22-alpine with production dependencies and `dist/` — so
 * the only way to run the documented statement is to type it into a production console, one
 * table name away from deleting 1,090 daycares that took real network calls to collect.
 *
 * Dry run by default, like sync-profile.ts, for the same reason: it runs against production.
 *
 *   node dist/db/reset-operational.js
 *   node dist/db/reset-operational.js --apply
 *   node dist/db/reset-operational.js --apply --include-buildings
 */

/** Emptied by default: everything that a cycle can rebuild by scraping again. */
export const OPERATIONAL = [
  'listings',
  'matches',
  'notifications',
  'rejection_log',
  'needs_review',
  'listing_verifications',
  'cycle_runs',
] as const;

/**
 * Never emptied. Geography costs external calls to rebuild, and a profile holds tuning that
 * exists nowhere in the code — minScore, quiet hours and weights were calibrated against
 * real results, and the code's own numbers are older than they are.
 */
export const PRESERVED = [
  'daycares',
  'transit_stations',
  'rentsafe_buildings',
  'geocode_cache',
  'profiles',
] as const;

/**
 * Emptied only when named, because each one costs something specific.
 *
 * - `source_buildings` holds the Zumper watermark. Clearing it re-opens all 229 Toronto
 *   buildings from scratch, about six hours of cycles.
 * - `source_policy` holds the circuit breaker. Clearing it un-pauses a source that a 429
 *   deliberately stopped, which is sometimes what you want and sometimes how you earn the
 *   next block.
 */
export const OPT_IN: Record<string, string> = {
  source_buildings: '--include-buildings',
  source_policy: '--include-policy',
};

export interface ResetPlan {
  truncate: string[];
  preserved: string[];
  skipped: { table: string; flag: string }[];
}

/** Every table the schema declares, by name, read from the schema rather than restated. */
export function schemaTables(mod: Record<string, unknown> = schema): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const value of Object.values(mod)) {
    if (is(value, PgTable)) tables.set(getTableName(value), value);
  }
  return new Map([...tables].sort(([a], [b]) => a.localeCompare(b)));
}

export function schemaTableNames(mod: Record<string, unknown> = schema): string[] {
  return [...schemaTables(mod).keys()];
}

/**
 * Refuses to run against a schema it does not fully account for.
 *
 * This is the guard the whole script exists for. A table added later and forgotten here
 * would otherwise be silently left behind — or, in a version of this written with
 * `TRUNCATE ... CASCADE` over a guessed list, silently emptied. Neither should be possible
 * without someone deciding which of the two it is.
 */
export function planReset(tables: string[], flags: readonly string[]): ResetPlan {
  const classified = new Set<string>([...OPERATIONAL, ...PRESERVED, ...Object.keys(OPT_IN)]);
  const unknown = tables.filter((t) => !classified.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `unclassified table(s): ${unknown.join(', ')}. Add each one to OPERATIONAL, PRESERVED ` +
        `or OPT_IN in src/db/reset-operational.ts before running this.`,
    );
  }

  const present = new Set(tables);
  const plan: ResetPlan = {
    truncate: OPERATIONAL.filter((t) => present.has(t)),
    preserved: PRESERVED.filter((t) => present.has(t)),
    skipped: [],
  };

  for (const [table, flag] of Object.entries(OPT_IN)) {
    if (!present.has(table)) continue;
    if (flags.includes(flag)) plan.truncate.push(table);
    else plan.skipped.push({ table, flag });
  }

  return plan;
}

/**
 * Counted through the query builder with the schema's own table objects, not by interpolating
 * a name into raw SQL. The name never becomes a string in a statement, so there is no way for
 * this to address a table the schema does not define.
 */
async function counts(db: Database, tables: Map<string, PgTable>, wanted: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const name of wanted) {
    const table = tables.get(name);
    if (!table) continue;
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
    out.set(name, Number(row?.n ?? 0));
  }
  return out;
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const apply = flags.includes('--apply');
  const env = loadEnv();

  const handle = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const tables = schemaTables();
    const plan = planReset([...tables.keys()], flags);
    const before = await counts(handle.db, tables, [...plan.truncate, ...plan.preserved]);

    console.log(apply ? '\n=== emptying ===' : '\n=== would empty (dry run) ===');
    let total = 0;
    for (const table of plan.truncate) {
      const n = before.get(table) ?? 0;
      total += n;
      console.log(`  ${table.padEnd(24)} ${n} row(s)`);
    }
    console.log(`  ${'total'.padEnd(24)} ${total} row(s)`);

    if (plan.skipped.length > 0) {
      console.log('\n=== left alone unless named ===');
      for (const { table, flag } of plan.skipped) {
        console.log(`  ${table.padEnd(24)} ${before.get(table) ?? 0} row(s) — add ${flag} to include`);
      }
    }

    console.log('\n=== preserved ===');
    for (const table of plan.preserved) {
      console.log(`  ${table.padEnd(24)} ${before.get(table) ?? 0} row(s)`);
    }

    if (!apply) {
      console.log('\nDry run. Nothing was changed. Re-run with --apply.\n');
      return;
    }

    // One statement, so a failure halfway cannot leave matches pointing at deleted listings.
    // CASCADE is required rather than optional: matches, notifications, rejection_log,
    // needs_review and listing_verifications all reference listings.
    const list = sql.join(
      plan.truncate.map((name) => sql`${tables.get(name)!}`),
      sql`, `,
    );
    await handle.db.execute(sql`truncate table ${list} restart identity cascade`);

    const after = await counts(handle.db, tables, [...plan.truncate, ...plan.preserved]);
    const leftovers = plan.truncate.filter((t) => (after.get(t) ?? 0) > 0);
    const damaged = plan.preserved.filter((t) => (after.get(t) ?? 0) !== (before.get(t) ?? 0));

    console.log(`\nEmptied ${plan.truncate.length} table(s), ${total} row(s).`);
    if (leftovers.length > 0) console.log(`WARNING: still populated: ${leftovers.join(', ')}`);
    if (damaged.length > 0) console.log(`WARNING: preserved table changed: ${damaged.join(', ')}`);
    if (leftovers.length === 0 && damaged.length === 0) {
      console.log('Preserved tables are untouched.\n');
    }
  } finally {
    await handle.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`reset failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
