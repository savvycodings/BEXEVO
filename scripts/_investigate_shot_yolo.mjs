import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function impactFrameFromMetrics(metrics) {
  const seq = metrics?.impact_pose_sequence;
  if (!Array.isArray(seq)) return null;
  const impact = seq.find((p) => p?.phase === "impact") ?? seq[1];
  return impact?.frame != null ? Number(impact.frame) : null;
}

function nearestContactDelta(impactFrame, contactFrames) {
  if (impactFrame == null || !Array.isArray(contactFrames) || contactFrames.length === 0) {
    return null;
  }
  let best = Infinity;
  for (const f of contactFrames) {
    const n = Number(f);
    if (!Number.isFinite(n)) continue;
    best = Math.min(best, Math.abs(n - impactFrame));
  }
  return best === Infinity ? null : best;
}

function presetLikeLabel(s) {
  return typeof s === "string" && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(s.trim());
}

async function main() {
  const q1 = await pool.query(`
    SELECT id, status,
      metrics->'retrieval'->'shot_hypothesis' AS hyp,
      metrics->'ai_analysis'->'en'->>'shot_context' AS shot_context,
      metrics->'detection_summary'->>'enabled' AS yolo_enabled,
      metrics->'detection_summary'->>'detected_frames' AS yolo_frames,
      jsonb_array_length(COALESCE(metrics->'pose_data','[]'::jsonb)) AS pose_count
    FROM technique_analysis
    WHERE status = 'completed'
    ORDER BY "createdAt" DESC
    LIMIT 30
  `);

  const q2 = await pool.query(`
    SELECT id, metrics,
      metrics->'retrieval'->'shot_hypothesis'->>'stroke_label' AS hyp_label,
      metrics->'retrieval'->'shot_hypothesis'->>'stroke_preset' AS hyp_preset,
      (metrics->'retrieval'->'shot_hypothesis'->>'confidence')::float AS hyp_conf,
      metrics->'ai_analysis'->'en'->>'shot_context' AS llm_shot,
      metrics->'impact_pose_sequence' AS impact_seq,
      metrics->'detection_summary'->'contact_window_frames' AS yolo_contact,
      metrics->'retrieval'->'neighbors' AS neighbors
    FROM technique_analysis
    WHERE status = 'completed'
    ORDER BY "createdAt" DESC
    LIMIT 30
  `);

  const q3 = await pool.query(`
    SELECT id,
      (SELECT count(*)::int FROM jsonb_array_elements(ta.metrics->'pose_data') p
       WHERE p->>'racket_hand' IS NOT NULL) AS with_racket_hand,
      jsonb_array_length(ta.metrics->'pose_data') AS total_pose,
      ta.metrics->'detection_summary' AS detection_summary,
      ta.metrics->'impact_pose_sequence' AS impact_seq
    FROM technique_analysis ta
    WHERE status = 'completed'
    ORDER BY "createdAt" DESC
    LIMIT 20
  `);

  const q4 = await pool.query(`
    SELECT COUNT(*)::int AS detection_frame_rows,
           COUNT(DISTINCT "analysisId")::int AS analyses_with_rows
    FROM technique_detection_frame
  `);

  const summary1 = q1.rows.map((r) => ({
    id: r.id,
    hyp: r.hyp,
    shot_context: r.shot_context,
    yolo_enabled: r.yolo_enabled,
    yolo_frames: r.yolo_frames,
    pose_count: r.pose_count,
  }));

  const q5 = await pool.query(`
    SELECT id,
      metrics->'correction_context_comfy'->'shot_and_handedness' AS comfy_shot,
      metrics->'correction_context'->'shot_and_handedness' AS legacy_shot,
      metrics->'retrieval'->'shot_hypothesis'->>'stroke_label' AS hyp_label,
      metrics->'ai_analysis'->'en'->>'shot_context' AS shot_context
    FROM technique_analysis
    WHERE status = 'completed'
      AND (metrics->'correction_images_comfy' IS NOT NULL OR metrics->'correction_images' IS NOT NULL)
    ORDER BY "createdAt" DESC
    LIMIT 15
  `);

  fs.writeFileSync(
    new URL("./_investigate_output_clean.json", import.meta.url),
    JSON.stringify({
    query1_count: q1.rows.length,
    query1: summary1,
    query2_flags: q2.rows.map((r) => {
      const metrics = r.metrics;
      const impactFrame = impactFrameFromMetrics(metrics);
      const contact = metrics?.detection_summary?.contact_window_frames ?? r.yolo_contact;
      const neighbors = Array.isArray(r.neighbors) ? r.neighbors : [];
      const topNeighbor = neighbors[0];
      return {
        id: r.id,
        hyp_label: r.hyp_label,
        hyp_preset: r.hyp_preset,
        hyp_conf: r.hyp_conf,
        llm_shot: r.llm_shot?.slice(0, 120),
        impact_frame: impactFrame,
        yolo_contact: contact,
        contact_delta: nearestContactDelta(impactFrame, contact),
        preset_like_hyp_label: presetLikeLabel(r.hyp_label),
        top_neighbor_label: topNeighbor?.stroke_label ?? null,
        top_neighbor_preset: topNeighbor?.stroke_preset ?? null,
        top_neighbor_distance: topNeighbor?.distance ?? null,
        label_differs_from_top_neighbor:
          topNeighbor?.stroke_label &&
          r.hyp_label &&
          topNeighbor.stroke_label.trim() !== r.hyp_label.trim(),
        preset_label_split:
          topNeighbor?.stroke_preset &&
          r.hyp_preset &&
          topNeighbor.stroke_preset === r.hyp_preset &&
          topNeighbor?.stroke_label &&
          r.hyp_label &&
          topNeighbor.stroke_label.trim() !== r.hyp_label.trim(),
      };
    }),
    query3_racket_hand: q3.rows,
    query4_detection_table: q4.rows[0],
    query5_corrections: q5.rows,
  }, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
