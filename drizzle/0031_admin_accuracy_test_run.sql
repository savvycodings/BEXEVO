CREATE TABLE IF NOT EXISTS "admin_accuracy_test_run" (
  "id" text PRIMARY KEY NOT NULL,
  "testId" text NOT NULL,
  "scorePercent" integer NOT NULL,
  "passed" boolean NOT NULL,
  "summary" text NOT NULL,
  "detail" jsonb,
  "triggeredByUserId" text REFERENCES "user"("id") ON DELETE SET NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "admin_accuracy_test_run_test_created_idx"
  ON "admin_accuracy_test_run" ("testId", "createdAt" DESC);
