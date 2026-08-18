import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { HardFilters, NotifySettings, SoftPreferences } from '@/profiles/profile.schema';

/**
 * Every search criterion lives here, in jsonb. Adding a tenant is one INSERT.
 * If anything in src/ ever needs to branch on a profile id, this table has failed.
 */
export const profiles = pgTable('profiles', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  active: boolean('active').notNull().default(true),
  hard: jsonb('hard').$type<HardFilters>().notNull(),
  soft: jsonb('soft').$type<SoftPreferences>().notNull(),
  notify: jsonb('notify').$type<NotifySettings>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProfileRow = typeof profiles.$inferSelect;
export type NewProfileRow = typeof profiles.$inferInsert;
