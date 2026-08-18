import { boolean, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { listings } from './listings';

export type VerificationConfidence = 'high' | 'medium' | 'low';

/**
 * What a model read in the advertisement text, versus what the source's structured fields
 * claimed.
 *
 * Recorded for every listing that reaches the verification stage, whether or not the verdict
 * changed anything — an unaudited correction is indistinguishable from a bug, and the value
 * of this stage is entirely in being able to check it against the ad afterwards.
 */
export const listingVerifications = pgTable(
  'listing_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),

    /** Bedrooms in the unit actually for rent, as the prose describes it. */
    bedrooms: integer('bedrooms'),
    dens: integer('dens'),
    /** False for a room, a shared space, or a bed in someone else's home. */
    isEntireUnit: boolean('is_entire_unit'),
    /** True when the unit is one part of a house split among separate households. */
    isSplitDwelling: boolean('is_split_dwelling'),
    confidence: text('confidence').$type<VerificationConfidence>(),
    /** The phrase the verdict rests on — the whole point of the audit trail. */
    evidence: text('evidence'),
    notes: text('notes'),

    /** Whether the pipeline acted on this verdict, rather than only recording it. */
    applied: boolean('applied').notNull().default(false),
    /** Set when the call itself failed; the pipeline then fails open. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One verdict per listing: the ad text does not change, so re-reading it is pure cost.
    listingUnique: unique('listing_verifications_listing_key').on(t.listingId),
  }),
);

export type ListingVerificationRow = typeof listingVerifications.$inferSelect;
