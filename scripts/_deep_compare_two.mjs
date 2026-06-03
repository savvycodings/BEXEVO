import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";
import crypto from "crypto";
import path from "path";

dotenv.config();

const IDS = [
  "622056d0-1da6-407f-a273-ded9c4e9735a",
  "d6e63c01-969a-4811-b2ad-95d930864181",
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  query_timeout: 90000,
});

function sha256File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function impactSummary(metrics) {
  const seq = metrics?.impact_pose_sequence;
  if (!Array.isArray(seq)) return null;
  return seq.map((p) => ({
    phase: p.phase,
    frame: p.frame,
  }));
}

function topNeighbors(metrics, n = 5) {
  const neighbors =
    metrics?.retrieval?.neighbors ??
    metrics?.retrieval?.top_neighbors ??
    null;
  if (!Array.isArray(neighbors)) return null;
  return neighbors.slice(0, n).map((x) => ({
    stroke_label: x.stroke_label,
    stroke_preset: x.stroke_preset,
    distance: x.distance,
    category: x.category,
  }));
}

async function main() {
  const { rows } = await pool.query(
    `
    SELECT
      ta.id,
      ta."createdAt",
      ta."techniqueVideoId",
      tv."cloudinaryPublicId",
      tv.bytes,
      ta.metrics
    FROM technique_analysis ta
    JOIN technique_video tv ON tv.id = ta."techniqueVideoId"
    WHERE ta.id = ANY($1::text[])
    ORDER BY ta."createdAt" ASC
    `,
    [IDS]
  );

  const out = [];
  const hashes = [];

  for (const row of rows) {
    const m = row.metrics ?? {};
    const en = m.ai_analysis?.en ?? m.ai_analysis ?? {};
    const filePath =
      typeof row.cloudinaryPublicId === "string" &&
      row.cloudinaryPublicId.endsWith(".mp4")
        ? row.cloudinaryPublicId
        : null;
    const hash = filePath ? sha256File(filePath) : null;
    if (typeof hash === "string") hashes.push(hash);

    out.push({
      analysis_id: row.id,
      createdAt: row.createdAt,
      techniqueVideoId: row.techniqueVideoId,
      bytes: row.bytes,
      local_mp4: filePath,
      sha256: hash,
      user_clips: m.user_clips,
      video_duration_ms: m.video_duration_ms,
      total_frames: m.total_frames,
      stroke_label: m.retrieval?.shot_hypothesis?.stroke_label,
      stroke_preset: m.retrieval?.shot_hypothesis?.stroke_preset,
      hyp_confidence: m.retrieval?.shot_hypothesis?.confidence,
      embedding_spec: m.retrieval?.embedding_spec_version ?? null,
      llm_shot_context: en.shot_context ?? null,
      llm_diagnosis_snip:
        typeof en.diagnosis === "string" ? en.diagnosis.slice(0, 200) : null,
      score: m.ai_analysis?.score ?? null,
      impact_pose_sequence: impactSummary(m),
      yolo: {
        enabled: m.detection_summary?.enabled,
        detected_frames: m.detection_summary?.detected_frames,
        contact_window_frames: m.detection_summary?.contact_window_frames,
        contact_window_frames_prompt:
          m.detection_summary?.contact_window_frames_prompt,
      },
      correction_frame_indices: m.correction_context?.frame_indices,
      top_neighbors: topNeighbors(m),
      pose_sample_count: Array.isArray(m.pose_data) ? m.pose_data.length : 0,
    });
  }

  const sameSha =
    hashes.length === 2 && hashes[0] && hashes[1] && hashes[0] === hashes[1];

  const result = {
    same_file_sha256: sameSha,
    sha256_values: hashes.length === 2 ? hashes : hashes,
    note: sameSha
      ? "Local MP4 files are byte-identical on disk."
      : hashes.length
        ? "Could not confirm identical files (missing path or read error)."
        : "No local paths to hash.",
    analyses: out,
  };

  console.log(JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
