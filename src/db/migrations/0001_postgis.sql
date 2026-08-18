-- PostGIS support — optional by design.
--
-- Nothing in src/ reads these columns: scoring runs in TypeScript over an in-memory snapshot
-- so that every component stays unit-testable without a database. They exist for the other
-- job — ad-hoc calibration queries like "how many listings had a toddler place within 800 m
-- and still got rejected?".
--
-- Because nothing depends on it, a deployment must not fail for want of it. Railway's default
-- Postgres ships without PostGIS, and making the whole migration chain die there would trade a
-- convenience for an outage. So: install it where it exists, skip it where it doesn't, and say
-- which happened. Every statement is idempotent, so re-running is harmless.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    RAISE NOTICE 'PostGIS unavailable on this server — skipping geography columns. The application does not use them; ad-hoc spatial queries will not be possible.';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS postgis;

  ALTER TABLE "listings"
    ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
    GENERATED ALWAYS AS (
      CASE WHEN "lat" IS NOT NULL AND "lng" IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography
      END
    ) STORED;

  ALTER TABLE "daycares"
    ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
    GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography) STORED;

  ALTER TABLE "transit_stations"
    ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
    GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography) STORED;

  CREATE INDEX IF NOT EXISTS "listings_geog_idx" ON "listings" USING GIST ("geog");
  CREATE INDEX IF NOT EXISTS "daycares_geog_idx" ON "daycares" USING GIST ("geog");
  CREATE INDEX IF NOT EXISTS "transit_stations_geog_idx" ON "transit_stations" USING GIST ("geog");
END $$;
