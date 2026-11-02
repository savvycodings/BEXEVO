CREATE TABLE IF NOT EXISTS "follow" (
	"id" text PRIMARY KEY NOT NULL,
	"followerUserId" text NOT NULL,
	"targetType" text NOT NULL,
	"targetId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "follow" ADD CONSTRAINT "follow_followerUserId_user_id_fk" FOREIGN KEY ("followerUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "follow_unique_idx" ON "follow" USING btree ("followerUserId","targetType","targetId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follow_target_idx" ON "follow" USING btree ("targetType","targetId");
--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN IF NOT EXISTS "coachSpecialties" text[] DEFAULT '{}' NOT NULL;
