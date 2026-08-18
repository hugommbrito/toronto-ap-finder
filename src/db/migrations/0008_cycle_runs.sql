-- One row per cycle, so "did it work?" survives a restart.
--
-- The last report used to live in a single field on PipelineService: one slot shared by two
-- cycles, so the building cycle overwrote the listings one, and in memory, so a redeploy erased
-- the history exactly when something had gone wrong enough to cause one. This is also what the
-- operations route reads.
CREATE TABLE IF NOT EXISTS "cycle_runs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind"        text NOT NULL,
  "source"      text,
  "started_at"  timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone NOT NULL,
  "ok"          boolean NOT NULL,
  "report"      jsonb NOT NULL,
  "errors"      text[] DEFAULT '{}' NOT NULL
);

-- Both access patterns are "recently, and optionally for one source".
CREATE INDEX IF NOT EXISTS "cycle_runs_started_idx" ON "cycle_runs" ("started_at");
CREATE INDEX IF NOT EXISTS "cycle_runs_source_idx" ON "cycle_runs" ("source","started_at");
