import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  query_timeout: 60000,
});

async function main() {
  const { rows } = await pool.query(`
    SELECT
      id,
      status,
      "userId",
      "createdAt",
      "strokeLabel" AS hyp_label,
      ("retrievalConfidence")::float AS hyp_conf,
      "strokePreset" AS hyp_preset,
      category,
      "skillLevel",
      "correctionContext"->'shot_and_handedness'->'shot'->>'shot_name' AS correction_shot,
      COALESCE(jsonb_array_length("correctionContext"->'frames'), 0) AS frame_insights_n,
      jsonb_array_length(COALESCE("correctionImages", '[]'::jsonb)) AS gemini_correction_n
    FROM technique_analysis_overview
    ORDER BY "createdAt" DESC
    LIMIT 2
  `);

  const out = { queried_at: new Date().toISOString(), recent: rows };
  const path = new URL("./_recent_submissions.json", import.meta.url);
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
