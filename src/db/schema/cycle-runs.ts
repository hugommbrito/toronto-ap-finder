import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per cycle, so "did it work?" survives a restart.
 *
 * `PipelineService` kept the last report in a single field, which had two problems. It held one
 * slot for two cycles, so the building cycle at :10 overwrote the Kijiji report from :00 and
 * /health's numbers meant whichever ran last. And it was memory, so a Railway redeploy — which
 * happens on every push, and again on each of five restart attempts — erased the history exactly
 * when something had gone wrong enough to cause one.
 *
 * Rows are never deleted, in the same spirit as `listings`: the history is what makes "how often
 * does Kijiji actually refuse us?" a question with an answer.
 */
export const cycleRuns = pgTable(
  'cycle_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** listings | buildings | stored */
    kind: text('kind').notNull(),
    /** Null for a stored re-scoring run, which touches no source at all. */
    source: text('source'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    /** No errors. Kept as its own column so the common query is not a jsonb dig. */
    ok: boolean('ok').notNull(),
    /** The whole CycleReport, so a counter added later is still readable in old rows. */
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    errors: text('errors').array().notNull().default([]),
  },
  (t) => ({
    startedIdx: index('cycle_runs_started_idx').on(t.startedAt),
    sourceIdx: index('cycle_runs_source_idx').on(t.source, t.startedAt),
  }),
);

export type CycleRunRow = typeof cycleRuns.$inferSelect;
