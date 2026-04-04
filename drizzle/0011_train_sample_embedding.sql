CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "train_sample_embedding" (
	"id" text PRIMARY KEY NOT NULL,
	"trainSampleId" text NOT NULL,
	"specVersion" text NOT NULL,
	"embedding" vector(128) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "train_sample_embedding" ADD CONSTRAINT "train_sample_embedding_trainSampleId_train_sample_id_fk" FOREIGN KEY ("trainSampleId") REFERENCES "public"."train_sample"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "train_sample_embedding_trainSampleId_unique" ON "train_sample_embedding" USING btree ("trainSampleId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "train_sample_embedding_hnsw_idx" ON "train_sample_embedding" USING hnsw ("embedding" vector_cosine_ops);
