import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const MIN_SAMPLES = Number(process.env.AUDIT_MIN_TRAIN_SAMPLES ?? 2);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
});

async function main() {
  const { rows } = await pool.query(`
    SELECT
      tv."strokePreset"::text AS stroke_preset,
      COALESCE(NULLIF(TRIM(tv."strokeLabel"), ''), tv."strokeName") AS stroke_label,
      COUNT(*)::int AS n
    FROM train_sample_embedding tse
    INNER JOIN train_sample ts ON ts.id = tse."trainSampleId"
    INNER JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.status = 'completed' AND tse."specVersion" = 'v2'
    GROUP BY 1, 2
    ORDER BY n ASC, stroke_preset, stroke_label
  `);

  const thin = rows.filter((r) => r.n < MIN_SAMPLES);
  console.log(
    JSON.stringify(
      {
        min_samples_threshold: MIN_SAMPLES,
        total_label_buckets: rows.length,
        by_preset_label: rows,
        thin_coverage: thin,
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
