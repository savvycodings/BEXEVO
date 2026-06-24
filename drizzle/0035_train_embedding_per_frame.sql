-- Sequence ensemble: per-frame embedding rows per (train_sample, spec).
-- Add frameIndex + meshConfidence, swap the unique index to include frameIndex.
ALTER TABLE "train_sample_embedding" ADD COLUMN IF NOT EXISTS "frameIndex" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "train_sample_embedding" ADD COLUMN IF NOT EXISTS "meshConfidence" real;
--> statement-breakpoint
DROP INDEX IF EXISTS "train_sample_embedding_sample_spec_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "train_sample_embedding_sample_spec_frame_unique"
  ON "train_sample_embedding" ("trainSampleId", "specVersion", "frameIndex");
