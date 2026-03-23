CREATE TABLE "technique_analysis" (
	"id" text PRIMARY KEY NOT NULL,
	"techniqueVideoId" text NOT NULL,
	"userId" text NOT NULL,
	"status" text NOT NULL,
	"metrics" jsonb,
	"feedbackText" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technique_video" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"cloudinaryPublicId" text NOT NULL,
	"cloudinaryUrl" text NOT NULL,
	"secureUrl" text,
	"bytes" text,
	"format" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "technique_analysis" ADD CONSTRAINT "technique_analysis_techniqueVideoId_technique_video_id_fk" FOREIGN KEY ("techniqueVideoId") REFERENCES "public"."technique_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technique_analysis" ADD CONSTRAINT "technique_analysis_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technique_video" ADD CONSTRAINT "technique_video_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;