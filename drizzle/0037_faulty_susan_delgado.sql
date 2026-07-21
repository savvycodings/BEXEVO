CREATE TABLE "coach_sent_video" (
	"id" text PRIMARY KEY NOT NULL,
	"coachUserId" text NOT NULL,
	"studentUserId" text NOT NULL,
	"techniqueVideoId" text NOT NULL,
	"category" text,
	"strokePreset" text,
	"shotLabel" text,
	"skillLevel" text,
	"viewId" text,
	"note" text,
	"viewedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "train_sample_embedding_sample_spec_unique";--> statement-breakpoint
ALTER TABLE "coach_review_annotation" ADD COLUMN "tone" text;--> statement-breakpoint
ALTER TABLE "coach_video_review" ADD COLUMN "coachViewedAt" timestamp;--> statement-breakpoint
ALTER TABLE "train_sample_embedding" ADD COLUMN "frameIndex" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "train_sample_embedding" ADD COLUMN "meshConfidence" real;--> statement-breakpoint
ALTER TABLE "coach_sent_video" ADD CONSTRAINT "coach_sent_video_coachUserId_user_id_fk" FOREIGN KEY ("coachUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_sent_video" ADD CONSTRAINT "coach_sent_video_studentUserId_user_id_fk" FOREIGN KEY ("studentUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_sent_video" ADD CONSTRAINT "coach_sent_video_techniqueVideoId_technique_video_id_fk" FOREIGN KEY ("techniqueVideoId") REFERENCES "public"."technique_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_sent_video_student_created_idx" ON "coach_sent_video" USING btree ("studentUserId","createdAt");--> statement-breakpoint
CREATE INDEX "coach_sent_video_coach_created_idx" ON "coach_sent_video" USING btree ("coachUserId","createdAt");--> statement-breakpoint
CREATE INDEX "coach_sent_video_video_idx" ON "coach_sent_video" USING btree ("techniqueVideoId");--> statement-breakpoint
CREATE UNIQUE INDEX "train_sample_embedding_sample_spec_frame_unique" ON "train_sample_embedding" USING btree ("trainSampleId","specVersion","frameIndex");