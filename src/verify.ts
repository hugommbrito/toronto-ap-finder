import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { createDb, type Database } from '@/db/client';
import { daycares, profiles, transitStations } from '@/db/schema';
import { tenantProfileSchema, type TenantProfile } from '@/profiles/profile.schema';
import { GeoIndex, type DaycarePoint, type ScorableListing, type TransitPoint } from '@/scoring/context';
import { scoreListing } from '@/scoring/scorer';
import { applyHardFilters } from '@/scoring/hard-filters';

/**
 * End-to-end check of the Phase 0 acceptance criteria, against the real database.
 *
 * The unit tests prove the logic. This proves the wiring: that a profile stored as jsonb
 * survives the round trip through Zod and drives the scorer without a line of code knowing
 * which profile it is.
 */

async function loadGeo(db: Database): Promise<GeoIndex> {
  const [d, s] = await Promise.all([db.select().from(daycares), db.select().from(transitStations)]);
  const daycarePoints: DaycarePoint[] = d.map((x) => ({
    id: x.id,
    name: x.name,
    lat: x.lat,
    lng: x.lng,
    infantSpace: x.infantSpace,
    toddlerSpace: x.toddlerSpace,
    preschoolSpace: x.preschoolSpace,
    kindergartenSpace: x.kindergartenSpace,
    schoolageSpace: x.schoolageSpace,
    subsidy: x.subsidy,
    cwelcc: x.cwelcc,
    capacityKnown: x.capacityKnown,
  }));
  const stationPoints: TransitPoint[] = s.map((x) => ({
    id: x.id,
    name: x.name,
    line: x.line,
    status: x.status,
    expectedYear: x.expectedYear,
    lat: x.lat,
    lng: x.lng,
  }));
  return new GeoIndex(daycarePoints, stationPoints);
}

/** Yonge & Eglinton — Line 1 / Line 5 interchange, dense childcare. */
const YONGE_EGLINTON = { lat: 43.7055, lng: -79.3982, city: 'Toronto' };
/** Keelesdale — a new Line 5 stop, the corridor this profile is aimed at. */
const KEELESDALE = { lat: 43.6889, lng: -79.4795, city: 'Toronto' };

const AMENITIES = { hasLocker: true, inSuiteLaundry: true, buildingBuiltBefore2018: true };
const THREE_BED = { beds: 3, dens: 0 };

/**
 * Price ladder at one fixed location and layout. Everything except rent is held constant,
 * so the assertion below tests the rent curve rather than the difference between two
 * neighbourhoods.
 */
const PRICE_LADDER: { label: string; listing: ScorableListing }[] = [
  { label: '3BR, 2650 (under target)', listing: { totalMonthlyCost: 2650, ...THREE_BED, ...YONGE_EGLINTON, ...AMENITIES } },
  { label: '3BR, 3000 (over target)', listing: { totalMonthlyCost: 3000, ...THREE_BED, ...YONGE_EGLINTON, ...AMENITIES } },
  { label: '3BR, 3190 (at the ceiling)', listing: { totalMonthlyCost: 3190, ...THREE_BED, ...YONGE_EGLINTON, ...AMENITIES } },
];

/**
 * Layout ladder at one fixed price and location, so only the number of rooms moves.
 */
const LAYOUT_LADDER: { label: string; listing: ScorableListing }[] = [
  { label: '3BR, 2900 (separate office)', listing: { totalMonthlyCost: 2900, beds: 3, dens: 0, ...YONGE_EGLINTON, ...AMENITIES } },
  { label: '2BR + den, 2900 (den as office)', listing: { totalMonthlyCost: 2900, beds: 2, dens: 1, ...YONGE_EGLINTON, ...AMENITIES } },
  { label: '2BR, 2900 (office in the bedroom)', listing: { totalMonthlyCost: 2900, beds: 2, dens: 0, ...YONGE_EGLINTON, ...AMENITIES } },
];

/**
 * Same rent, different neighbourhoods. Informational, not asserted: which of these should
 * win is a calibration judgement, and seeing the gap is how the weights get tuned.
 */
const LOCATION_PAIR: { label: string; listing: ScorableListing }[] = [
  { label: 'Yonge & Eglinton, 3000', listing: { totalMonthlyCost: 3000, ...THREE_BED, ...YONGE_EGLINTON, ...AMENITIES } },
  { label: 'Keelesdale (Line 5), 3000', listing: { totalMonthlyCost: 3000, ...THREE_BED, ...KEELESDALE, ...AMENITIES } },
];

function printScore(label: string, profile: TenantProfile, geo: GeoIndex, listing: ScorableListing): number {
  const result = scoreListing({ listing, profile, geo });
  const parts = Object.entries(result.breakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v.toFixed(1)}`)
    .join('  ');
  console.log(`  ${result.score.toFixed(1).padStart(5)}  ${label}`);
  console.log(`         ${parts}`);
  if (result.skipped.length > 0) console.log(`         (unknown, excluded: ${result.skipped.join(', ')})`);
  return result.score;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const handle = createDb(env.DATABASE_URL, { max: 1 });
  const failures: string[] = [];

  try {
    const geo = await loadGeo(handle.db);
    console.log(`geography: ${geo.daycareCount} daycares, ${geo.stationCount} stations\n`);
    if (geo.daycareCount === 0 || geo.stationCount === 0) failures.push('geography index is empty');

    // --- 1. profile round-trips from jsonb through Zod ---
    const [row] = await handle.db.select().from(profiles).where(sql`${profiles.id} = 'sister'`).limit(1);
    if (!row) throw new Error('profile "sister" not found — run "pnpm seed"');
    const sister = tenantProfileSchema.parse(row);
    console.log(`profile "${sister.id}" parsed from jsonb: target ${sister.soft.targetRent}, ceiling ${sister.hard.totalRentMax}\n`);

    // --- 2. the rent curve, at one fixed location ---
    console.log('price ladder (same location, only rent varies):');
    const ladder = PRICE_LADDER.map((s) => printScore(s.label, sister, geo, s.listing));
    console.log();
    if (!(ladder[0]! > ladder[1]! && ladder[1]! > ladder[2]!)) {
      failures.push(`rent curve is not monotonic: ${ladder.map((s) => s.toFixed(1)).join(' / ')}`);
    }

    // --- 2b. the layout ladder, at one fixed price ---
    console.log('layout ladder (same location and rent, only the rooms vary):');
    const layout = LAYOUT_LADDER.map((s) => printScore(s.label, sister, geo, s.listing));
    console.log();
    if (!(layout[0]! > layout[1]! && layout[1]! > layout[2]!)) {
      failures.push(`layout ladder is not ordered: ${layout.map((s) => s.toFixed(1)).join(' / ')}`);
    }

    // --- 2c. what the current weights are actually trading off ---
    console.log('location comparison (same rent and layout, different neighbourhoods):');
    const pair = LOCATION_PAIR.map((s) => printScore(s.label, sister, geo, s.listing));
    const gap = Math.abs(pair[0]! - pair[1]!);
    console.log(
      `\n  worth in final points:  500 of rent = ${(ladder[0]! - ladder[2]!).toFixed(1)}` +
        `   |  3BR over plain 2BR = ${(layout[0]! - layout[2]!).toFixed(1)}` +
        `   |  location = ${gap.toFixed(1)}`,
    );
    console.log('  If any of those trades looks wrong, change a weight in the profile row — not the code.\n');

    // --- 3. hard filters: a floor at two bedrooms, everything above is ranked not cut ---
    const base = {
      totalMonthlyCost: 2900,
      parkingIncluded: true,
      parkingCost: null,
      city: 'City of Toronto',
      lat: 43.7055,
      lng: -79.3982,
      availableFrom: null,
    };
    const threeBed = applyHardFilters({ ...base, beds: 3, dens: 0 }, sister, geo);
    const twoPlusDen = applyHardFilters({ ...base, beds: 2, dens: 1 }, sister, geo);
    const plainTwo = applyHardFilters({ ...base, beds: 2, dens: 0 }, sister, geo);
    const oneBed = applyHardFilters({ ...base, beds: 1, dens: 1 }, sister, geo);
    console.log(
      `hard filters: 3BR=${threeBed.decision}  2BR+den=${twoPlusDen.decision}  ` +
        `2BR=${plainTwo.decision}  1BR+den=${oneBed.decision} (${oneBed.rejections[0]?.reason})`,
    );
    /**
     * Regional coverage, against the seeded data rather than a fixture.
     *
     * The unit tests prove the rule; this proves the *data* behind it — that Peel and Waterloo
     * rows actually arrived, carry no capacity, and therefore produce a review instead of the
     * rejection every 905 listing would have got before.
     */
    const coverageProbes: { label: string; place: { city: string; lat: number; lng: number }; expect: string }[] = [
      { label: 'Toronto (Yonge & Eglinton)', place: { city: 'Toronto', lat: 43.7055, lng: -79.3982 }, expect: 'pass' },
      { label: 'Mississauga (Square One)', place: { city: 'Mississauga', lat: 43.5890, lng: -79.6441 }, expect: 'review' },
      { label: 'Cambridge (Galt)', place: { city: 'Cambridge', lat: 43.3601, lng: -80.3127 }, expect: 'review' },
      { label: 'Lake Ontario (nothing near)', place: { city: 'Mississauga', lat: 43.45, lng: -79.55 }, expect: 'reject' },
    ];

    console.log('\nregional childcare coverage:');
    const coverageProblems: string[] = [];
    for (const probe of coverageProbes) {
      const verdict = applyHardFilters({ ...base, beds: 3, dens: 0, ...probe.place }, sister, geo);
      const why =
        verdict.decision === 'review'
          ? (verdict.reviews.find((r) => r.field === 'minDaycaresWithin')?.reason ?? '')
          : (verdict.rejections.find((r) => r.reason === 'daycare_coverage')
              ? 'no licensed centre in range'
              : '');
      console.log(`  ${probe.label.padEnd(28)} ${verdict.decision.padEnd(7)} ${why}`);
      if (verdict.decision !== probe.expect) {
        coverageProblems.push(`${probe.label}: expected ${probe.expect}, got ${verdict.decision}`);
      }
    }
    if (coverageProblems.length > 0) {
      throw new Error(`regional coverage is wrong:\n  ${coverageProblems.join('\n  ')}`);
    }
    console.log('');

    if (
      threeBed.decision !== 'pass' ||
      twoPlusDen.decision !== 'pass' ||
      plainTwo.decision !== 'pass' ||
      oneBed.decision !== 'reject'
    ) {
      failures.push('bedroom floor is not behaving: expected 2BR and up to pass, below 2BR to be rejected');
    }

    // --- 3b. the refused areas, against the boundaries actually shipped ---
    // Worth checking here rather than only in unit tests: this cut depends on
    // data/seed/municipal-boundaries.json being present in the running container, and its
    // failure mode is a Scarborough listing quietly arriving on her phone.
    const refused = sister.hard.excludeAreas;
    if (refused.length === 0) {
      console.log('refused areas: none configured\n');
    } else {
      // Thorncliffe Park (East York) and 567 Scarborough Golf Club Rd, both inside Toronto
      // and both labelled as Toronto — the case no city allowlist can catch.
      const inside = [
        { label: 'Scarborough (Golf Club Rd)', lat: 43.7608, lng: -79.21562 },
        { label: 'East York (Thorncliffe Park)', lat: 43.7043, lng: -79.3445 },
      ];
      const verdicts = inside.map((place) => {
        const outcome = applyHardFilters({ ...base, beds: 3, dens: 0, lat: place.lat, lng: place.lng }, sister, geo);
        const hit = outcome.rejections.find((r) => r.reason === 'excluded_area');
        return { label: place.label, area: hit?.detail.area ?? null };
      });
      console.log(`refused areas: ${refused.join(', ')}`);
      for (const v of verdicts) {
        console.log(`  ${v.label.padEnd(30)} ${v.area ? `cut as ${String(v.area)}` : 'NOT CUT'}`);
      }
      console.log();
      const missed = verdicts.filter((v) => v.area === null);
      if (missed.length > 0) {
        failures.push(
          `area cut is not working for ${missed.map((v) => v.label).join(', ')} — ` +
            'is data/seed/municipal-boundaries.json present?',
        );
      }
    }

    // --- 4. a second profile is a row, not a commit ---
    // Inserted inside a transaction that always rolls back, so verification leaves no trace.
    await handle.db
      .transaction(async (tx) => {
        await tx.insert(profiles).values({
          id: 'verify-tmp',
          label: 'Verification — different rule entirely',
          active: true,
          hard: {
            totalRentMax: 2600,
            bedroomRule: { kind: 'bedsPlusDen', beds: 1 },
            availableFrom: null,
            requireParking: false,
            minDaycaresWithin: null,
            allowSplitDwelling: true,
            maxTransitWalkM: 600,
            cities: ['Toronto'],
            excludeAreas: [],
          },
          soft: { targetRent: 2200, weights: { rentBelowTarget: 60, transitOperational: 40 } },
          notify: { telegramChatIds: ['tmp'], minScore: 50, includeMap: false },
        });

        const [tmpRow] = await tx.select().from(profiles).where(sql`${profiles.id} = 'verify-tmp'`).limit(1);
        const tmp = tenantProfileSchema.parse(tmpRow);

        const oneBedDen = { ...base, beds: 1, dens: 1, totalMonthlyCost: 2300 };
        const forTmp = applyHardFilters(oneBedDen, tmp, geo);
        const forSister = applyHardFilters(oneBedDen, sister, geo);
        console.log(`new profile from a single INSERT: 1BR+den → ${forTmp.decision} for "verify-tmp", ${forSister.decision} for "sister"`);
        if (forTmp.decision !== 'pass' || forSister.decision !== 'reject') {
          failures.push('a newly inserted profile did not drive the engine independently');
        }

        const tmpScore = scoreListing({ listing: PRICE_LADDER[0]!.listing, profile: tmp, geo });
        if (Object.keys(tmpScore.breakdown).some((k) => k.startsWith('daycare'))) {
          failures.push('a profile that asked for no daycare weights still got daycare components');
        }

        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });

    const [{ count } = { count: 0 }] = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(profiles);
    console.log(`profiles after rollback: ${count} (temporary profile left no trace)\n`);
    if (count !== 1) failures.push(`expected 1 profile after rollback, found ${count}`);
  } finally {
    await handle.close();
  }

  if (failures.length > 0) {
    console.error('VERIFICATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('all Phase 0 acceptance checks passed.');
}

class RollbackSignal extends Error {}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
