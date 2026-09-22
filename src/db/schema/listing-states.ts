import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ListingStatus } from '@/ui-api/api-types';
import { listings } from './listings';
import { profiles } from './profiles';

/**
 * What a person decided about a listing, per profile — kept, dropped, already contacted — and a
 * note. The only table a human writes to from the UI.
 *
 * Not columns on `matches`: a match is what the scorer computed, and `upsertMatch` rewrites it
 * wholesale on every re-score, so a human column there would be one `cycle:stored` away from
 * being clobbered.
 *
 * Keyed on (listing, profile) rather than on fingerprint, because a note like "landlord answered
 * on Kijiji, not on Zumper" belongs to one advertisement. The cost is the FK: `TRUNCATE listings
 * … CASCADE` in reset-operational.ts empties this table too, so it is classified OPERATIONAL
 * there. See the migration for the alternative if that ever has to change.
 */
export const listingStates = pgTable(
  'listing_states',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    status: text('status').$type<ListingStatus>().notNull().default('none'),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'listing_states_pkey', columns: [t.listingId, t.profileId] }),
    /** The default feed hides dismissed rows and the header counts favourites, both per profile. */
    profileStatusIdx: index('listing_states_profile_status_idx').on(t.profileId, t.status),
  }),
);

export type ListingStateRow = typeof listingStates.$inferSelect;
