CREATE TABLE "coach_student_chat" (
	"id" text PRIMARY KEY NOT NULL,
	"coachStudentId" text NOT NULL,
	"lastMessageAt" timestamp,
	"coachLastReadAt" timestamp,
	"studentLastReadAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coach_student_chat_coachStudentId_unique" UNIQUE("coachStudentId")
);
--> statement-breakpoint
CREATE TABLE "coach_student_chat_message" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"senderUserId" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coach_student_chat" ADD CONSTRAINT "coach_student_chat_coachStudentId_coach_student_id_fk" FOREIGN KEY ("coachStudentId") REFERENCES "public"."coach_student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_student_chat_message" ADD CONSTRAINT "coach_student_chat_message_chatId_coach_student_chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."coach_student_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_student_chat_message" ADD CONSTRAINT "coach_student_chat_message_senderUserId_user_id_fk" FOREIGN KEY ("senderUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_student_chat_last_message_idx" ON "coach_student_chat" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX "coach_student_chat_message_chat_created_idx" ON "coach_student_chat_message" USING btree ("chatId","createdAt");--> statement-breakpoint
CREATE INDEX "coach_student_chat_message_sender_idx" ON "coach_student_chat_message" USING btree ("senderUserId");