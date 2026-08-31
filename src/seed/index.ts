import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { createDb, type Database } from '@/db/client';
import { daycares, profiles, rentsafeBuildings, transitStations } from '@/db/schema';
import { fetchDaycares, type SeedDaycare } from './daycares';
import { fetchPeelDaycares, fetchWaterlooDaycares } from './daycares-regional';
import { fetchMunicipalBoundaries, serializeBoundaries } from './boundaries';
import { buildTransitSeed } from './transit';
import { fetchRentSafeBuildings, type SeedRentSafeBuilding } from './rentsafe';
import type { SeedStation } from './future-stations';
import { SEEDED_REGIONS } from '@/geo/coverage';
import { buildSisterProfile } from './sister-profile';

const DAYCARE_SEED_PATH = resolve('data/seed/daycares.json');
const PEEL_DAYCARE_SEED_PATH = resolve('data/seed/daycares-peel.json');
const WATERLOO_DAYCARE_SEED_PATH = resolve('data/seed/daycares-waterloo.json');
const TRANSIT_SEED_PATH = resolve('data/seed/transit-stations.json');
const RENTSAFE_SEED_PATH = resolve('data/seed/rentsafe-buildings.json');
const BOUNDARY_SEED_PATH = resolve('data/seed/municipal-boundaries.json');

/**
 * Seed files are committed so that a rebuild does not depend on two external services
 * being up, and so that a change in the upstream data shows up as a reviewable diff
 * rather than as a silent shift in everyone's scores.
 */
async function loadOrFetch<T>(
  path: string,
  refresh: boolean,
  fetcher: () => Promise<T[]>,
  serialize: (rows: T[]) => string = (rows) => `${JSON.stringify(rows, null, 2)}\n`,
  /**
   * Rejects a cached file written before a shape change, so it is refetched instead of used.
   *
   * Learned the hard way. These files hold already-normalised rows, so the mapping that builds
   * them never re-runs on a cache hit — which means a change to the row shape leaves every
   * existing checkout with a file the new code misreads. When daycare ids became namespaced,
   * the stale file still held bare ones, the migration had already renamed the rows in place,
   * and the upsert cheerfully inserted a second copy of all 1,090 centres. Nothing failed; the
   * count simply doubled.
   */
  isUsable: (rows: T[]) => boolean = () => true,
): Promise<T[]> {
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(path, 'utf8')) as T[];
      if (Array.isArray(cached) && cached.length > 0 && !isUsable(cached)) {
        console.log(`  ${path} predates the current row shape — refetching`);
      } else if (Array.isArray(cached) && cached.length > 0) {
        console.log(`  using cached ${path} (${cached.length} records) — pass --refresh to re-download`);
        return cached;
      }
    } catch {
      // No cache yet; fall through and fetch.
    }
  }

  const fetched = await fetcher();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize(fetched), 'utf8');
  console.log(`  wrote ${path} (${fetched.length} records)`);
  return fetched;
}

/**
 * Chunked, and it has to be.
 *
 * This was one statement while the only source was Toronto: ~1,090 rows times 23 columns is
 * about 25,000 bind parameters, comfortably under the 65,535 a single Postgres statement
 * allows. Adding Peel (581) and Waterloo (287) pushes it past that ceiling, and the failure
 * would arrive as a bind-parameter error in the middle of a seed rather than as anything
 * legible. 500 is the chunk `seedRentSafe` already uses for the same reason.
 */
const DAYCARE_CHUNK = 500;

/**
 * Every row carries a region-prefixed id and a region. Both arrived together, so either one
 * being absent means the file was written by older code.
 */
const isNamespaced = (rows: SeedDaycare[]): boolean =>
  rows.every((r) => typeof r.region === 'string' && r.region.length > 0 && r.id.startsWith(`${r.region}:`));

/**
 * The primary key is the only thing keeping three datasets from overwriting each other.
 *
 * Worth a loud failure rather than trust: the seed upserts, so a collision does not error — it
 * silently keeps whichever row came last and the count still looks plausible. Peel already
 * reuses its own `LM_ID` across different locations (see daycares-regional.ts), so this is a
 * live hazard and not a hypothetical one.
 */
function dedupeDaycares(rows: SeedDaycare[]): SeedDaycare[] {
  const seen = new Map<string, SeedDaycare>();
  const out: SeedDaycare[] = [];

  for (const row of rows) {
    const previous = seen.get(row.id);
    if (previous === undefined) {
      seen.set(row.id, row);
      out.push(row);
      continue;
    }
    /**
     * A byte-identical repeat is a duplicated row upstream, not a key collision.
     *
     * Throwing on it would be a boot failure — `runSeed` runs inside `prepareDatabase`, before
     * the port opens — over something an upsert would have absorbed without noticing. A genuine
     * clash, two different centres claiming one key, still fails loudly: that one silently
     * discards a centre and leaves the count looking plausible.
     */
    if (JSON.stringify(previous) === JSON.stringify(row)) continue;
    throw new Error(
      `Duplicate daycare id "${row.id}": "${previous.name}" and "${row.name}" differ. ` +
        'Two regions, or one region twice, are claiming the same primary key.',
    );
  }

  return out;
}

async function seedDaycares(db: Database, rows: SeedDaycare[]): Promise<void> {
  for (let i = 0; i < rows.length; i += DAYCARE_CHUNK) {
    await insertDaycareChunk(db, rows.slice(i, i + DAYCARE_CHUNK));
  }
}

async function insertDaycareChunk(db: Database, rows: SeedDaycare[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(daycares)
    .values(rows)
    .onConflictDoUpdate({
      target: daycares.id,
      set: {
        name: sql`excluded.name`,
        region: sql`excluded.region`,
        capacityKnown: sql`excluded.capacity_known`,
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

async function seedRentSafe(db: Database, rows: SeedRentSafeBuilding[]): Promise<void> {
  // Chunked because 3,585 rows times fourteen columns exceeds what one statement should carry.
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(rentsafeBuildings)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: rentsafeBuildings.rsn,
        set: {
          siteAddress: sql`excluded.site_address`,
          normalizedAddress: sql`excluded.normalized_address`,
          score: sql`excluded.score`,
          evaluatedOn: sql`excluded.evaluated_on`,
          yearBuilt: sql`excluded.year_built`,
          confirmedStoreys: sql`excluded.confirmed_storeys`,
          confirmedUnits: sql`excluded.confirmed_units`,
          propertyType: sql`excluded.property_type`,
          ward: sql`excluded.ward`,
          wardName: sql`excluded.ward_name`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          updatedAt: sql`now()`,
        },
      });
  }
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

  /**
   * Grouped by region, because one total would hide the thing most worth seeing: whether the
   * presence-only regions actually arrived, and that they carry no capacity. A Peel row with
   * `capacityKnown` true would mean the normaliser had started lying.
   */
  const byRegion = await db
    .select({
      region: daycares.region,
      total: sql<number>`count(*)::int`,
      capacityKnown: sql<number>`count(*) filter (where ${daycares.capacityKnown})::int`,
      toddler: sql<number>`count(*) filter (where ${daycares.toddlerSpace} > 0)::int`,
    })
    .from(daycares)
    .groupBy(daycares.region)
    .orderBy(daycares.region);

  const lines = await db
    .select({
      line: transitStations.line,
      status: transitStations.status,
      count: sql<number>`count(*)::int`,
    })
    .from(transitStations)
    .groupBy(transitStations.line, transitStations.status)
    .orderBy(transitStations.status, transitStations.line);

  const [rs] = await db
    .select({
      total: sql<number>`count(*)::int`,
      mean: sql<number>`round(avg(${rentsafeBuildings.score})::numeric, 2)::float8`,
      median: sql<number>`percentile_cont(0.5) within group (order by ${rentsafeBuildings.score})::float8`,
      withYear: sql<number>`count(*) filter (where ${rentsafeBuildings.yearBuilt} is not null)::int`,
      preControl: sql<number>`count(*) filter (where ${rentsafeBuildings.yearBuilt} <= 2017)::int`,
      withCoords: sql<number>`count(*) filter (where ${rentsafeBuildings.lat} is not null)::int`,
    })
    .from(rentsafeBuildings);

  const profileRows = await db
    .select({ id: profiles.id, active: profiles.active, hard: profiles.hard, soft: profiles.soft })
    .from(profiles);

  console.log('\n--- seed report ---');
  console.log(`daycares:            ${dc?.total ?? 0}`);
  for (const r of byRegion) {
    const coverage = r.capacityKnown === r.total ? 'capacity per age group' : 'presence only';
    console.log(`  ${r.region.padEnd(18)} ${String(r.total).padStart(5)}  (${coverage}, toddler ${r.toddler})`);
  }
  console.log(`  with toddler room: ${dc?.toddler ?? 0}`);
  console.log(`  CWELCC ($10/day):  ${dc?.cwelcc ?? 0}`);
  console.log(`  toddler + CWELCC:  ${dc?.toddlerCwelcc ?? 0}   <- the set that actually matters`);
  console.log('\ntransit stations:');
  for (const row of lines) {
    console.log(`  [${row.status.padEnd(11)}] ${String(row.line).padEnd(46)} ${row.count}`);
  }
  // Printed so that a structural change to a profile is visible after seeding, rather than
  // something you have to go and query for.
  // The mean is printed because buildingScore's curve is anchored on it. A constant nobody ever
  // re-checks against the data is a constant that quietly stops being true.
  console.log('\nRentSafeTO buildings:');
  console.log(`  evaluated:         ${rs?.total ?? 0}`);
  console.log(`  mean score:        ${rs?.mean ?? 0}   <- buildingScore is anchored here`);
  console.log(`  median score:      ${rs?.median ?? 0}`);
  console.log(`  with a year built: ${rs?.withYear ?? 0}  (${rs?.preControl ?? 0} at or before 2017 — rent controlled)`);
  console.log(`  with coordinates:  ${rs?.withCoords ?? 0}`);

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
    // Printed because an area cut is invisible in the numbers above and is the one filter
    // that removes listings the rest of the profile would happily rank.
    const excluded = p.hard.excludeAreas ?? [];
    if (excluded.length > 0) console.log(`     excludes areas: ${excluded.join(', ')}`);
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

  /**
   * Three regions, three files, one table.
   *
   * Separate files rather than one merged `daycares.json` so that a refresh of one portal is a
   * diff against that region alone — Toronto's file is 634 KB, and a merged one would make
   * every re-seed an unreviewable churn. They are seeded together because coverage is a
   * property of the region (geo/coverage.ts) and not of the storage.
   */
  console.log('daycares (City of Toronto CKAN)...');
  const torontoDaycares = await loadOrFetch(
    DAYCARE_SEED_PATH,
    refresh,
    () => fetchDaycares(env.SCRAPER_CONTACT_EMAIL),
    undefined,
    isNamespaced,
  );

  console.log('daycares (Region of Peel ArcGIS — presence only, no age-group capacity)...');
  const peelDaycares = await loadOrFetch(
    PEEL_DAYCARE_SEED_PATH,
    refresh,
    () => fetchPeelDaycares(env.SCRAPER_CONTACT_EMAIL),
    undefined,
    isNamespaced,
  );

  console.log('daycares (Region of Waterloo ArcGIS — presence only, no age-group capacity)...');
  const waterlooDaycares = await loadOrFetch(
    WATERLOO_DAYCARE_SEED_PATH,
    refresh,
    () => fetchWaterlooDaycares(env.SCRAPER_CONTACT_EMAIL),
    undefined,
    isNamespaced,
  );

  const daycareRows = dedupeDaycares([...torontoDaycares, ...peelDaycares, ...waterlooDaycares]);
  await seedDaycares(db, daycareRows);

  console.log('transit stations (Overpass + manual future lines)...');
  const transitRows = await loadOrFetch(TRANSIT_SEED_PATH, refresh, () => buildTransitSeed(env.SCRAPER_CONTACT_EMAIL));
  await seedTransit(db, transitRows);

  /**
   * Captured, not seeded. The former municipality boundaries stopped moving in 1998, so
   * geo/areas.ts reads the committed file directly rather than through the database — and
   * the hard filter that cuts Scarborough and East York depends on it being present.
   */
  console.log('municipal boundaries (City of Toronto CKAN)...');
  const boundaryRows = await loadOrFetch(
    BOUNDARY_SEED_PATH,
    refresh,
    () => fetchMunicipalBoundaries(env.SCRAPER_CONTACT_EMAIL),
    serializeBoundaries,
  );

  console.log('RentSafeTO building evaluations (City of Toronto CKAN)...');
  const rentsafeRows = await loadOrFetch(RENTSAFE_SEED_PATH, refresh, () =>
    fetchRentSafeBuildings(env.SCRAPER_CONTACT_EMAIL),
  );
  await seedRentSafe(db, rentsafeRows);

  console.log(`profiles...${forceProfiles ? ' (--force-profiles: overwriting hard/soft/notify)' : ''}`);
  await seedProfiles(db, env.TELEGRAM_CHAT_IDS ?? ['TODO-set-TELEGRAM_CHAT_IDS'], forceProfiles);
  if (!env.TELEGRAM_CHAT_IDS) {
    console.warn('  note: TELEGRAM_CHAT_IDS unset — profile seeded with a placeholder; nothing will send.');
  }

  if (!options.quiet) {
    console.log(
      `\nmunicipal boundaries: ${boundaryRows.map((b) => `${b.name} (${b.ring.length})`).join(', ')}`,
    );
    await report(db);
  }
}

/** True when the geography index has nothing in it — i.e. this database has never been seeded. */
/**
 * Whether the seeded geography still matches what the code claims coverage for.
 *
 * This was `count(*) === 0` — "has this database ever been seeded" — and that is not the same
 * question, which is how adding two regions produced a deployment trap. An existing database has
 * 1,089 Toronto rows, so boot skipped seeding entirely and Peel's 581 and Waterloo's 287 were
 * never inserted. Meanwhile `geo/coverage.ts` is a static map and went on claiming Mississauga
 * was `presenceOnly`, so the childcare filter counted zero centres and **rejected** every
 * Mississauga and Cambridge listing — logging a data gap as a verdict about the place, which is
 * the one failure that whole module exists to prevent. And there is no psql in the runtime image
 * to fix it by hand.
 *
 * Asking per region closes the gap for good: a region added in code is a region the next boot
 * backfills. `runSeed` upserts throughout, so re-running it costs nothing.
 */
export async function needsSeeding(db: Database): Promise<boolean> {
  const rows = await db.select({ region: daycares.region }).from(daycares).groupBy(daycares.region);
  const present = new Set(rows.map((r) => r.region));
  return SEEDED_REGIONS.some((region) => !present.has(region.key));
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
