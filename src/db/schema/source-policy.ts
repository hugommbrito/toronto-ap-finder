import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * What each source does when we knock, measured rather than assumed.
 *
 * The primary key is **composite**, and that is the load-bearing decision here. Anti-bot systems
 * keep reputation by IP range, so the answer to "will this source talk to us?" is a property of
 * the *pair* (source, where we asked from) and of nothing else. Keyed on `source_id` alone, a
 * probe run from a laptop on a residential connection would overwrite the deployment's verdict
 * with a friendlier one — inverting the single fact this table exists to record.
 *
 * Advisory by design: nothing in the pipeline reads a verdict to decide whether to fetch. A
 * transient 503 must not be able to silence the monitor for a week, and `CYCLE_ENABLED=false`
 * remains the switch. A `red` verdict on a source we already run is an operator's decision, not
 * an automatic stop.
 */
export const sourcePolicy = pgTable(
  'source_policy',
  {
    sourceId: text('source_id').notNull(),
    /** Where we asked from: 'railway:production:us-east4', 'local:hostname'. */
    probedFrom: text('probed_from').notNull(),
    probedAt: timestamp('probed_at', { withTimezone: true }).notNull(),
    /** The URL the fetcher actually requests — not the site's front page. */
    targetUrl: text('target_url').notNull(),
    httpStatus: integer('http_status').notNull(),
    responseTimeMs: integer('response_time_ms').notNull(),
    /** cloudflare | akamai | datadome | kasada | none | unknown */
    antibotVendor: text('antibot_vendor').notNull(),
    /** Did a known listing marker appear in the raw HTML, with no JavaScript run? */
    contentInInitialHtml: boolean('content_in_initial_html').notNull(),
    requiresJs: boolean('requires_js').notNull(),
    /** allow | disallow | absent */
    robotsTxtVerdict: text('robots_txt_verdict').notNull(),
    /** green | yellow | red */
    verdict: text('verdict').notNull(),
    /** So a degradation can be reported once, on the transition, rather than every week. */
    previousVerdict: text('previous_verdict'),
    verdictChangedAt: timestamp('verdict_changed_at', { withTimezone: true }),
    /**
     * For a `yellow`: the JSON endpoint found while looking, if any. Recorded because the honest
     * next step for "content needs JavaScript" is to look for published JSON, not to reach for a
     * headless browser.
     */
    jsonEndpointHint: text('json_endpoint_hint'),
    notes: text('notes'),
    /**
     * Cookie and header **names**, never values. Storing a `cf_clearance` would be keeping a
     * challenge token, which is the first step of working around a challenge rather than
     * respecting it.
     */
    rawHeaders: jsonb('raw_headers').$type<Record<string, string>>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'source_policy_pkey', columns: [t.sourceId, t.probedFrom] }),
  }),
);

export type SourcePolicyRow = typeof sourcePolicy.$inferSelect;
