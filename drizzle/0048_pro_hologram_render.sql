-- Orange Nano Banana stills for the curated pro library. One row per shot and camera.
CREATE TABLE IF NOT EXISTS "pro_hologram_render" (
	"id" text PRIMARY KEY NOT NULL,
	"strokePreset" text NOT NULL,
	"viewId" text NOT NULL,
	"videoPath" text NOT NULL,
	"contactFrame" integer,
	"image" text,
	"frameImage" text,
	"keypoints" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pro_hologram_render_shot_view_idx" ON "pro_hologram_render" USING btree ("strokePreset","viewId");
