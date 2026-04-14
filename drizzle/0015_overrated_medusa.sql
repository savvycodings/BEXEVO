CREATE TABLE "coach_student" (
	"id" text PRIMARY KEY NOT NULL,
	"coachUserId" text NOT NULL,
	"studentUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "coachStudentRole" text DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "coach_student" ADD CONSTRAINT "coach_student_coachUserId_user_id_fk" FOREIGN KEY ("coachUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_student" ADD CONSTRAINT "coach_student_studentUserId_user_id_fk" FOREIGN KEY ("studentUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_student_unique_pair_idx" ON "coach_student" USING btree ("coachUserId","studentUserId");--> statement-breakpoint
CREATE INDEX "coach_student_coach_idx" ON "coach_student" USING btree ("coachUserId");--> statement-breakpoint
CREATE INDEX "coach_student_student_idx" ON "coach_student" USING btree ("studentUserId");