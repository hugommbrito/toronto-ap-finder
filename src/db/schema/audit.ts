import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { listings } from './listings';
import { profiles } from './profiles';

/**
 * Why a listing was eliminated. Not optional: in the first weeks this is the primary
 * instrument for discovering that a hard filter is strangling the funnel. Rows are
 * written even for ads rejected during triage, before a listing row exists — hence the
 * nullable listing_id alongside the raw source coordinates.
 */
export const rejectionLog = pgTable(
  'rejection_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url'),
    /** Stable machine-readable code, e.g. 'bedroom_rule' | 'rent_ceiling' | 'no_parking'. */
    reason: text('reason').notNull(),
    /** Observed vs. required, so a near-miss digest can be built without refetching. */
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reasonIdx: index('rejection_log_profile_reason_idx').on(t.profileId, t.reason),
    createdIdx: index('rejection_log_created_idx').on(t.createdAt),
  }),
);

/**
 * A null in a hard filter sends the ad here, not to the bin. Surfaced in the weekly digest.
 */
export const needsReview = pgTable(
  'needs_review',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** Which field was indeterminate, e.g. 'hasLocker' | 'parkingIncluded'. */
    field: text('field').notNull(),
    reason: text('reason').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    openIdx: index('needs_review_open_idx').on(t.profileId, t.resolvedAt),
  }),
);

/**
 * Nominatim is a fallback (Kijiji supplies coordinates directly), but it is rate-limited
 * to 1 req/s and the same building reappears constantly, so the cache is permanent.
 */
export const geocodeCache = pgTable('geocode_cache', {
  /** sha256 of the normalised address; the lookup key. */
  queryHash: text('query_hash').primaryKey(),
  rawQuery: text('raw_query').notNull(),
  lat: text('lat'),
  lng: text('lng'),
  provider: text('provider').notNull(),
  /** True when the provider answered but found nothing — stops us asking again. */
  miss: text('miss'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RejectionRow = typeof rejectionLog.$inferSelect;
export type NeedsReviewRow = typeof needsReview.$inferSelect;
