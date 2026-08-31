-- Regional expansion: Mississauga (Peel) and Cambridge (Waterloo).
--
-- Two unrelated needs, one migration because both are prerequisites of the same change.
--
-- 1. `daycares` gains provenance. Only the City of Toronto publishes licensed capacity per
--    age group, so a Peel or Waterloo row carries zeros that mean "unpublished" rather than
--    "licensed for nobody". `capacity_known` is what keeps those apart; without it the
--    toddler filter would silently hide every centre outside Toronto.
-- 2. `cycle_runs` gains the search target, so the per-region rotation has somewhere to read
--    "which region is least recently visited" from.
--
-- Both columns are defaulted so existing rows keep their present meaning: everything already
-- in `daycares` is Toronto data with real capacity, and every recorded cycle ran against the
-- single Toronto target.

ALTER TABLE "daycares" ADD COLUMN IF NOT EXISTS "region" text NOT NULL DEFAULT 'toronto';
ALTER TABLE "daycares" ADD COLUMN IF NOT EXISTS "capacity_known" boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "daycares_region_idx" ON "daycares" ("region");

ALTER TABLE "cycle_runs" ADD COLUMN IF NOT EXISTS "target" text;

CREATE INDEX IF NOT EXISTS "cycle_runs_target_idx" ON "cycle_runs" ("source", "target", "started_at");

-- The primary key changes meaning, not shape: ids are now namespaced (`toronto:1013`).
-- Existing rows are rewritten so the seeder's upsert matches them instead of inserting a
-- duplicate under the new scheme. Guarded so a re-run is a no-op.
UPDATE "daycares" SET "id" = 'toronto:' || "id" WHERE "id" NOT LIKE '%:%';
