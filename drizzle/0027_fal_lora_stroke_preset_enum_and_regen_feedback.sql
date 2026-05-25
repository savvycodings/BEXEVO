-- fal_lora_image.strokePreset was text in some DBs; expand enum then cast with USING.
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_volley';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'forehand_volley';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_return';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_return_with_lob';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'forehand_return_with_lob';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'backhand_drive_with_wall';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'forehand_chiquita';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'half_volley';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'back_wall_backhand';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'back_wall_forehand';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'contrapared_boast';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'side_wall_backhand';--> statement-breakpoint
ALTER TYPE "public"."train_stroke_preset" ADD VALUE IF NOT EXISTS 'side_wall_forehand';--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fal_lora_image'
      AND column_name = 'strokePreset'
      AND udt_name = 'text'
  ) THEN
    ALTER TABLE "fal_lora_image"
      ALTER COLUMN "strokePreset" TYPE "train_stroke_preset"
      USING ("strokePreset"::text::"train_stroke_preset");
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technique_correction_regeneration_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"techniqueAnalysisId" text NOT NULL,
	"message" text NOT NULL,
	"coachingSnapshot" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'technique_correction_regeneration_feedback_userId_user_id_fk'
  ) THEN
    ALTER TABLE "technique_correction_regeneration_feedback"
      ADD CONSTRAINT "technique_correction_regeneration_feedback_userId_user_id_fk"
      FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'technique_correction_regeneration_feedback_techniqueAnalysisId_technique_analysis_id_fk'
  ) THEN
    ALTER TABLE "technique_correction_regeneration_feedback"
      ADD CONSTRAINT "technique_correction_regeneration_feedback_techniqueAnalysisId_technique_analysis_id_fk"
      FOREIGN KEY ("techniqueAnalysisId") REFERENCES "public"."technique_analysis"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technique_corr_regen_fb_analysis_idx" ON "technique_correction_regeneration_feedback" USING btree ("techniqueAnalysisId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technique_corr_regen_fb_user_idx" ON "technique_correction_regeneration_feedback" USING btree ("userId","createdAt");
