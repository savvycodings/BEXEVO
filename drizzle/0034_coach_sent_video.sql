CREATE TABLE IF NOT EXISTS "coach_sent_video" (
	"id" text PRIMARY KEY NOT NULL,
	"coachUserId" text NOT NULL,
	"studentUserId" text NOT NULL,
	"techniqueVideoId" text NOT NULL,
	"category" text,
	"strokePreset" text,
	"shotLabel" text,
	"skillLevel" text,
	"viewId" text,
	"note" text,
	"viewedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "coach_sent_video" ADD CONSTRAINT "coach_sent_video_coachUserId_user_id_fk" FOREIGN KEY ("coachUserId") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "coach_sent_video" ADD CONSTRAINT "coach_sent_video_studentUserId_user_id_fk" FOREIGN KEY ("studentUserId") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "coach_sent_video" ADD CONSTRAINT "coach_sent_video_techniqueVideoId_technique_video_id_fk" FOREIGN KEY ("techniqueVideoId") REFERENCES "technique_video"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_sent_video_student_created_idx" ON "coach_sent_video" ("studentUserId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_sent_video_coach_created_idx" ON "coach_sent_video" ("coachUserId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_sent_video_video_idx" ON "coach_sent_video" ("techniqueVideoId");
