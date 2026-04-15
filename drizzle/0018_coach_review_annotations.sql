CREATE TABLE "coach_review_annotation" (
  "id" text PRIMARY KEY NOT NULL,
  "reviewId" text NOT NULL,
  "imageUri" text NOT NULL,
  "cloudinaryUrl" text,
  "comment" text,
  "timeMs" integer DEFAULT 0 NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "coach_review_annotation" ADD CONSTRAINT "coach_review_annotation_reviewId_coach_video_review_id_fk" FOREIGN KEY ("reviewId") REFERENCES "public"."coach_video_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_review_annotation_review_idx" ON "coach_review_annotation" USING btree ("reviewId");--> statement-breakpoint
CREATE INDEX "coach_review_annotation_review_time_idx" ON "coach_review_annotation" USING btree ("reviewId","timeMs");
