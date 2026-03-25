CREATE TABLE "train_video" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"strokeName" text NOT NULL,
	"cloudinaryPublicId" text NOT NULL,
	"cloudinaryUrl" text NOT NULL,
	"secureUrl" text,
	"bytes" text,
	"format" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "train_video" ADD CONSTRAINT "train_video_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
