import dotenv from "dotenv";
import pg from "pg";
import { isExcludedTrainNeighbor } from "../src/technique/trainRetrievalHygiene.ts";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
});

async function main() {
  const { rows } = await pool.query(`
    SELECT
      ts.id AS train_sample_id,
      tv."strokeLabel",
      tv."strokeName",
      tv."strokePreset"::text AS stroke_preset,
      tse."specVersion" AS emb_spec,
      ts."extractionMeta" AS extraction_meta
    FROM train_sample ts
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    LEFT JOIN train_sample_embedding tse ON tse."trainSampleId" = ts.id
    WHERE ts.status = 'completed'
    ORDER BY tv."strokePreset", tv."strokeLabel"
  `);

  const mismatches = [];
  for (const r of rows) {
    const stroke_label = (r.strokeLabel ?? r.strokeName ?? "").trim();
    const candidate = {
      train_sample_id: r.train_sample_id,
      train_video_id: "",
      stroke_name: r.strokeName,
      stroke_label,
      category: "",
      stroke_preset: r.stroke_preset,
      skill_level: "",
      distance: 0,
      extraction_meta: r.extraction_meta,
    };
    if (isExcludedTrainNeighbor(candidate)) {
      mismatches.push({
        train_sample_id: r.train_sample_id,
        stroke_label,
        stroke_preset: r.stroke_preset,
        emb_spec: r.emb_spec,
        normalized_label: r.extraction_meta?.normalized_label ?? null,
      });
    }
  }

  console.log(
    JSON.stringify(
      { total_completed: rows.length, mismatches, mismatch_count: mismatches.length },
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
