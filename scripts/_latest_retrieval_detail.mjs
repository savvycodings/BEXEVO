import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

async function main() {
  const { rows } = await pool.query(`
    SELECT id, "createdAt", status, metrics
    FROM technique_analysis
    WHERE status = 'completed'
    ORDER BY "createdAt" DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) {
    console.log(JSON.stringify({ error: "no_completed" }, null, 2));
    await pool.end();
    return;
  }
  const m = row.metrics ?? {};
  const r = m.retrieval ?? {};
  const out = {
    analysis_id: row.id,
    createdAt: row.createdAt,
    shot_hypothesis: r.shot_hypothesis ?? null,
    query_embedding_ok: r.query_embedding_ok,
    neighbor_distance_gap: r.neighbor_distance_gap ?? null,
    impact_frame_source: m.impact_frame_source ?? null,
    impact_frame: m.impact_pose_sequence?.find((p) => p.phase === "impact")?.frame ?? null,
    user_clips: m.user_clips ?? null,
    yolo_contacts: m.yolo_summary?.contact_window_frames?.slice?.(0, 12) ?? null,
    rerank: r.rerank ?? null,
    top_neighbors: (r.neighbors ?? []).slice(0, 8).map((n) => ({
      stroke_label: n.stroke_label,
      stroke_preset: n.stroke_preset,
      category: n.category,
      distance: n.distance,
      train_sample_id: n.train_sample_id,
    })),
    correction_shot:
      m.correction_context?.shot_and_handedness?.shot?.shot_name ?? null,
    ai_shot_context: m.ai_analysis?.en?.shot_context?.slice?.(0, 200) ?? null,
  };
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
