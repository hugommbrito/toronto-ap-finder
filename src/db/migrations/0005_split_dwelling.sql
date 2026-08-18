-- Whether the verified unit is one part of a house split among separate households.
ALTER TABLE "listing_verifications" ADD COLUMN IF NOT EXISTS "is_split_dwelling" boolean;

-- Existing profiles predate the setting; default them to permissive so a re-seed, not a
-- migration, is what narrows anyone's search.
UPDATE "profiles"
SET "hard" = "hard" || jsonb_build_object('allowSplitDwelling', true)
WHERE NOT ("hard" ? 'allowSplitDwelling');
