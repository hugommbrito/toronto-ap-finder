import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ListingSource } from '@/listings/listing.types';

export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<ListingSource>().notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    fingerprint: text('fingerprint').notNull(),

    title: text('title').notNull(),
    /** Null until the hydration stage fetches the detail page. */
    rawText: text('raw_text'),

    rentBase: numeric('rent_base', { precision: 10, scale: 2 }).notNull(),
    parkingIncluded: boolean('parking_included'),
    parkingCost: numeric('parking_cost', { precision: 10, scale: 2 }),
    /**
     * Parking exists at the building on terms the ad does not state — CAPREIT's `Parking*`,
     * prose like "parking available". Included and priced are the other two columns; this one
     * is only ever the weaker claim, never set when either of those is known.
     */
    parkingAvailable: boolean('parking_available'),
    utilitiesIncluded: text('utilities_included').array().notNull().default([]),
    totalMonthlyCost: numeric('total_monthly_cost', { precision: 10, scale: 2 }).notNull(),

    beds: integer('beds'),
    dens: integer('dens').notNull().default(0),
    baths: numeric('baths', { precision: 3, scale: 1 }),
    /** Advertised floor area in square feet; null when the ad never said, never 0. */
    areaSqft: integer('area_sqft'),

    hasLocker: boolean('has_locker'),
    inSuiteLaundry: boolean('in_suite_laundry'),

    address: text('address'),
    city: text('city'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),

    /** When the source says the ad went live — the input for measuring real turnover. */
    postedAt: timestamp('posted_at', { withTimezone: true }),
    availableFrom: date('available_from'),
    buildingBuiltBefore2018: boolean('building_built_before_2018'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    hydratedAt: timestamp('hydrated_at', { withTimezone: true }),
    /**
     * Set when a re-check finds the ad is no longer ACTIVE at the source — confirmed, not
     * presumed from absence: a listing leaves the first pages within days while remaining
     * perfectly available. Rows are never deleted; the history is what makes time-on-market
     * and re-pricing measurable.
     */
    delistedAt: timestamp('delisted_at', { withTimezone: true }),
    /** How many re-checks have failed to confirm the ad since it was last seen listed. */
    missedSweeps: integer('missed_sweeps').notNull().default(0),

    /**
     * Which City-inspected building this listing is in, and how the two were matched.
     *
     * Null is the common case rather than the exception: RentSafeTO covers buildings of three or
     * more storeys and ten or more units, excluding condos, so 90% of purpose-built units match
     * one and roughly 15% of condo listings do. `rentsafe_match` records which tier found it,
     * which with that spread is the column you end up querying.
     */
    rentsafeRsn: text('rentsafe_rsn'),
    rentsafeMatch: text('rentsafe_match'),
  },
  (t) => ({
    /** Stops the same advertisement being reprocessed, including top-ads repeated across pages. */
    sourceUnique: unique('listings_source_source_id_key').on(t.source, t.sourceId),
    /** Groups the same physical unit across sources. */
    fingerprintIdx: index('listings_fingerprint_idx').on(t.fingerprint),
    lastSeenIdx: index('listings_last_seen_idx').on(t.lastSeenAt),
  }),
);

export type ListingRow = typeof listings.$inferSelect;
export type NewListingRow = typeof listings.$inferInsert;
