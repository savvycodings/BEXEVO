-- Hand-written (not drizzle-kit generate): 0044_technique_drill lives on another branch, so the
-- meta snapshot for this migration is regenerated at merge time. Idempotent on purpose.
CREATE TABLE IF NOT EXISTS "friendship" (
	"id" text PRIMARY KEY NOT NULL,
	"requesterUserId" text NOT NULL,
	"addresseeUserId" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	CONSTRAINT "friendship_requesterUserId_user_id_fk" FOREIGN KEY ("requesterUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "friendship_addresseeUserId_user_id_fk" FOREIGN KEY ("addresseeUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "friendship_pair_idx" ON "friendship" USING btree (LEAST("requesterUserId", "addresseeUserId"),GREATEST("requesterUserId", "addresseeUserId"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friendship_addressee_status_idx" ON "friendship" USING btree ("addresseeUserId","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friendship_requester_status_idx" ON "friendship" USING btree ("requesterUserId","status");
