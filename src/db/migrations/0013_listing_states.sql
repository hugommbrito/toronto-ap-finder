-- What a person decided about a listing, per profile — kept, dropped, already contacted — and a note.
--
-- Not on `matches`: a match is what the scorer computed and is rewritten wholesale on every
-- re-score (`upsertMatch` replaces score and breakdown), so a human column there would be one
-- `cycle:stored` away from being clobbered.
--
-- Keyed on (listing, profile), not on fingerprint. The UI lists advertisements, and a note like
-- "landlord answered on Kijiji, not Zumper" belongs to one advertisement. The cost is deliberate
-- and recorded here: the FK to `listings` means `TRUNCATE listings … CASCADE` in
-- reset-operational.ts empties this table too, so it is classified OPERATIONAL. If these
-- decisions must ever survive a reset, re-key on (profile_id, fingerprint) with no FK, as
-- `notifications` does.
CREATE TABLE IF NOT EXISTS "listing_states" (
  "listing_id" uuid NOT NULL REFERENCES "listings"("id") ON DELETE CASCADE,
  "profile_id" text NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "status"     text DEFAULT 'none' NOT NULL,
  "note"       text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "listing_states_pkey" PRIMARY KEY ("listing_id", "profile_id"),
  CONSTRAINT "listing_states_status_check"
    CHECK ("status" IN ('none', 'favourite', 'dismissed', 'contacted'))
);

-- The feed's default filter is "not dismissed" and the header counts favourites; both are by profile.
CREATE INDEX IF NOT EXISTS "listing_states_profile_status_idx" ON "listing_states" ("profile_id", "status");
