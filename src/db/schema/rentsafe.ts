import { date, doublePrecision, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Buildings the City of Toronto inspects and scores, under RentSafeTO.
 *
 * Named for the programme rather than called `buildings`, because `source_buildings` already
 * exists and means something else entirely — a building *advertised* by a source, carrying the
 * crawl watermark. Two tables called `buildings` and `source_buildings`, meaning "inspected by
 * the City" and "advertised by Zumper", could not be told apart on sight.
 *
 * One row per building, not per evaluation. The published data is one row per *evaluation*:
 * 6,090 rows over 3,585 buildings, 2,504 of which have been evaluated more than once. Keeping
 * them all would make "this building's score" a question with several answers.
 *
 * Coverage is the thing to remember when reading a score from here. RentSafeTO evaluates
 * buildings of three or more storeys **and** ten or more units, and excludes condominiums,
 * townhouses and units inside private houses. The data confirms its own rule — the minimum
 * `CONFIRMED STOREYS` is 3 and the minimum `CONFIRMED UNITS` is 10 — and the consequence is
 * measured: 90% of CAPREIT's purpose-built units match a building here, against roughly 15% of
 * Kijiji's and Zumper's, which are mostly condo.
 */
export const rentsafeBuildings = pgTable(
  'rentsafe_buildings',
  {
    /** The City's Registration Serial Number, following the daycares.id = LOC_ID precedent. */
    rsn: text('rsn').primaryKey(),
    siteAddress: text('site_address').notNull(),
    /** normalizeAddress() of the site address, so the join is an index lookup. */
    normalizedAddress: text('normalized_address').notNull(),
    score: integer('score').notNull(),
    evaluatedOn: date('evaluated_on'),
    /**
     * Feeds the `rentControlled` component, which has existed since it was written and has been
     * null for every listing ever scored. Ontario's cut-off is 15 November 2018, and this column
     * carries only a year — so 2018 itself is left undecided rather than guessed.
     */
    yearBuilt: integer('year_built'),
    confirmedStoreys: integer('confirmed_storeys'),
    confirmedUnits: integer('confirmed_units'),
    propertyType: text('property_type'),
    ward: text('ward'),
    wardName: text('ward_name'),
    /** 214 of 6,090 rows carry no coordinate, so the geographic tier is a fallback, not the path. */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addressIdx: index('rentsafe_buildings_address_idx').on(t.normalizedAddress),
  }),
);

export type RentSafeBuildingRow = typeof rentsafeBuildings.$inferSelect;
