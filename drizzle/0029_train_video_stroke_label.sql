ALTER TABLE "train_video" ADD COLUMN IF NOT EXISTS "strokeLabel" text;

-- Backfill admin label from strokeName when it ends with " · Level"
UPDATE "train_video"
SET "strokeLabel" = regexp_replace("strokeName", ' · (Beginner|Intermediate|Advanced)$', '')
WHERE "strokeLabel" IS NULL
  AND "strokeName" ~ ' · (Beginner|Intermediate|Advanced)$';
