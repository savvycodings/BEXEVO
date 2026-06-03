import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const IDS = [
  "d6e63c01-969a-4811-b2ad-95d930864181",
  "622056d0-1da6-407f-a273-ded9c4e9735a",
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  query_timeout: 90000,
});

async function main() {
  const { rows } = await pool.query(
    `
    SELECT
      id,
      "createdAt",
      metrics->'retrieval'->'shot_hypothesis' AS hyp,
      metrics->'retrieval'->'top_neighbors' AS top_neighbors,
      metrics->'retrieval'->>'embedding_spec_version' AS embedding_spec,
      metrics->'ai_analysis'->'en'->>'shot_context' AS shot_context,
      (metrics->'ai_analysis'->>'score')::float AS score,
      metrics->'correction_context'->'frames' AS frames,
      metrics->'correction_context'->'shot_and_handedness' AS shot_and_handedness
    FROM technique_analysis
    WHERE id = ANY($1::text[])
    ORDER BY "createdAt" DESC
    `,
    [IDS]
  );

  const out = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdat ?? r.createdAt,
    embedding_spec: r.embedding_spec,
    hyp: r.hyp,
    shot_context: r.shot_context,
    score: r.score,
    correction_shot: r.shot_and_handedness?.shot?.shot_name ?? null,
    top_neighbors: Array.isArray(r.top_neighbors)
      ? r.top_neighbors.slice(0, 5).map((n) => ({
          stroke_label: n.stroke_label,
          distance: n.distance,
          stroke_preset: n.stroke_preset,
        }))
      : null,
    frame_insights: Array.isArray(r.frames)
      ? r.frames.map((f) => ({
          frame: f.frame,
          label: f.label,
          phase: f.phase,
          pro_match: f.stats?.pro_match,
          adjustment_need: f.stats?.adjustment_need,
          focus_joints: f.focus_joints,
          summary: f.summary,
        }))
      : [],
  }));

  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
