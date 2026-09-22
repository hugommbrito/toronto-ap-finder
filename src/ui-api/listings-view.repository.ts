import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { Database } from '@/db/client';
import {
  listingStates,
  listings,
  matches,
  needsReview,
  notifications,
  rentsafeBuildings,
  type ListingStateRow,
  type RentSafeBuildingRow,
} from '@/db/schema';
import type { ListingStatus, StateUpdate, Summary } from './api-types';

/** What SQL narrows before the service filters, sorts and pages in memory. */
export interface FeedFilter {
  minScore: number;
  maxRent?: number;
  includeDelisted: boolean;
  includeDismissed: boolean;
  status?: Exclude<ListingStatus, 'none'>;
}

/** The listing columns as the driver returns them: numerics are strings, timestamps are Dates. */
export interface ListingColumnsRow {
  id: string;
  source: string;
  sourceId: string;
  url: string;
  fingerprint: string;
  title: string;
  rentBase: string;
  parkingIncluded: boolean | null;
  parkingCost: string | null;
  parkingAvailable: boolean | null;
  utilitiesIncluded: string[];
  totalMonthlyCost: string;
  beds: number | null;
  dens: number;
  baths: string | null;
  areaSqft: number | null;
  hasLocker: boolean | null;
  inSuiteLaundry: boolean | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  postedAt: Date | null;
  availableFrom: string | null;
  buildingBuiltBefore2018: boolean | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  hydratedAt: Date | null;
  delistedAt: Date | null;
  rentsafeMatch: string | null;
}

export interface FeedRow {
  listing: ListingColumnsRow;
  score: number;
  breakdown: Record<string, number>;
  firstScoredAt: Date;
  stateStatus: ListingStatus | null;
  stateNote: string | null;
  stateUpdatedAt: Date | null;
  rentsafeRsn: string | null;
  rentsafeScore: number | null;
  rentsafeEvaluatedOn: string | null;
  rentsafeYearBuilt: number | null;
  notifiedAt: Date | null;
  duplicates: number;
}

export interface DetailRow extends FeedRow {
  listing: ListingColumnsRow & { rawText: string | null };
}

export interface SiblingRow {
  id: string;
  source: string;
  url: string;
  title: string;
  rentBase: string;
  totalMonthlyCost: string;
  lastSeenAt: Date;
  delistedAt: Date | null;
  score: number | null;
}

/**
 * Every listing column except `raw_text`.
 *
 * The body is the whole advertisement — a few KB each — and the feed at `minScore=0` is a few
 * thousand rows. Selecting the table wholesale there would move megabytes to render a page of
 * thirty titles. The detail query adds the column back for the one listing being read.
 */
const listingColumns = {
  id: listings.id,
  source: listings.source,
  sourceId: listings.sourceId,
  url: listings.url,
  fingerprint: listings.fingerprint,
  title: listings.title,
  rentBase: listings.rentBase,
  parkingIncluded: listings.parkingIncluded,
  parkingCost: listings.parkingCost,
  parkingAvailable: listings.parkingAvailable,
  utilitiesIncluded: listings.utilitiesIncluded,
  totalMonthlyCost: listings.totalMonthlyCost,
  beds: listings.beds,
  dens: listings.dens,
  baths: listings.baths,
  areaSqft: listings.areaSqft,
  hasLocker: listings.hasLocker,
  inSuiteLaundry: listings.inSuiteLaundry,
  address: listings.address,
  city: listings.city,
  lat: listings.lat,
  lng: listings.lng,
  postedAt: listings.postedAt,
  availableFrom: listings.availableFrom,
  buildingBuiltBefore2018: listings.buildingBuiltBefore2018,
  firstSeenAt: listings.firstSeenAt,
  lastSeenAt: listings.lastSeenAt,
  hydratedAt: listings.hydratedAt,
  delistedAt: listings.delistedAt,
  rentsafeMatch: listings.rentsafeMatch,
};

const feedColumns = {
  listing: listingColumns,
  score: matches.score,
  breakdown: matches.breakdown,
  firstScoredAt: matches.createdAt,
  stateStatus: listingStates.status,
  stateNote: listingStates.note,
  stateUpdatedAt: listingStates.updatedAt,
  rentsafeRsn: rentsafeBuildings.rsn,
  rentsafeScore: rentsafeBuildings.score,
  rentsafeEvaluatedOn: rentsafeBuildings.evaluatedOn,
  rentsafeYearBuilt: rentsafeBuildings.yearBuilt,
  notifiedAt: notifications.sentAt,
  /** Other advertisements of the same unit. `listings_fingerprint_idx` makes this an index probe. */
  duplicates: sql<number>`(select count(*)::int - 1 from ${listings} l2 where l2.fingerprint = ${listings.fingerprint})`,
};

/** One state row per (listing, profile), so this join cannot fan out. */
const stateJoin = (): SQL | undefined =>
  and(eq(listingStates.listingId, listings.id), eq(listingStates.profileId, matches.profileId));

/** `notifications` is unique on (profile, fingerprint), so neither can this one. */
const notificationJoin = (): SQL | undefined =>
  and(eq(notifications.profileId, matches.profileId), eq(notifications.fingerprint, listings.fingerprint));

function feedConditions(profileId: string, f: FeedFilter): SQL[] {
  const conditions: SQL[] = [eq(matches.profileId, profileId), gte(matches.score, f.minScore)];
  if (f.maxRent !== undefined) conditions.push(sql`${listings.totalMonthlyCost} <= ${f.maxRent}`);
  // A delisted unit is not worth anyone's attention by default, however well it scored.
  if (!f.includeDelisted) conditions.push(isNull(listings.delistedAt));
  if (!f.includeDismissed) conditions.push(sql`coalesce(${listingStates.status}, 'none') <> 'dismissed'`);
  if (f.status !== undefined) conditions.push(eq(listingStates.status, f.status));
  return conditions;
}

/**
 * Reads for the browser UI.
 *
 * Separate from `ListingsRepository`, which is "all database writes the pipeline performs" and
 * should stay that. Everything here is a read except `upsertState`, which records a person's
 * decision rather than the pipeline's.
 */
@Injectable()
export class ListingsViewRepository {
  constructor(@Inject('DATABASE') private readonly db: Database) {}

  /**
   * Every scored listing for a profile above a score, with what the card needs joined in.
   *
   * Ordered by score in SQL because that is the default view and `matches_profile_score_idx`
   * answers it directly; the service re-sorts in memory for the other orders. The template is
   * `ListingsRepository.findUnnotifiedMatches`, which is this join minus the decorations.
   */
  async findFeedRows(profileId: string, filter: FeedFilter): Promise<FeedRow[]> {
    return this.db
      .select(feedColumns)
      .from(matches)
      .innerJoin(listings, eq(listings.id, matches.listingId))
      .leftJoin(listingStates, stateJoin())
      .leftJoin(rentsafeBuildings, eq(rentsafeBuildings.rsn, listings.rentsafeRsn))
      .leftJoin(notifications, notificationJoin())
      .where(and(...feedConditions(profileId, filter)))
      .orderBy(desc(matches.score));
  }

  /** One listing with its body, whatever its state — a dismissed listing can still be opened. */
  async findMatchById(listingId: string, profileId: string): Promise<DetailRow | null> {
    const [row] = await this.db
      .select({ ...feedColumns, listing: { ...listingColumns, rawText: listings.rawText } })
      .from(matches)
      .innerJoin(listings, eq(listings.id, matches.listingId))
      .leftJoin(listingStates, stateJoin())
      .leftJoin(rentsafeBuildings, eq(rentsafeBuildings.rsn, listings.rentsafeRsn))
      .leftJoin(notifications, notificationJoin())
      .where(and(eq(listings.id, listingId), eq(matches.profileId, profileId)))
      .limit(1);
    return row ?? null;
  }

  async findRentSafe(rsn: string): Promise<RentSafeBuildingRow | null> {
    const [row] = await this.db.select().from(rentsafeBuildings).where(eq(rentsafeBuildings.rsn, rsn)).limit(1);
    return row ?? null;
  }

  /** The same unit on other portals, or re-posted on the same one. Newest sighting first. */
  async findSiblings(fingerprint: string, excludeListingId: string, profileId: string): Promise<SiblingRow[]> {
    return this.db
      .select({
        id: listings.id,
        source: listings.source,
        url: listings.url,
        title: listings.title,
        rentBase: listings.rentBase,
        totalMonthlyCost: listings.totalMonthlyCost,
        lastSeenAt: listings.lastSeenAt,
        delistedAt: listings.delistedAt,
        score: matches.score,
      })
      .from(listings)
      .leftJoin(matches, and(eq(matches.listingId, listings.id), eq(matches.profileId, profileId)))
      .where(and(eq(listings.fingerprint, fingerprint), ne(listings.id, excludeListingId)))
      .orderBy(desc(listings.lastSeenAt));
  }

  /** What the ad never stated and nobody has resolved — the "worth checking" line. */
  async findOpenReviews(listingId: string, profileId: string): Promise<Array<{ field: string; reason: string }>> {
    return this.db
      .select({ field: needsReview.field, reason: needsReview.reason })
      .from(needsReview)
      .where(
        and(eq(needsReview.listingId, listingId), eq(needsReview.profileId, profileId), isNull(needsReview.resolvedAt)),
      )
      .orderBy(needsReview.createdAt);
  }

  /** Header numbers in one pass over the profile's matches. */
  async summaryCounts(profileId: string, minScore: number): Promise<Summary['counts']> {
    const [row] = await this.db
      .select({
        scored: sql<number>`count(*)::int`,
        aboveMinScore: sql<number>`count(*) filter (where ${matches.score} >= ${minScore} and ${listings.delistedAt} is null)::int`,
        newSince24h: sql<number>`count(*) filter (where ${listings.firstSeenAt} >= now() - interval '24 hours')::int`,
        delisted: sql<number>`count(*) filter (where ${listings.delistedAt} is not null)::int`,
        favourites: sql<number>`count(*) filter (where ${listingStates.status} = 'favourite')::int`,
        contacted: sql<number>`count(*) filter (where ${listingStates.status} = 'contacted')::int`,
        dismissed: sql<number>`count(*) filter (where ${listingStates.status} = 'dismissed')::int`,
      })
      .from(matches)
      .innerJoin(listings, eq(listings.id, matches.listingId))
      .leftJoin(listingStates, stateJoin())
      .where(eq(matches.profileId, profileId));
    return (
      row ?? { scored: 0, aboveMinScore: 0, newSince24h: 0, delisted: 0, favourites: 0, contacted: 0, dismissed: 0 }
    );
  }

  /** Whether this profile ever scored the listing — the precondition for having a state about it. */
  async matchExists(listingId: string, profileId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.listingId, listingId), eq(matches.profileId, profileId)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Records a decision. Partial on purpose: a note written on a favourite must not reset the
   * favourite, so only the fields present in the patch are written on conflict.
   */
  async upsertState(listingId: string, profileId: string, patch: StateUpdate): Promise<ListingStateRow> {
    const [row] = await this.db
      .insert(listingStates)
      .values({ listingId, profileId, status: patch.status ?? 'none', note: patch.note ?? null })
      .onConflictDoUpdate({
        target: [listingStates.listingId, listingStates.profileId],
        set: {
          ...(patch.status !== undefined ? { status: sql`excluded.status` } : {}),
          ...(patch.note !== undefined ? { note: sql`excluded.note` } : {}),
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error(`upsert of listing_states(${listingId}, ${profileId}) returned no row`);
    return row;
  }
}
