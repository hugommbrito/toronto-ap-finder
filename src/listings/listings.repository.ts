import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { BuildingEntry } from '@/sources/source.interface';
import {
  cycleRuns,
  type CycleRunRow,
  sourceBuildings,
  type SourceBuildingRow,
  listingVerifications,
  type ListingVerificationRow,
  listings,
  matches,
  needsReview,
  rejectionLog,
  type ListingRow,
} from '@/db/schema';
import type { Rejection, Review } from '@/scoring/hard-filters';
import type { ScoreResult } from '@/scoring/scorer';
import type { ListingSource, TriageListing } from './listing.types';

/**
 * Failed re-checks before a listing stops being asked about.
 *
 * Three, matching the rate limiter's circuit: enough that a transient failure does not retire a
 * listing, few enough that a permanently unreadable one stops costing a request every cycle.
 */
export const MAX_MISSED_SWEEPS = 3;

export interface StoredListing {
  id: string;
  isNew: boolean;
}

/**
 * All database writes the pipeline performs.
 *
 * Numeric columns round-trip as strings through postgres-js, so conversion happens here
 * rather than leaking into the scoring code, which works in plain numbers.
 */
@Injectable()
export class ListingsRepository {
  constructor(@Inject('DATABASE') private readonly db: Database) {}

  /**
   * Idempotent on `(source, source_id)`, which is what makes top-ads repeated across pages
   * — and a restart mid-cycle — harmless.
   */
  async upsertListing(listing: TriageListing, fingerprint: string): Promise<StoredListing> {
    const [row] = await this.db
      .insert(listings)
      .values({
        source: listing.source,
        sourceId: listing.sourceId,
        url: listing.url,
        fingerprint,
        title: listing.title,
        rawText: listing.rawText,
        rentBase: String(listing.rentBase),
        parkingIncluded: listing.parkingIncluded,
        parkingCost: listing.parkingCost === null ? null : String(listing.parkingCost),
        utilitiesIncluded: listing.utilitiesIncluded,
        totalMonthlyCost: String(listing.totalMonthlyCost),
        beds: listing.beds,
        dens: listing.dens,
        baths: listing.baths === null ? null : String(listing.baths),
        hasLocker: listing.hasLocker,
        inSuiteLaundry: listing.inSuiteLaundry,
        address: listing.address,
        city: listing.city,
        lat: listing.lat,
        lng: listing.lng,
        availableFrom: listing.availableFrom,
        postedAt: listing.postedAt,
        buildingBuiltBefore2018: listing.buildingBuiltBefore2018,
      })
      .onConflictDoUpdate({
        target: [listings.source, listings.sourceId],
        set: {
          url: sql`excluded.url`,
          fingerprint: sql`excluded.fingerprint`,
          title: sql`excluded.title`,
          // Only overwrite the body once hydration has actually produced one.
          rawText: sql`coalesce(excluded.raw_text, listings.raw_text)`,
          rentBase: sql`excluded.rent_base`,
          parkingIncluded: sql`excluded.parking_included`,
          parkingCost: sql`excluded.parking_cost`,
          utilitiesIncluded: sql`excluded.utilities_included`,
          totalMonthlyCost: sql`excluded.total_monthly_cost`,
          beds: sql`excluded.beds`,
          dens: sql`excluded.dens`,
          baths: sql`excluded.baths`,
          hasLocker: sql`excluded.has_locker`,
          inSuiteLaundry: sql`excluded.in_suite_laundry`,
          address: sql`excluded.address`,
          city: sql`excluded.city`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          // Coalesced, not overwritten. evaluate() fills this from the City's inspection data
          // after hydration, and the next cycle's triage upsert carries null — so a plain
          // `excluded` would erase the year-built fact on every sweep. raw_text and posted_at
          // already use this pattern for the same reason.
          buildingBuiltBefore2018: sql`coalesce(excluded.building_built_before_2018, ${listings.buildingBuiltBefore2018})`,
          postedAt: sql`coalesce(excluded.posted_at, listings.posted_at)`,
          lastSeenAt: sql`now()`,
          // Seeing it again clears both the miss counter and any delisting.
          missedSweeps: sql`0`,
          delistedAt: sql`null`,
        },
      })
      .returning({ id: listings.id, firstSeenAt: listings.firstSeenAt, lastSeenAt: listings.lastSeenAt });

    if (!row) throw new Error(`upsert returned no row for ${listing.source}:${listing.sourceId}`);
    return { id: row.id, isNew: row.firstSeenAt.getTime() === row.lastSeenAt.getTime() };
  }

  /**
   * Listings whose detail page has already been fetched, keyed by source id.
   *
   * This is what stops every cycle from re-downloading the body of every candidate it has
   * ever seen. At this cadence that repetition is precisely what earns an HTTP 429.
   */
  async findHydrated(source: ListingSource, sourceIds: string[]): Promise<Map<string, ListingRow>> {
    if (sourceIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.source, source),
          inArray(listings.sourceId, sourceIds),
          isNotNull(listings.hydratedAt),
          isNotNull(listings.rawText),
        ),
      );
    return new Map(rows.map((r) => [r.sourceId, r]));
  }

  /** Every live listing whose body we already hold — the corpus to re-score against. */
  async findAllHydrated(): Promise<ListingRow[]> {
    return this.db
      .select()
      .from(listings)
      .where(and(isNotNull(listings.hydratedAt), isNotNull(listings.rawText), isNull(listings.delistedAt)));
  }

  /**
   * Listings worth re-checking: ones that cleared the filters for some profile and are not
   * already known gone, least-recently-confirmed first, **from one source**.
   *
   * Delisting is confirmed rather than presumed. A listing drops off the first pages within
   * days while remaining perfectly available, so "not seen lately" says nothing — only the
   * ad's own status does. That costs one request each, so the budget is deliberately small.
   *
   * Three things here were wrong at once, and they compounded into a permanent failure that
   * looked like Kijiji changing its markup.
   *
   * **The source filter.** There wasn't one. The recheck stage runs against a single unit
   * source and handed it whatever this returned, so a Zumper listing was fetched from
   * zumper.com by the Kijiji adapter, through Kijiji's rate limiter, and parsed for a
   * `__NEXT_DATA__` block Zumper has never had. The error it raised — "the page structure
   * changed" — was true of nothing.
   *
   * **The ordering.** `DISTINCT ON (id)` obliges Postgres to sort by `id` first, so the
   * documented "least-recently-confirmed" ordering was unreachable: it returned the same
   * lowest-uuid rows every cycle, forever, and `markStillListed` updating `last_seen_at`
   * changed nothing. `EXISTS` states the actual requirement — a listing that matched *some*
   * profile — without duplicating rows, which is what `DISTINCT ON` was compensating for.
   *
   * **The dead end.** A listing that cannot be parsed at all was picked again on every cycle.
   * `missed_sweeps` caps that: after enough failures it leaves the queue rather than blocking
   * it. It is never marked delisted on that basis — failing to read an ad is not evidence the
   * ad is gone, and presuming so is exactly what this stage exists to avoid.
   */
  async findForRecheck(source: string, limit: number, maxMissedSweeps = MAX_MISSED_SWEEPS): Promise<ListingRow[]> {
    return this.db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.source, source as ListingSource),
          isNull(listings.delistedAt),
          sql`${listings.missedSweeps} < ${maxMissedSweeps}`,
          sql`exists (select 1 from ${matches} where ${matches.listingId} = ${listings.id})`,
        ),
      )
      .orderBy(listings.lastSeenAt)
      .limit(limit);
  }

  /**
   * Records that a re-check could not reach a verdict.
   *
   * Deliberately not `markDelisted`: the ad may be perfectly alive and the failure ours. This
   * only moves the listing towards the back of the queue and, past the cap, out of it — so one
   * unreadable advertisement cannot consume the budget every cycle and take the whole run down
   * with it.
   */
  async markRecheckFailed(listingId: string): Promise<number> {
    const [row] = await this.db
      .update(listings)
      .set({ missedSweeps: sql`${listings.missedSweeps} + 1` })
      .where(eq(listings.id, listingId))
      .returning({ missedSweeps: listings.missedSweeps });
    return row?.missedSweeps ?? 0;
  }

  async markDelisted(listingId: string): Promise<void> {
    await this.db
      .update(listings)
      .set({ delistedAt: new Date(), missedSweeps: sql`${listings.missedSweeps} + 1` })
      .where(eq(listings.id, listingId));
  }

  async markStillListed(listingId: string): Promise<void> {
    await this.db
      .update(listings)
      .set({ lastSeenAt: new Date(), missedSweeps: 0 })
      .where(eq(listings.id, listingId));
  }

  async markHydrated(listingId: string): Promise<void> {
    await this.db.update(listings).set({ hydratedAt: new Date() }).where(eq(listings.id, listingId));
  }

  /** Written even for ads rejected during triage, before a listing row exists. */
  async recordRejections(
    profileId: string,
    source: string,
    sourceId: string,
    url: string | null,
    listingId: string | null,
    rejections: Rejection[],
  ): Promise<void> {
    if (rejections.length === 0) return;
    await this.db.insert(rejectionLog).values(
      rejections.map((r) => ({
        profileId,
        listingId,
        source,
        sourceId,
        url,
        reason: r.reason,
        detail: r.detail,
      })),
    );
  }

  async recordReviews(profileId: string, listingId: string, reviews: Review[]): Promise<void> {
    if (reviews.length === 0) return;
    await this.db
      .insert(needsReview)
      .values(reviews.map((r) => ({ profileId, listingId, field: r.field, reason: r.reason })));
  }

  /**
   * The verdict already recorded for a listing, if any.
   *
   * Returned rather than merely counted, because a verdict has to be *re-applied* on every
   * later cycle, not just recorded once. Skipping a listing because it had been read before
   * silently discarded the verdict's effect: a unit the model had cut down to one bedroom
   * went back to notifying on the next pass.
   */
  async findVerification(listingId: string): Promise<ListingVerificationRow | null> {
    const [row] = await this.db
      .select()
      .from(listingVerifications)
      .where(eq(listingVerifications.listingId, listingId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Records the buildings a search page listed, keeping each one's watermark.
   *
   * `expandedModifiedOn` is deliberately never written here — only an actual expansion may
   * advance it. Writing it on sight would mark every building as done without ever opening
   * one.
   */
  async upsertBuildings(source: string, entries: BuildingEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db
      .insert(sourceBuildings)
      .values(
        entries.map((b) => ({
          source,
          sourceId: b.sourceId,
          url: b.url,
          name: b.name,
          address: b.address,
          lat: b.lat,
          lng: b.lng,
          floorplanCount: b.floorplanCount,
          modifiedOn: b.modifiedOn,
        })),
      )
      .onConflictDoUpdate({
        target: [sourceBuildings.source, sourceBuildings.sourceId],
        set: {
          url: sql`excluded.url`,
          name: sql`excluded.name`,
          address: sql`excluded.address`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          floorplanCount: sql`excluded.floorplan_count`,
          modifiedOn: sql`excluded.modified_on`,
          lastSeenAt: sql`now()`,
        },
      });
  }

  /**
   * Buildings worth opening, in one place because two queries ask the question.
   *
   * Three ways a building becomes due, and the third one is why this exists:
   *
   * 1. **Never opened.** Keyed on `last_expanded_at`, which is the column that actually records
   *    having opened it. It used to be keyed on `expanded_modified_on`, and that was the bug:
   *    `markBuildingExpanded` copies the source's `modified_on` into it, so for a source that
   *    publishes no last-modified — every property manager — opening a building wrote `NULL` and
   *    left it as due as it was before. Worse than a treadmill: `ORDER BY last_expanded_at` puts
   *    nulls last in Postgres, so already-opened buildings outranked never-opened ones and the
   *    rest of the inventory would never be reached, while the log printed a healthy "12 opened".
   * 2. **The source says it changed.** The cheap path, and the only one Zumper normally uses.
   * 3. **It has aged out.** Without a watermark there is nothing to compare, so time is the only
   *    signal left. This also covers the opposite failure: a source that *stops* filling
   *    `modified_on` would otherwise freeze its inventory permanently and silently.
   */
  private dueForExpansion(source: string, refreshAfterMs: number) {
    return and(
      eq(sourceBuildings.source, source),
      or(
        isNull(sourceBuildings.lastExpandedAt),
        and(
          isNotNull(sourceBuildings.modifiedOn),
          sql`${sourceBuildings.modifiedOn} > ${sourceBuildings.expandedModifiedOn}`,
        ),
        sql`${sourceBuildings.lastExpandedAt} < now() - ${sql.raw(`interval '${Math.round(refreshAfterMs / 1000)} seconds'`)}`,
      ),
    );
  }

  /**
   * Never-opened first, then longest since we last looked, so a backfill drains steadily.
   *
   * `NULLS FIRST` is load-bearing rather than tidy: a never-opened building has a null
   * `last_expanded_at`, and Postgres sorts nulls last by default, which would put every building
   * we have already seen ahead of every building we have not.
   */
  async findBuildingsDueForExpansion(
    source: string,
    limit: number,
    refreshAfterMs: number,
  ): Promise<SourceBuildingRow[]> {
    return this.db
      .select()
      .from(sourceBuildings)
      .where(this.dueForExpansion(source, refreshAfterMs))
      .orderBy(sql`${sourceBuildings.lastExpandedAt} ASC NULLS FIRST`)
      .limit(limit);
  }

  /**
   * How many buildings are waiting. Counted, not inferred from the page of work taken.
   *
   * Shares `dueForExpansion` with the query above deliberately. The two conditions used to be
   * written out twice, and this is the number the cycle reports as the backlog — if they drifted,
   * the report would quietly start lying about how much work is left.
   */
  async countBuildingsDueForExpansion(source: string, refreshAfterMs: number): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sourceBuildings)
      .where(this.dueForExpansion(source, refreshAfterMs));
    return row?.n ?? 0;
  }

  /** Advances the watermark. Only called after a building has actually been opened. */
  async markBuildingExpanded(id: string, modifiedOn: Date | null, unitCount: number): Promise<void> {
    await this.db
      .update(sourceBuildings)
      .set({ expandedModifiedOn: modifiedOn, lastExpandedAt: new Date(), lastUnitCount: unitCount })
      .where(eq(sourceBuildings.id, id));
  }


  /**
   * Records which inspected building a listing is in, how the two were matched, and the year-built
   * fact that match unlocks.
   *
   * `buildingBuiltBefore2018` is coalesced rather than assigned: the City's file is a fallback for
   * something the source may already have stated, and a secondary dataset does not get to overrule
   * a primary one. Written here rather than left in memory because `evaluate()` never upserts the
   * listing — so without this the fact is re-derived on every cycle, used in the score, and
   * invisible to every query.
   */
  async linkRentSafe(
    listingId: string,
    rsn: string,
    tier: string,
    builtBefore2018: boolean | null,
  ): Promise<void> {
    await this.db
      .update(listings)
      .set({
        rentsafeRsn: rsn,
        rentsafeMatch: tier,
        buildingBuiltBefore2018: sql`coalesce(${listings.buildingBuiltBefore2018}, ${builtBefore2018})`,
      })
      .where(eq(listings.id, listingId));
  }

  // --- operational history -----------------------------------------------------------
  //
  // The pipeline used to keep only the last report, in memory, in one slot shared by two cycles.
  // These are what make "which runs worked, and which failed" answerable after a redeploy.

  async recordCycleRun(row: typeof cycleRuns.$inferInsert): Promise<void> {
    await this.db.insert(cycleRuns).values(row);
  }

  /** Runs in a window, newest first. Capped, because this feeds an HTTP response. */
  async findCycleRuns(since: Date, limit = 500): Promise<CycleRunRow[]> {
    return this.db
      .select()
      .from(cycleRuns)
      .where(gte(cycleRuns.startedAt, since))
      .orderBy(desc(cycleRuns.startedAt))
      .limit(limit);
  }

  /**
   * When a cycle last finished at all — the input to the watchdog.
   *
   * Ordered on the column rather than `max()` in raw SQL, deliberately. `sql<Date>` is an
   * assertion and not a conversion: the driver hands back a string for a computed timestamp, and
   * the annotation would make TypeScript vouch for a Date that never arrives. Selecting the
   * column lets drizzle map the type it declared.
   */
  async lastCycleFinishedAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: cycleRuns.finishedAt })
      .from(cycleRuns)
      .orderBy(desc(cycleRuns.finishedAt))
      .limit(1);
    return row?.at ?? null;
  }

  /**
   * The funnel, aggregated over a window.
   *
   * This is the instrument: it is what showed a 900 m hard transit limit was killing 41% of
   * everything. Counted in SQL rather than in memory because the table only grows.
   */
  async rejectionTally(since: Date): Promise<Array<{ reason: string; count: number }>> {
    return this.db
      .select({ reason: rejectionLog.reason, count: sql<number>`count(*)::int` })
      .from(rejectionLog)
      .where(gte(rejectionLog.createdAt, since))
      .groupBy(rejectionLog.reason)
      .orderBy(sql`count(*) desc`);
  }

  /** Listings still waiting on a human decision. */
  async openReviewCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(needsReview)
      .where(isNull(needsReview.resolvedAt));
    return row?.n ?? 0;
  }

  /** Upserts, so a retry after a failed call replaces the recorded error with the verdict. */
  async recordVerification(row: typeof listingVerifications.$inferInsert): Promise<void> {
    await this.db
      .insert(listingVerifications)
      .values(row)
      .onConflictDoUpdate({
        target: listingVerifications.listingId,
        set: {
          model: sql`excluded.model`,
          bedrooms: sql`excluded.bedrooms`,
          dens: sql`excluded.dens`,
          isEntireUnit: sql`excluded.is_entire_unit`,
          isSplitDwelling: sql`excluded.is_split_dwelling`,
          confidence: sql`excluded.confidence`,
          evidence: sql`excluded.evidence`,
          notes: sql`excluded.notes`,
          applied: sql`excluded.applied`,
          error: sql`excluded.error`,
          createdAt: sql`now()`,
        },
      });
  }

  async upsertMatch(listingId: string, profileId: string, result: ScoreResult): Promise<void> {
    await this.db
      .insert(matches)
      .values({
        listingId,
        profileId,
        score: result.score,
        breakdown: result.breakdown,
      })
      .onConflictDoUpdate({
        target: [matches.listingId, matches.profileId],
        set: { score: sql`excluded.score`, breakdown: sql`excluded.breakdown` },
      });
  }
}
