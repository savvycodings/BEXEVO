/**
 * Re-run v9 retrieval + clip-local YOLO on stored metrics (no Modal re-upload).
 * Use when technique videos live on remote disk (Railway paths) but Neon rows are local-dev accessible.
 */
import "dotenv/config";
import { pool } from "../src/db";
import { retrieveForTechniqueMetrics } from "../src/technique/trainRetrieval";
import { attachClipLocalContactFrames } from "../src/technique/yoloContactHints";
import type { TechniqueDetectionSummary } from "../src/db/schema";
import { deriveHumanShotLabelFromMetrics } from "../src/train/trainShotDisplay";
import fs from "fs";

const CASE_IDS = [
  "0d7313a7-b9ca-41ea-91ca-b9dc59775905",
  "ee64a055-068e-4d43-a555-452f977f0d58",
  "5a3c3f89-d5ef-44c5-902e-ca58468dabe3",
  "6534b76c-d6f3-46f5-a91c-ce9ad4ee465e",
];

async function main() {
  const results: Record<string, unknown>[] = [];

  for (const id of CASE_IDS) {
    const { rows } = await pool.query(
      `SELECT id, metrics FROM technique_analysis WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    if (!row?.metrics) {
      results.push({ id, error: "not_found" });
      continue;
    }

    const metrics = row.metrics as Record<string, unknown>;
    const retrieval = await retrieveForTechniqueMetrics(metrics);
    metrics.retrieval = retrieval;

    const det = metrics.detection_summary as TechniqueDetectionSummary | undefined;
    if (det) {
      metrics.detection_summary = attachClipLocalContactFrames(det, {
        total_frames: metrics.total_frames as number | undefined,
        video_duration_ms: metrics.video_duration_ms as number | undefined,
        user_clips: metrics.user_clips as { startMs: number; endMs: number }[] | undefined,
        impact_pose_sequence: metrics.impact_pose_sequence as
          | { phase: string; frame: number }[]
          | undefined,
      });
    }

    await pool.query(
      `UPDATE technique_analysis SET metrics = $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(metrics)]
    );

    const hyp = retrieval.shot_hypothesis;
    const neighbors = retrieval.neighbors;
    const top = neighbors[0];
    results.push({
      id,
      spec_version: retrieval.spec_version,
      neighbor_count: neighbors.length,
      shotLabel: deriveHumanShotLabelFromMetrics(metrics),
      hyp_label: hyp.stroke_label,
      hyp_preset: hyp.stroke_preset,
      hyp_conf: hyp.confidence,
      contact_prompt:
        (metrics.detection_summary as TechniqueDetectionSummary)
          ?.contact_window_frames_prompt ?? null,
      contact_raw:
        (metrics.detection_summary as TechniqueDetectionSummary)
          ?.contact_window_frames ?? null,
      preset_label_split:
        top &&
        hyp.stroke_preset === top.stroke_preset &&
        top.stroke_label?.trim() !== hyp.stroke_label?.trim(),
    });
  }

  const out = new URL("./_reprocess_v9_results.json", import.meta.url);
  fs.writeFileSync(out, JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify({ results }, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
