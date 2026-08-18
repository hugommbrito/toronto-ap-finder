-- Buildings, for sources that advertise a building rather than a unit.
--
-- The point of this table is the watermark, not the inventory: opening every Zumper building
-- on every cycle would be ~229 requests, and the cheap pre-filter rules out almost nothing
-- (87 of 90 buildings pass it, because a building's minimum price is always its cheapest
-- studio). Comparing the source's own `modified_on` against the value we held when we last
-- opened the building is what keeps a full-city sweep to a handful of requests.
CREATE TABLE IF NOT EXISTS "source_buildings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "source_id" text NOT NULL,
  "url" text NOT NULL,
  "name" text,
  "address" text,
  "lat" double precision,
  "lng" double precision,
  "floorplan_count" integer,
  "modified_on" timestamp with time zone,
  "expanded_modified_on" timestamp with time zone,
  "last_expanded_at" timestamp with time zone,
  "last_unit_count" integer,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_buildings_source_key" UNIQUE("source","source_id")
);

-- The expansion queue is read as "due first, then most floorplans": ordering by the
-- watermark is the whole access pattern.
CREATE INDEX IF NOT EXISTS "source_buildings_due_idx"
  ON "source_buildings" ("source", "expanded_modified_on" NULLS FIRST);
