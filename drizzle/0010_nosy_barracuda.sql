CREATE TYPE "public"."train_category" AS ENUM('ground_strokes', 'net_play', 'defence_glass', 'save_return', 'overhead', 'tactical_specials');--> statement-breakpoint
CREATE TYPE "public"."train_skill_level" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."train_stroke_preset" AS ENUM('forehand_drive', 'backhand_drive', 'forehand_lob', 'backhand_lob');--> statement-breakpoint
ALTER TABLE "train_video" ADD COLUMN "category" "train_category" NOT NULL DEFAULT 'ground_strokes';--> statement-breakpoint
ALTER TABLE "train_video" ADD COLUMN "strokePreset" "train_stroke_preset" NOT NULL DEFAULT 'forehand_drive';--> statement-breakpoint
ALTER TABLE "train_video" ADD COLUMN "skillLevel" "train_skill_level" NOT NULL DEFAULT 'intermediate';