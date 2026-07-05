import dotenv from "dotenv";
import pg from "pg";
import { withNeonRetry, createPool } from "./_neon_retry.mjs";

dotenv.config();
const pool = createPool(pg, process.env.DATABASE_URL);

const TECH_IDS = [
  "75060178-aed0-4151-b70f-91dc19c8383b",
  "a222e067-ded6-447b-b0ed-48a00a812287",
  "3bf94a25-6e90-4da1-bcb4-01e10ef5b4d9",
  "11971ebc-ead8-45ff-91f0-30b41b6819c3",
  "deb52091-04f7-4a93-88f9-ab8dd59b24c7",
];

const rows = await withNeonRetry(async () => {
  const { rows: r } = await pool.query(
    `
  SELECT kind, id, bytes, path, label FROM (
    SELECT 'train' AS kind, tv.id, tv.bytes, tv."cloudinaryPublicId" AS path, tv."strokeLabel" AS label
    FROM train_video tv
    UNION ALL
    SELECT 'technique', tv.id, tv.bytes, tv."cloudinaryPublicId", NULL
    FROM technique_video tv WHERE tv.id = ANY($1::text[])
  ) u
  ORDER BY bytes::bigint, kind
  `,
    [TECH_IDS]
  );
  return r;
});
console.log(JSON.stringify(rows, null, 2));
await pool.end();
