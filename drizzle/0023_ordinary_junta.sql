CREATE TABLE "technique_detection_frame" (
	"id" text PRIMARY KEY NOT NULL,
	"analysisId" text NOT NULL,
	"frame" integer NOT NULL,
	"timeMs" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"boxX" integer DEFAULT 0 NOT NULL,
	"boxY" integer DEFAULT 0 NOT NULL,
	"boxW" integer DEFAULT 0 NOT NULL,
	"boxH" integer DEFAULT 0 NOT NULL,
	"trackId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "technique_detection_frame" ADD CONSTRAINT "technique_detection_frame_analysisId_technique_analysis_id_fk" FOREIGN KEY ("analysisId") REFERENCES "public"."technique_analysis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "technique_detection_frame_analysis_frame_idx" ON "technique_detection_frame" USING btree ("analysisId","frame");--> statement-breakpoint
CREATE INDEX "technique_detection_frame_analysis_label_idx" ON "technique_detection_frame" USING btree ("analysisId","label");--> statement-breakpoint
CREATE INDEX "technique_detection_frame_analysis_time_idx" ON "technique_detection_frame" USING btree ("analysisId","timeMs");