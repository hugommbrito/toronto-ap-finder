-- Buildings the City of Toronto inspects and scores, under RentSafeTO.
--
-- Not called `buildings`: source_buildings already exists and means a building *advertised* by a
-- source, carrying the crawl watermark. The two concepts would be indistinguishable by name.
--
-- One row per building rather than per evaluation. The published data is one row per evaluation —
-- 6,090 rows over 3,585 buildings — so keeping them all would make "this building's score" a
-- question with several answers.
CREATE TABLE IF NOT EXISTS "rentsafe_buildings" (
  "rsn"                text PRIMARY KEY NOT NULL,
  "site_address"       text NOT NULL,
  "normalized_address" text NOT NULL,
  "score"              integer NOT NULL,
  "evaluated_on"       date,
  "year_built"         integer,
  "confirmed_storeys"  integer,
  "confirmed_units"    integer,
  "property_type"      text,
  "ward"               text,
  "ward_name"          text,
  "lat"                double precision,
  "lng"                double precision,
  "updated_at"         timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rentsafe_buildings_address_idx" ON "rentsafe_buildings" ("normalized_address");

-- Which inspected building a listing is in, and how it was matched. With a match rate that runs
-- from 90% on purpose-built to 15% on condo, "how" is the column you actually end up querying.
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "rentsafe_rsn" text REFERENCES "rentsafe_buildings"("rsn") ON DELETE SET NULL;
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "rentsafe_match" text;

-- The weight the score carries. Re-seeding deliberately never overwrites `soft`, so the seed
-- alone cannot reach a profile that already exists; this is the convention 0002 and 0005 set,
-- where the data change travels with the schema change.
--
-- WHERE NOT (... ? ...) means hand tuning survives, and it is a no-op on a fresh database, which
-- gets the weight from buildSisterProfile instead.
UPDATE "profiles"
SET "soft" = jsonb_set("soft", '{weights,buildingScore}', '15'::jsonb, true)
WHERE NOT ("soft" -> 'weights' ? 'buildingScore');
