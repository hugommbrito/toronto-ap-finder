-- Several recipients per profile.
--
-- One notification per unit per profile is unchanged — the unique index stays on
-- (profile_id, fingerprint). What changes is that the same decision fans out to several
-- phones, so a single message id is no longer enough to trace a send.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "telegram_message_ids" text[];

UPDATE "notifications"
SET "telegram_message_ids" = ARRAY["telegram_message_id"]
WHERE "telegram_message_id" IS NOT NULL AND "telegram_message_ids" IS NULL;

ALTER TABLE "notifications" DROP COLUMN IF EXISTS "telegram_message_id";

-- Existing profiles carry notify.telegramChatId; the schema now requires telegramChatIds.
-- Without this, an already-seeded profile fails Zod validation on the next boot.
UPDATE "profiles"
SET "notify" = ("notify" - 'telegramChatId')
             || jsonb_build_object('telegramChatIds', jsonb_build_array("notify" ->> 'telegramChatId'))
WHERE "notify" ? 'telegramChatId';
