import { doublePrecision, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Buildings advertised by sources that list a building rather than a unit.
 *
 * This table exists for one reason: to make sweeping a whole city affordable. Zumper offers
 * 229 buildings in Toronto and the cheap pre-filter is useless — 87 of 90 pass it, because a
 * building's minimum price is always its cheapest studio. Opening every building on every
 * cycle would be ~229 requests.
 *
 * `modified_on` is the way out. The search page gives it away for free, and a building whose
 * value has not advanced since we last opened it cannot be hiding a new floorplan. So the
 * expensive request is spent only where something actually changed.
 */
export const sourceBuildings = pgTable(
  'source_buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    name: text('name'),
    address: text('address'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    floorplanCount: integer('floorplan_count'),

    /** The source's own last-changed marker, as read from the search page. */
    modifiedOn: timestamp('modified_on', { withTimezone: true }),
    /**
     * The `modified_on` this building carried when we last opened it. Expansion is due when
     * this is null, or when the source's marker has moved past it.
     */
    expandedModifiedOn: timestamp('expanded_modified_on', { withTimezone: true }),
    lastExpandedAt: timestamp('last_expanded_at', { withTimezone: true }),
    /** How many units the last expansion produced — the yield, for auditing the cost. */
    lastUnitCount: integer('last_unit_count'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceUnique: unique('source_buildings_source_key').on(t.source, t.sourceId),
  }),
);

export type SourceBuildingRow = typeof sourceBuildings.$inferSelect;
