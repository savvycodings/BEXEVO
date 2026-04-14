CREATE TABLE "coach_video_review" (
  "id" text PRIMARY KEY NOT NULL,
  "coachUserId" text NOT NULL,
  "studentUserId" text NOT NULL,
  "techniqueVideoId" text NOT NULL,
  "techniqueAnalysisId" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "coachFeedbackText" text,
  "coachMarksJson" jsonb,
  "submittedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "coach_video_review" ADD CONSTRAINT "coach_video_review_coachUserId_user_id_fk" FOREIGN KEY ("coachUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_video_review" ADD CONSTRAINT "coach_video_review_studentUserId_user_id_fk" FOREIGN KEY ("studentUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_video_review" ADD CONSTRAINT "coach_video_review_techniqueVideoId_technique_video_id_fk" FOREIGN KEY ("techniqueVideoId") REFERENCES "public"."technique_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_video_review" ADD CONSTRAINT "coach_video_review_techniqueAnalysisId_technique_analysis_id_fk" FOREIGN KEY ("techniqueAnalysisId") REFERENCES "public"."technique_analysis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_video_review_unique_pair_idx" ON "coach_video_review" USING btree ("coachUserId","techniqueVideoId");--> statement-breakpoint
CREATE INDEX "coach_video_review_coach_status_idx" ON "coach_video_review" USING btree ("coachUserId","status");--> statement-breakpoint
CREATE INDEX "coach_video_review_student_status_idx" ON "coach_video_review" USING btree ("studentUserId","status");--> statement-breakpoint
CREATE INDEX "coach_video_review_video_idx" ON "coach_video_review" USING btree ("techniqueVideoId");--> statement-breakpoint
CREATE INDEX "coach_video_review_analysis_idx" ON "coach_video_review" USING btree ("techniqueAnalysisId");--> statement-breakpoint

CREATE TABLE "user_notification" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "refType" text,
  "refId" text,
  "readAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "user_notification" ADD CONSTRAINT "user_notification_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_notification_user_created_idx" ON "user_notification" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "user_notification_ref_idx" ON "user_notification" USING btree ("refType","refId");
