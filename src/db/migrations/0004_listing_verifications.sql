-- Audit trail for model-read listing verdicts.
--
-- Every listing that reaches the verification stage gets a row, whether or not the verdict
-- changed anything. A correction nobody can check against the original advertisement is
-- indistinguishable from a bug, and checking it is the entire value of this stage.
CREATE TABLE IF NOT EXISTS "listing_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "listing_id" uuid NOT NULL REFERENCES "listings"("id") ON DELETE CASCADE,
  "model" text NOT NULL,
  "bedrooms" integer,
  "dens" integer,
  "is_entire_unit" boolean,
  "confidence" text,
  "evidence" text,
  "notes" text,
  "applied" boolean NOT NULL DEFAULT false,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "listing_verifications_listing_key" UNIQUE ("listing_id")
);
