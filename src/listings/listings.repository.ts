import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import {
  listingVerifications,
  listings,
  matches,
  needsReview,
  rejectionLog,
  type ListingRow,
} from '@/db/schema';
import type { Rejection, Review } from '@/scoring/hard-filters';
import type { ScoreResult } from '@/scoring/scorer';
import type { ListingSource, TriageListing } from './listing.types';

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
          buildingBuiltBefore2018: sql`excluded.building_built_before_2018`,
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
   * ever seen. On a 20-minute schedule that repetition is precisely what earns an HTTP 429.
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
   * already known gone, least-recently-confirmed first.
   *
   * Delisting is confirmed rather than presumed. A listing drops off the first pages within
   * days while remaining perfectly available, so "not seen lately" says nothing — only the
   * ad's own status does. That costs one request each, so the budget is deliberately small.
   */
  async findForRecheck(limit: number): Promise<ListingRow[]> {
    return this.db
      .selectDistinctOn([listings.id])
      .from(listings)
      .innerJoin(matches, eq(matches.listingId, listings.id))
      .where(isNull(listings.delistedAt))
      .orderBy(listings.id, listings.lastSeenAt)
      .limit(limit)
      .then((rows) => rows.map((r) => r.listings));
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

  /** Verdicts already recorded, so the same advertisement is never read twice. */
  async findVerifiedListingIds(listingIds: string[]): Promise<Set<string>> {
    if (listingIds.length === 0) return new Set();
    const rows = await this.db
      .select({ listingId: listingVerifications.listingId })
      .from(listingVerifications)
      .where(inArray(listingVerifications.listingId, listingIds));
    return new Set(rows.map((r) => r.listingId));
  }

  async recordVerification(row: typeof listingVerifications.$inferInsert): Promise<void> {
    await this.db.insert(listingVerifications).values(row).onConflictDoNothing({
      target: listingVerifications.listingId,
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
