-- Drizzle cannot CREATE EXTENSION from schema.ts. Run this once per empty database
-- (Neon: SQL Editor, or psql) before drizzle-kit push if push errors on type "vector".
CREATE EXTENSION IF NOT EXISTS vector;
