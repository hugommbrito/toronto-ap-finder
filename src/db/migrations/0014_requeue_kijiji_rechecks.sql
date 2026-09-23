-- Put retired Kijiji re-checks back in the queue, now that a removed ad can be recognised.
--
-- Kijiji does not answer a removed ad with a 404. It redirects to the category's generic search
-- page with the ad's id appended as `adRemoved=<id>`, HTTP 200. The re-check read only the body,
-- found no listing in it, counted that against `missed_sweeps`, and after three such failures
-- retired the ad from re-checking — flagged for review, never delisted. So every removed Kijiji ad
-- the re-check ever reached is sitting at missed_sweeps >= 3, still "active", still on the list
-- and the map. The adapter now reads the redirect; this gives those rows another turn. An ad that
-- is genuinely unreadable retires again after three attempts, exactly as before.
UPDATE "listings"
SET "missed_sweeps" = 0
WHERE "source" = 'kijiji' AND "delisted_at" IS NULL AND "missed_sweeps" >= 3;

-- The review rows those retirements wrote say the ad "could not be re-checked", which was the
-- wrong reading of the same response. Resolved rather than deleted: the row is the record that it
-- happened. One for an ad that is still unreadable will be written again when it retires again.
UPDATE "needs_review"
SET "resolved_at" = now()
WHERE "field" = 'status'
  AND "reason" LIKE 'could not be re-checked %'
  AND "resolved_at" IS NULL
  AND "listing_id" IN (SELECT "id" FROM "listings" WHERE "source" = 'kijiji');
