CREATE TABLE IF NOT EXISTS "coach_gallery_photo" (
	"id" text PRIMARY KEY NOT NULL,
	"coachUserId" text NOT NULL,
	"imageUrl" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "coach_gallery_photo" ADD CONSTRAINT "coach_gallery_photo_coachUserId_user_id_fk" FOREIGN KEY ("coachUserId") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_gallery_photo_coach_created_idx" ON "coach_gallery_photo" ("coachUserId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_gallery_photo_coach_sort_idx" ON "coach_gallery_photo" ("coachUserId","sortOrder");
