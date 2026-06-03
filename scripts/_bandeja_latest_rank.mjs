import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const ANALYSIS_ID = "51c88c1d-5940-4df9-8099-6c3051eb78f6";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { embedPoseForProRetrieval, formatVectorSqlLiteral } = await import(
    "../src/technique/poseEmbedding.ts"
  );
  const { resolveCanonicalShotFromMetrics } = await import(
    "../src/train/trainShotDisplay.ts"
  );
  const { rows } = await pool.query(
    `SELECT metrics FROM technique_analysis WHERE id = $1`,
    [ANALYSIS_ID]
  );
  const m = rows[0]?.metrics;
  const q = embedPoseForProRetrieval(m);
  const lit = formatVectorSqlLiteral(q);
  const { rows: nn } = await pool.query(
    `
    SELECT tv."strokeLabel", tv."strokePreset"::text AS preset, tv.category::text AS cat,
           (tse.embedding <=> $1::vector)::float8 AS dist, tse."trainSampleId" AS sample_id
    FROM train_sample_embedding tse
    JOIN train_sample ts ON ts.id = tse."trainSampleId"
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.status = 'completed' AND tse."specVersion" = 'v2'
    ORDER BY dist ASC
    LIMIT 25
    `,
    [lit]
  );
  const bandeja = nn.filter((n) =>
    String(n.strokeLabel || "").toLowerCase().includes("bandeja")
  );
  const display = resolveCanonicalShotFromMetrics(m);
  console.log(
    JSON.stringify(
      {
        analysis_id: ANALYSIS_ID,
        ui_display: display,
        bandeja_in_top25: bandeja,
        top10: nn.slice(0, 10),
      },
      null,
      2
    )
  );
  await pool.end();
}

main();
