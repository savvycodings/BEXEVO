-- Hand-written (not drizzle-kit generate): 0044 and 0046 live on other branches, so the meta
-- snapshot for this migration is regenerated at merge time. Idempotent on purpose.
CREATE TABLE IF NOT EXISTS "club_membership" (
	"id" text PRIMARY KEY NOT NULL,
	"clubId" text NOT NULL,
	"userId" text NOT NULL,
	"state" text NOT NULL,
	"invitedEmail" text,
	"createdByUserId" text,
	"isMain" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"joinedAt" timestamp,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "club_membership_clubId_club_id_fk" FOREIGN KEY ("clubId") REFERENCES "public"."club"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "club_membership_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "club_membership_createdByUserId_user_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "club_membership_club_user_idx" ON "club_membership" USING btree ("clubId","userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "club_membership_user_state_idx" ON "club_membership" USING btree ("userId","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "club_membership_club_state_idx" ON "club_membership" USING btree ("clubId","state");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "club_membership_user_main_idx" ON "club_membership" USING btree ("userId") WHERE "isMain";
