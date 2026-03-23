CREATE TABLE "user_profile" (
	"userId" text PRIMARY KEY NOT NULL,
	"dominantHand" text,
	"courtSide" text,
	"hasRanking" boolean,
	"level" text,
	"rankingOrg" text,
	"rankingValue" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;