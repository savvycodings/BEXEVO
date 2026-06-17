-- Idempotent: enum values may already exist from 0027; tables from 0031/0032_user_gamification.
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_volley' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'forehand_volley' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_return' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_return_with_lob' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'forehand_return_with_lob' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_drive_with_wall' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'forehand_chiquita' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'half_volley' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'back_wall_backhand' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'back_wall_forehand' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'contrapared_boast' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'side_wall_backhand' BEFORE 'bandeja';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'side_wall_forehand' BEFORE 'bandeja';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_accuracy_test_run" (
	"id" text PRIMARY KEY NOT NULL,
	"testId" text NOT NULL,
	"scorePercent" integer NOT NULL,
	"passed" boolean NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"triggeredByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technique_correction_regeneration_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"techniqueAnalysisId" text NOT NULL,
	"message" text NOT NULL,
	"coachingSnapshot" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_achievement" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"achievementKey" text NOT NULL,
	"unlockedAt" timestamp DEFAULT now() NOT NULL,
	"claimedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_daily_quest" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"dateKey" text NOT NULL,
	"questKey" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"goal" integer DEFAULT 1 NOT NULL,
	"claimedAt" timestamp,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_gamification" (
	"userId" text PRIMARY KEY NOT NULL,
	"totalXp" integer DEFAULT 0 NOT NULL,
	"loginStreak" integer DEFAULT 0 NOT NULL,
	"lastLoginDate" text,
	"lastLevel" integer DEFAULT 1 NOT NULL,
	"dayStartDate" text,
	"dayStartLevel" integer DEFAULT 1 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xp_event" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"amount" integer NOT NULL,
	"source" text NOT NULL,
	"sourceRef" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "train_sample_embedding" DROP CONSTRAINT IF EXISTS "train_sample_embedding_trainSampleId_unique";--> statement-breakpoint
ALTER TABLE "train_video" ADD COLUMN IF NOT EXISTS "strokeLabel" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_accuracy_test_run_triggeredByUserId_user_id_fk'
  ) THEN
    ALTER TABLE "admin_accuracy_test_run" ADD CONSTRAINT "admin_accuracy_test_run_triggeredByUserId_user_id_fk" FOREIGN KEY ("triggeredByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'technique_correction_regeneration_feedback_userId_user_id_fk'
  ) THEN
    ALTER TABLE "technique_correction_regeneration_feedback" ADD CONSTRAINT "technique_correction_regeneration_feedback_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'technique_correction_regeneration_feedback_techniqueAnalysisId_technique_analysis_id_fk'
  ) THEN
    ALTER TABLE "technique_correction_regeneration_feedback" ADD CONSTRAINT "technique_correction_regeneration_feedback_techniqueAnalysisId_technique_analysis_id_fk" FOREIGN KEY ("techniqueAnalysisId") REFERENCES "public"."technique_analysis"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_achievement_userId_user_id_fk'
  ) THEN
    ALTER TABLE "user_achievement" ADD CONSTRAINT "user_achievement_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_daily_quest_userId_user_id_fk'
  ) THEN
    ALTER TABLE "user_daily_quest" ADD CONSTRAINT "user_daily_quest_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_gamification_userId_user_id_fk'
  ) THEN
    ALTER TABLE "user_gamification" ADD CONSTRAINT "user_gamification_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'xp_event_userId_user_id_fk'
  ) THEN
    ALTER TABLE "xp_event" ADD CONSTRAINT "xp_event_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_accuracy_test_run_test_created_idx" ON "admin_accuracy_test_run" USING btree ("testId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technique_corr_regen_fb_analysis_idx" ON "technique_correction_regeneration_feedback" USING btree ("techniqueAnalysisId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technique_corr_regen_fb_user_idx" ON "technique_correction_regeneration_feedback" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_achievement_user_key_idx" ON "user_achievement" USING btree ("userId","achievementKey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_achievement_user_idx" ON "user_achievement" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_daily_quest_user_date_key_idx" ON "user_daily_quest" USING btree ("userId","dateKey","questKey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_daily_quest_user_date_idx" ON "user_daily_quest" USING btree ("userId","dateKey");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xp_event_user_source_ref_idx" ON "xp_event" USING btree ("userId","source","sourceRef");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xp_event_user_idx" ON "xp_event" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "train_sample_embedding_sample_spec_unique" ON "train_sample_embedding" USING btree ("trainSampleId","specVersion");
