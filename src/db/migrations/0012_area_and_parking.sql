-- Unit area, and parking that exists on unstated terms.
--
-- `area_sqft` is the advertised floor area. All three sources publish it and none of it was
-- read: Kijiji has an `areainfeet` attribute, Zumper a `square_feet` field per floorplan, and
-- ad prose says "1,200 Sq. Ft.". Null means the ad never said — a blank is never stored as 0,
-- the same discipline as the tri-state booleans.
--
-- `parking_available` is the third state the existing pair could not express. `parking_included`
-- is a promise and `parking_cost` a price; CAPREIT's `Parking*` amenity and prose like "parking
-- available" assert only that parking exists at the building, on terms the ad does not state.
-- Mapping that to `included` would put a false promise in the notification, and leaving it null kept
-- every CAPREIT building in "ad does not mention parking" review. True satisfies a parking
-- requirement the way a priced spot does; the notification says the cost is unstated.
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "area_sqft" integer;
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "parking_available" boolean;

-- What the verifier read about area and parking, alongside its layout verdict — same audit
-- rationale as the rest of the table: a correction that cannot be checked against the ad
-- afterwards is indistinguishable from a bug.
ALTER TABLE "listing_verifications" ADD COLUMN IF NOT EXISTS "area_sqft" integer;
ALTER TABLE "listing_verifications" ADD COLUMN IF NOT EXISTS "parking" text;
