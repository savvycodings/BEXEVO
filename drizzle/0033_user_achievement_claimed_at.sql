ALTER TABLE "user_achievement" ADD COLUMN IF NOT EXISTS "claimedAt" timestamp;

UPDATE "user_achievement"
SET "claimedAt" = "unlockedAt"
WHERE "claimedAt" IS NULL;
