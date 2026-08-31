import { boolean, doublePrecision, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Licensed child care centres, City of Toronto Open Data (CKAN).
 * Capacity columns are per age group and are the reason this dataset beats a generic
 * points-of-interest lookup: a centre with 60 preschool spaces and zero toddler spaces
 * is worthless to a profile whose child is a toddler.
 */
export const daycares = pgTable(
  'daycares',
  {
    /**
     * Namespaced per region: `toronto:1013`, `peel:4471`, `waterloo:882`.
     *
     * The bare upstream id would collide. Toronto's LOC_ID values are small integers and so
     * are Peel's LM_ID and Waterloo's FacilityMasterID, so `"1013"` means three different
     * centres — and the seed upserts on this key, which would have silently overwritten one
     * region's centre with another's.
     */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Which dataset this row came from. Matches CoverageRegion.key in geo/coverage.ts. */
    region: text('region').notNull().default('toronto'),
    /**
     * Whether the capacity columns below mean anything.
     *
     * Only the City of Toronto publishes licensed capacity per age group. For Peel and
     * Waterloo rows every capacity column is 0, and this flag is what stops that being read
     * as "licensed for nobody" — the seeder's `int()` coerces an absent field to 0, so the
     * value alone cannot carry the difference. Consulted via geo/coverage.ts rather than
     * directly: coverage is a property of the region, and this is the per-row record of it.
     */
    capacityKnown: boolean('capacity_known').notNull().default(true),
    auspice: text('auspice'),
    address: text('address'),
    postalCode: text('postal_code'),
    ward: text('ward'),
    phone: text('phone'),
    buildingType: text('building_type'),
    buildingName: text('building_name'),

    /** IGSPACE — infant, 0-18 months. */
    infantSpace: integer('infant_space').notNull().default(0),
    /** TGSPACE — toddler, 18-30 months. */
    toddlerSpace: integer('toddler_space').notNull().default(0),
    /** PGSPACE — preschool. */
    preschoolSpace: integer('preschool_space').notNull().default(0),
    /** KGSPACE — kindergarten. */
    kindergartenSpace: integer('kindergarten_space').notNull().default(0),
    /** SGSPACE — school age. */
    schoolageSpace: integer('schoolage_space').notNull().default(0),
    totalSpace: integer('total_space').notNull().default(0),

    /** Accepts municipal fee subsidy. */
    subsidy: boolean('subsidy').notNull().default(false),
    /** Canada-Wide Early Learning and Child Care ($10/day). Worth CAD 800-1200/month. */
    cwelcc: boolean('cwelcc').notNull().default(false),

    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),

    sourceRunDate: text('source_run_date'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    toddlerIdx: index('daycares_toddler_idx').on(t.toddlerSpace),
    cwelccIdx: index('daycares_cwelcc_idx').on(t.cwelcc),
    regionIdx: index('daycares_region_idx').on(t.region),
  }),
);

export type TransitStatus = 'operational' | 'future';
export type TransitMode = 'subway' | 'light_rail';

/**
 * Subway and LRT stations. Operational and future are stored in one table but scored by
 * different components with very different weights — a 2031 line must never be able to
 * compensate for the absence of a line that exists today.
 */
export const transitStations = pgTable(
  'transit_stations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** e.g. 'Line 5 Eglinton'. */
    line: text('line').notNull(),
    status: text('status').$type<TransitStatus>().notNull(),
    mode: text('mode').$type<TransitMode>().notNull(),
    /** Only meaningful for status = 'future'. */
    expectedYear: integer('expected_year'),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    /** 'overpass' | 'manual' — future stations cannot come from OSM operational tags. */
    source: text('source').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('transit_stations_status_idx').on(t.status),
    lineIdx: index('transit_stations_line_idx').on(t.line),
  }),
);

export type DaycareRow = typeof daycares.$inferSelect;
export type TransitStationRow = typeof transitStations.$inferSelect;
