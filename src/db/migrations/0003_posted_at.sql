-- When the source says the ad went live.
--
-- Kept separate from first_seen_at, which only records when this monitor noticed it. The
-- difference is what makes turnover measurable: "how many genuinely new listings appear per
-- day" is the number that should size the cron interval, and until now it was an estimate.
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "posted_at" timestamp with time zone;
