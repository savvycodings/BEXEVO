CREATE TABLE IF NOT EXISTS "user_gamification" (
  "userId" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "totalXp" integer DEFAULT 0 NOT NULL,
  "loginStreak" integer DEFAULT 0 NOT NULL,
  "lastLoginDate" text,
  "lastLevel" integer DEFAULT 1 NOT NULL,
  "dayStartDate" text,
  "dayStartLevel" integer DEFAULT 1 NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_achievement" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "achievementKey" text NOT NULL,
  "unlockedAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_achievement_user_key_idx" ON "user_achievement" ("userId", "achievementKey");
CREATE INDEX IF NOT EXISTS "user_achievement_user_idx" ON "user_achievement" ("userId");

CREATE TABLE IF NOT EXISTS "user_daily_quest" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "dateKey" text NOT NULL,
  "questKey" text NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "goal" integer DEFAULT 1 NOT NULL,
  "claimedAt" timestamp,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_daily_quest_user_date_key_idx" ON "user_daily_quest" ("userId", "dateKey", "questKey");
CREATE INDEX IF NOT EXISTS "user_daily_quest_user_date_idx" ON "user_daily_quest" ("userId", "dateKey");

CREATE TABLE IF NOT EXISTS "xp_event" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "amount" integer NOT NULL,
  "source" text NOT NULL,
  "sourceRef" text NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "xp_event_user_source_ref_idx" ON "xp_event" ("userId", "source", "sourceRef");
CREATE INDEX IF NOT EXISTS "xp_event_user_idx" ON "xp_event" ("userId");
