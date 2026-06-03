import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const FOREHAND_LOB_SAMPLE = "24f002ba-9ac6-457d-bfdc-a3a00a911386";
const IDS = [
  "622056d0-1da6-407f-a273-ded9c4e9735a",
  "d6e63c01-969a-4811-b2ad-95d930864181",
];

async function main() {
  const { embedPoseForProRetrieval, formatVectorSqlLiteral } = await import(
    "../src/technique/poseEmbedding.ts"
  );
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: lobRow } = await pool.query(
    `
    SELECT tv."strokeLabel", tv."strokePreset"::text AS preset,
           ts."frameCount", ts."totalFrames", ts."extractionMeta"->'normalized_label' AS norm
    FROM train_sample ts
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.id = $1
    `,
    [FOREHAND_LOB_SAMPLE]
  );

  for (const id of IDS) {
    const { rows } = await pool.query(
      `SELECT metrics FROM technique_analysis WHERE id = $1`,
      [id]
    );
    const m = rows[0]?.metrics;
    const q = embedPoseForProRetrieval(m);
    if (!q) {
      console.log(id, "no_embed");
      continue;
    }
    const lit = formatVectorSqlLiteral(q);
    const { rows: d } = await pool.query(
      `SELECT (embedding <=> $1::vector)::float8 AS dist
       FROM train_sample_embedding
       WHERE "trainSampleId" = $2 AND "specVersion" = 'v2'`,
      [lit, FOREHAND_LOB_SAMPLE]
    );
    const winner = m?.retrieval?.neighbors?.[0];
    console.log(
      JSON.stringify({
        analysis_id: id,
        impact_frame: m?.impact_pose_sequence?.find((p) => p.phase === "impact")?.frame,
        user_clips: m?.user_clips,
        stored_winner: winner?.stroke_label,
        stored_winner_dist: winner?.distance,
        dist_to_canonical_Forehand_Lob_train_clip: Number(d[0]?.dist),
        lob_train_meta: lobRow[0],
      })
    );
  }
  await pool.end();
}

main();
