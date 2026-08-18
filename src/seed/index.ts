import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { createDb, type Database } from '@/db/client';
import { daycares, profiles, transitStations } from '@/db/schema';
import { fetchDaycares, type SeedDaycare } from './daycares';
import { buildTransitSeed } from './transit';
import type { SeedStation } from './future-stations';
import { buildSisterProfile } from './sister-profile';

const DAYCARE_SEED_PATH = resolve('data/seed/daycares.json');
const TRANSIT_SEED_PATH = resolve('data/seed/transit-stations.json');

/**
 * Seed files are committed so that a rebuild does not depend on two external services
 * being up, and so that a change in the upstream data shows up as a reviewable diff
 * rather than as a silent shift in everyone's scores.
 */
async function loadOrFetch<T>(path: string, refresh: boolean, fetcher: () => Promise<T[]>): Promise<T[]> {
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(path, 'utf8')) as T[];
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`  using cached ${path} (${cached.length} records) — pass --refresh to re-download`);
        return cached;
      }
    } catch {
      // No cache yet; fall through and fetch.
    }
  }

  const fetched = await fetcher();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(fetched, null, 2)}\n`, 'utf8');
  console.log(`  wrote ${path} (${fetched.length} records)`);
  return fetched;
}

async function seedDaycares(db: Database, rows: SeedDaycare[]): Promise<void> {
  await db
    .insert(daycares)
    .values(rows)
    .onConflictDoUpdate({
      target: daycares.id,
      set: {
        name: sql`excluded.name`,
        auspice: sql`excluded.auspice`,
        address: sql`excluded.address`,
        postalCode: sql`excluded.postal_code`,
        ward: sql`excluded.ward`,
        phone: sql`excluded.phone`,
        buildingType: sql`excluded.building_type`,
        buildingName: sql`excluded.building_name`,
        infantSpace: sql`excluded.infant_space`,
        toddlerSpace: sql`excluded.toddler_space`,
        preschoolSpace: sql`excluded.preschool_space`,
        kindergartenSpace: sql`excluded.kindergarten_space`,
        schoolageSpace: sql`excluded.schoolage_space`,
        totalSpace: sql`excluded.total_space`,
        subsidy: sql`excluded.subsidy`,
        cwelcc: sql`excluded.cwelcc`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        sourceRunDate: sql`excluded.source_run_date`,
        updatedAt: sql`now()`,
      },
    });
}

async function seedTransit(db: Database, rows: SeedStation[]): Promise<void> {
  await db
    .insert(transitStations)
    .values(rows)
    .onConflictDoUpdate({
      target: transitStations.id,
      set: {
        name: sql`excluded.name`,
        line: sql`excluded.line`,
        status: sql`excluded.status`,
        mode: sql`excluded.mode`,
        expectedYear: sql`excluded.expected_year`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        source: sql`excluded.source`,
        updatedAt: sql`now()`,
      },
    });
}

async function seedProfiles(db: Database, telegramChatIds: string[], force: boolean): Promise<void> {
  const sister = buildSisterProfile(telegramChatIds);
  const values = {
    id: sister.id,
    label: sister.label,
    active: sister.active,
    hard: sister.hard,
    soft: sister.soft,
    notify: sister.notify,
  };

  await db
    .insert(profiles)
    .values(values)
    .onConflictDoUpdate({
      target: profiles.id,
      // By default a re-seed refreshes only the label and the chat id: filters and weights
      // are meant to be tuned in the database, and silently reverting that tuning would be
      // worse than useless. --force-profiles is the deliberate way to push a structural
      // change from code, and it does overwrite hand edits.
      //
      // The chat id is the exception because it is deployment configuration, not a search
      // preference — changing who gets notified should mean editing .env and re-seeding,
      // not remembering a flag. minScore and quietHours inside the same jsonb are
      // preferences, so they survive.
      set: force
        ? {
            label: sql`excluded.label`,
            hard: sql`excluded.hard`,
            soft: sql`excluded.soft`,
            notify: sql`excluded.notify`,
            updatedAt: sql`now()`,
          }
        : {
            label: sql`excluded.label`,
            notify: sql`jsonb_set(profiles.notify, '{telegramChatIds}', excluded.notify->'telegramChatIds')`,
            updatedAt: sql`now()`,
          },
    });
}

/** Counts that make the plan's verification step something you read rather than run by hand. */
async function report(db: Database): Promise<void> {
  const [dc] = await db
    .select({
      total: sql<number>`count(*)::int`,
      toddler: sql<number>`count(*) filter (where ${daycares.toddlerSpace} > 0)::int`,
      cwelcc: sql<number>`count(*) filter (where ${daycares.cwelcc})::int`,
      toddlerCwelcc: sql<number>`count(*) filter (where ${daycares.toddlerSpace} > 0 and ${daycares.cwelcc})::int`,
    })
    .from(daycares);

  const lines = await db
    .select({
      line: transitStations.line,
      status: transitStations.status,
      count: sql<number>`count(*)::int`,
    })
    .from(transitStations)
    .groupBy(transitStations.line, transitStations.status)
    .orderBy(transitStations.status, transitStations.line);

  const profileRows = await db
    .select({ id: profiles.id, active: profiles.active, hard: profiles.hard, soft: profiles.soft })
    .from(profiles);

  console.log('\n--- seed report ---');
  console.log(`daycares:            ${dc?.total ?? 0}`);
  console.log(`  with toddler room: ${dc?.toddler ?? 0}`);
  console.log(`  CWELCC ($10/day):  ${dc?.cwelcc ?? 0}`);
  console.log(`  toddler + CWELCC:  ${dc?.toddlerCwelcc ?? 0}   <- the set that actually matters`);
  console.log('\ntransit stations:');
  for (const row of lines) {
    console.log(`  [${row.status.padEnd(11)}] ${String(row.line).padEnd(46)} ${row.count}`);
  }
  // Printed so that a structural change to a profile is visible after seeding, rather than
  // something you have to go and query for.
  console.log(`\nprofiles: ${profileRows.length}`);
  for (const p of profileRows) {
    const tiers = (p.soft.bedroomTiers ?? []).map((t) => `${t.label} = ${t.value}`).join(', ');
    const weights = Object.entries(p.soft.weights)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    console.log(`  [${p.id}] active=${p.active} floor=${JSON.stringify(p.hard.bedroomRule)} ceiling=${p.hard.totalRentMax} target=${p.soft.targetRent}`);
    if (tiers) console.log(`     layout ladder: ${tiers}`);
    console.log(`     weights: ${weights}`);
  }
}

export interface SeedOptions {
  refresh?: boolean;
  forceProfiles?: boolean;
  quiet?: boolean;
}

/**
 * Populates geography and profiles.
 *
 * Callable from the CLI and from boot. On a fresh deployment the committed files under
 * data/seed/ are enough — no network required — which matters because an unseeded index
 * produces a monitor that runs perfectly and matches nothing.
 */
export async function runSeed(db: Database, options: SeedOptions = {}): Promise<void> {
  const env = loadEnv();
  const { refresh = false, forceProfiles = false } = options;

  if (!env.SCRAPER_CONTACT_EMAIL) {
    console.warn('warning: SCRAPER_CONTACT_EMAIL is unset; requests will go out without a contact address.');
  }

  console.log('daycares (City of Toronto CKAN)...');
  const daycareRows = await loadOrFetch(DAYCARE_SEED_PATH, refresh, () => fetchDaycares(env.SCRAPER_CONTACT_EMAIL));
  await seedDaycares(db, daycareRows);

  console.log('transit stations (Overpass + manual future lines)...');
  const transitRows = await loadOrFetch(TRANSIT_SEED_PATH, refresh, () => buildTransitSeed(env.SCRAPER_CONTACT_EMAIL));
  await seedTransit(db, transitRows);

  console.log(`profiles...${forceProfiles ? ' (--force-profiles: overwriting hard/soft/notify)' : ''}`);
  await seedProfiles(db, env.TELEGRAM_CHAT_IDS ?? ['TODO-set-TELEGRAM_CHAT_IDS'], forceProfiles);
  if (!env.TELEGRAM_CHAT_IDS) {
    console.warn('  note: TELEGRAM_CHAT_IDS unset — profile seeded with a placeholder; nothing will send.');
  }

  if (!options.quiet) await report(db);
}

/** True when the geography index has nothing in it — i.e. this database has never been seeded. */
export async function needsSeeding(db: Database): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(daycares);
  return (row?.n ?? 0) === 0;
}

async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');
  const forceProfiles = process.argv.includes('--force-profiles');
  const env = loadEnv();

  const handle = createDb(env.DATABASE_URL, { max: 1 });
  try {
    await runSeed(handle.db, { refresh, forceProfiles });
  } finally {
    await handle.close();
  }
}

// Only when run as a script. Without this guard, importing runSeed() from the application
// bootstrap would execute the CLI as a side effect of the import — which it did, seeding
// before the migrations had created the tables.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\nseed failed:', err);
    process.exit(1);
  });
}
