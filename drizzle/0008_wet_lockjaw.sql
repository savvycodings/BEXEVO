CREATE TYPE "public"."train_view_profile" AS ENUM('front', 'side', 'behind');--> statement-breakpoint
CREATE TABLE "train_sample" (
	"id" text PRIMARY KEY NOT NULL,
	"trainVideoId" text NOT NULL,
	"userId" text NOT NULL,
	"strokeNameSnapshot" text NOT NULL,
	"status" text NOT NULL,
	"frameCount" integer,
	"totalFrames" integer,
	"poseSequence" jsonb,
	"extractionMeta" jsonb,
	"errorMessage" text,
	"modalJobId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "train_video_view_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"trainVideoId" text NOT NULL,
	"viewProfile" "train_view_profile" NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "train_sample" ADD CONSTRAINT "train_sample_trainVideoId_train_video_id_fk" FOREIGN KEY ("trainVideoId") REFERENCES "public"."train_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "train_sample" ADD CONSTRAINT "train_sample_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "train_video_view_profile" ADD CONSTRAINT "train_video_view_profile_trainVideoId_train_video_id_fk" FOREIGN KEY ("trainVideoId") REFERENCES "public"."train_video"("id") ON DELETE cascade ON UPDATE no action;