-- Allow multiple embedding spec versions per train_sample (v2 mediapipe + sam_v1 mesh).
ALTER TABLE "train_sample_embedding" DROP CONSTRAINT IF EXISTS "train_sample_embedding_trainSampleId_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "train_sample_embedding_trainSampleId_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "train_sample_embedding_sample_spec_unique"
  ON "train_sample_embedding" ("trainSampleId", "specVersion");
