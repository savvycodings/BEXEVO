import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

async function main() {
  const { rows: train } = await pool.query(`
    SELECT ts.id AS sample_id, tv."strokeLabel", tv."strokePreset"::text AS preset,
           tv.category::text AS category, ts."frameCount", ts.status
    FROM train_sample ts
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    JOIN train_sample_embedding tse ON tse."trainSampleId" = ts.id AND tse."specVersion" = 'v2'
    WHERE ts.status = 'completed'
      AND (
        tv."strokePreset"::text = 'bandeja'
        OR LOWER(COALESCE(tv."strokeLabel", '')) LIKE '%bandeja%'
      )
    ORDER BY tv."strokeLabel", ts."createdAt" DESC
  `);

  const { rows: latest } = await pool.query(`
    SELECT id FROM technique_analysis
    WHERE status = 'completed'
    ORDER BY "createdAt" DESC LIMIT 1
  `);
  let distToBandeja = null;
  if (latest[0]?.id) {
    const { embedPoseForProRetrieval, formatVectorSqlLiteral } = await import(
      "../src/technique/poseEmbedding.ts"
    );
    const { rows: mrows } = await pool.query(
      `SELECT metrics FROM technique_analysis WHERE id = $1`,
      [latest[0].id]
    );
    const m = mrows[0]?.metrics;
    const q = embedPoseForProRetrieval(m);
    if (q && train.length) {
      const lit = formatVectorSqlLiteral(q);
      const ids = train.map((t) => t.sample_id);
      const { rows: drows } = await pool.query(
        `
        SELECT tse."trainSampleId", (tse.embedding <=> $1::vector)::float8 AS dist
        FROM train_sample_embedding tse
        WHERE tse."trainSampleId" = ANY($2::text[]) AND tse."specVersion" = 'v2'
        ORDER BY dist ASC
        `,
        [lit, ids]
      );
      distToBandeja = drows;
    }
  }

  console.log(
    JSON.stringify(
      {
        bandeja_train_clips: train,
        bandeja_train_count: train.length,
        latest_analysis_distances_to_bandeja_clips: distToBandeja,
      },
      null,
      2
    )
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
