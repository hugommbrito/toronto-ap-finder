import { doublePrecision, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { listings } from './listings';
import { profiles } from './profiles';

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    score: doublePrecision('score').notNull(),
    /** Per-component contribution. Mandatory: this is the only instrument for calibrating weights. */
    breakdown: jsonb('breakdown').$type<Record<string, number>>().notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    listingProfileUnique: unique('matches_listing_profile_key').on(t.listingId, t.profileId),
    scoreIdx: index('matches_profile_score_idx').on(t.profileId, t.score),
  }),
);

/**
 * One notification per physical unit per profile, enforced by the database rather than
 * by application logic. Keyed on fingerprint (not listing id) so the same unit found on
 * Kijiji and Zumper notifies once, and so a restart cannot re-notify.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    score: doublePrecision('score').notNull(),
    /** One id per recipient, for tracing a specific message back to a send. */
    telegramMessageIds: text('telegram_message_ids').array(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    profileFingerprintUnique: unique('notifications_profile_fingerprint_key').on(t.profileId, t.fingerprint),
  }),
);

export type MatchRow = typeof matches.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
