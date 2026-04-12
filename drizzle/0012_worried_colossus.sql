CREATE TABLE "train_sample_embedding" (
	"id" text PRIMARY KEY NOT NULL,
	"trainSampleId" text NOT NULL,
	"specVersion" text NOT NULL,
	"embedding" vector(128) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "train_sample_embedding_trainSampleId_unique" UNIQUE("trainSampleId")
);
--> statement-breakpoint
ALTER TABLE "train_sample_embedding" ADD CONSTRAINT "train_sample_embedding_trainSampleId_train_sample_id_fk" FOREIGN KEY ("trainSampleId") REFERENCES "public"."train_sample"("id") ON DELETE cascade ON UPDATE no action;