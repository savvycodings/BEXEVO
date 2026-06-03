import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const CASE_IDS = [
  "0d7313a7-b9ca-41ea-91ca-b9dc59775905",
  "ee64a055-068e-4d43-a555-452f977f0d58",
  "5a3c3f89-d5ef-44c5-902e-ca58468dabe3",
  "6534b76c-d6f3-46f5-a91c-ce9ad4ee465e",
];

async function main() {
  const { rows } = await pool.query(
    `SELECT ta.id, ta."userId", ta.status, tv."cloudinaryPublicId" AS path,
            (SELECT COUNT(*)::int FROM session s WHERE s."userId" = ta."userId" AND s."expiresAt" > NOW()) AS sessions
     FROM technique_analysis ta
     JOIN technique_video tv ON tv.id = ta."techniqueVideoId"
     WHERE ta.id = ANY($1::text[])`,
    [CASE_IDS]
  );
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}

main();
