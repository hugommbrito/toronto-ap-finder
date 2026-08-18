-- What each source does when we knock, measured rather than assumed.
--
-- The primary key is composite on purpose. Anti-bot verdicts are a property of the pair
-- (source, vantage point), because reputation is kept by IP range: keyed on source_id alone,
-- a probe run from a residential connection would overwrite the deployment's verdict with a
-- friendlier one, inverting the one fact this table exists to record.
CREATE TABLE IF NOT EXISTS "source_policy" (
  "source_id"               text NOT NULL,
  "probed_from"             text NOT NULL,
  "probed_at"               timestamp with time zone NOT NULL,
  "target_url"              text NOT NULL,
  "http_status"             integer NOT NULL,
  "response_time_ms"        integer NOT NULL,
  "antibot_vendor"          text NOT NULL,
  "content_in_initial_html" boolean NOT NULL,
  "requires_js"             boolean NOT NULL,
  "robots_txt_verdict"      text NOT NULL,
  "verdict"                 text NOT NULL,
  "previous_verdict"        text,
  "verdict_changed_at"      timestamp with time zone,
  "json_endpoint_hint"      text,
  "notes"                   text,
  "raw_headers"             jsonb NOT NULL,
  CONSTRAINT "source_policy_pkey" PRIMARY KEY ("source_id","probed_from")
);
