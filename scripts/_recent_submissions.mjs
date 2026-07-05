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
      ta.id,
      ta.status,
      ta."userId",
      ta."createdAt",
      (ta.metrics #>> '{retrieval,shot_hypothesis,stroke_label}') AS hyp_label,
      ((ta.metrics #>> '{retrieval,shot_hypothesis,confidence}')::float) AS hyp_conf,
      (ta.metrics #>> '{retrieval,shot_hypothesis,stroke_preset}') AS hyp_preset,
      (ta.metrics #>> '{retrieval,shot_hypothesis,category}') AS category,
      (ta.metrics #>> '{retrieval,shot_hypothesis,skill_level}') AS skill_level,
      (ta.metrics #>> '{correction_context,shot_and_handedness,shot,shot_name}') AS correction_shot,
      COALESCE(jsonb_array_length(ta.metrics->'correction_context'->'frames'), 0) AS frame_insights_n,
      jsonb_array_length(COALESCE(ta.metrics->'correction_images', '[]'::jsonb)) AS gemini_correction_n
    FROM technique_analysis ta
    WHERE ta.status = 'completed'
    ORDER BY ta."createdAt" DESC
    LIMIT 5
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
