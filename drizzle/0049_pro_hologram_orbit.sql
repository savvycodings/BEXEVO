-- Shared Seedance orbit for each pro-library contact still.
ALTER TABLE "pro_hologram_render" ADD COLUMN IF NOT EXISTS "orbitVideo" text;
--> statement-breakpoint
ALTER TABLE "pro_hologram_render" ADD COLUMN IF NOT EXISTS "orbitDurationMs" integer;
--> statement-breakpoint
ALTER TABLE "pro_hologram_render" ADD COLUMN IF NOT EXISTS "orbitFrameCount" integer;
--> statement-breakpoint
ALTER TABLE "pro_hologram_render" ADD COLUMN IF NOT EXISTS "orbitWidth" integer;
--> statement-breakpoint
ALTER TABLE "pro_hologram_render" ADD COLUMN IF NOT EXISTS "orbitHeight" integer;
--> statement-breakpoint
ALTER TABLE "pro_hologram_render" ADD COLUMN IF NOT EXISTS "orbitFrames" jsonb;
