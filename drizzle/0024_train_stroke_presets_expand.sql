-- Expand pro-library stroke labels (train_video.strokePreset).
-- Uses DO blocks so re-runs are safe on PG versions before 15 (no IF NOT EXISTS on ADD VALUE).
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'backhand_volley'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'forehand_volley'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'backhand_return'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'backhand_return_with_lob'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'forehand_return_with_lob'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'backhand_drive_with_wall'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'forehand_chiquita'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'half_volley'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'back_wall_backhand'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'back_wall_forehand'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'contrapared_boast'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'side_wall_backhand'; EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "public"."train_stroke_preset" ADD VALUE 'side_wall_forehand'; EXCEPTION WHEN duplicate_object THEN null; END $$;
