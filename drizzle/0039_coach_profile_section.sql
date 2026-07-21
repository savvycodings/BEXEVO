CREATE TABLE IF NOT EXISTS "coach_profile_section" (
	"id" text PRIMARY KEY NOT NULL,
	"coachUserId" text NOT NULL,
	"heading" text NOT NULL,
	"body" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "coach_profile_section" ADD CONSTRAINT "coach_profile_section_coachUserId_user_id_fk" FOREIGN KEY ("coachUserId") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_profile_section_coach_sort_idx" ON "coach_profile_section" ("coachUserId","sortOrder");
