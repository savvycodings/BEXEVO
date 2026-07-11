/**
 * Sanity-check k-NN retrieval against newly uploaded train samples.
 * Builds technique-style metrics from a completed train_sample and runs retrieveForTechniqueMetrics.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db";
import { retrieveForTechniqueMetrics } from "../src/technique/trainRetrieval";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XEVO_ROOT = path.resolve(__dirname, "../..");
const OUT_JSON = path.resolve(XEVO_ROOT, "shots-retrieval-verify.json");

type SampleRow = {
  id: string;
  stroke_label: string;
  stroke_name: string;
  category: string;
  stroke_preset: string;
  pose_sequence: unknown;
  extraction_meta: Record<string, unknown> | null;
  frame_count: number | null;
  total_frames: number | null;
};

function trainPoseToTechniqueMetrics(row: SampleRow): Record<string, unknown> {
  const seq = Array.isArray(row.pose_sequence) ? row.pose_sequence : [];
  const pose_data = seq
    .filter((r) => r && typeof r === "object" && (r as { landmarks?: unknown }).landmarks)
    .map((r) => {
      const fr = r as { frame_idx?: number; frame?: number; landmarks: Record<string, unknown> };
      const frame =
        typeof fr.frame_idx === "number"
          ? fr.frame_idx
          : typeof fr.frame === "number"
            ? fr.frame
            : 0;
      return { frame, landmarks: fr.landmarks };
    });

  const meta = row.extraction_meta ?? {};
  const impact =
    typeof meta.impact_frame_resolved === "number" ? meta.impact_frame_resolved : undefined;

  return {
    pose_data,
    impact_frame_resolved: impact,
    total_frames: row.total_frames ?? row.frame_count ?? pose_data.length,
    video_duration_ms: 3000,
    pose_enrichment: meta.pose_enrichment ?? undefined,
    detection_summary: meta.yolo_summary ?? undefined,
  };
}

async function verifySample(row: SampleRow) {
  const metrics = trainPoseToTechniqueMetrics(row);
  const retrieval = await retrieveForTechniqueMetrics(metrics);
  const top = retrieval.neighbors[0];
  const labelMatch =
    top?.stroke_label?.trim().toLowerCase() === row.stroke_label?.trim().toLowerCase();
  return {
    sampleId: row.id,
    expectedLabel: row.stroke_label,
    expectedCategory: row.category,
    query_embedding_ok: retrieval.query_embedding_ok,
    embedding_source: retrieval.embedding_source,
    neighbor_count: retrieval.neighbors.length,
    shot_hypothesis: retrieval.shot_hypothesis,
    top_neighbor: top
      ? {
          train_sample_id: top.train_sample_id,
          stroke_label: top.stroke_label,
          stroke_name: top.stroke_name,
          category: top.category,
          distance: Math.round(top.distance * 1000) / 1000,
        }
      : null,
    label_match_top_neighbor: labelMatch,
    neighbors_preview: retrieval.neighbors.slice(0, 5).map((n) => ({
      stroke_label: n.stroke_label,
      distance: Math.round(n.distance * 1000) / 1000,
    })),
  };
}

async function main() {
  const sampleArg = process.argv.find((a) => a.startsWith("--sample="))?.split("=")[1];

  const { rows } = await pool.query<SampleRow>(
    sampleArg
      ? `SELECT ts.id, tv."strokeLabel" AS stroke_label, tv."strokeName" AS stroke_name,
                tv.category, tv."strokePreset" AS stroke_preset,
                ts."poseSequence" AS pose_sequence, ts."extractionMeta" AS extraction_meta,
                ts."frameCount" AS frame_count, ts."totalFrames" AS total_frames
         FROM train_sample ts
         JOIN train_video tv ON tv.id = ts."trainVideoId"
         WHERE ts.id = $1 AND ts.status = 'completed'`
      : `SELECT ts.id, tv."strokeLabel" AS stroke_label, tv."strokeName" AS stroke_name,
                tv.category, tv."strokePreset" AS stroke_preset,
                ts."poseSequence" AS pose_sequence, ts."extractionMeta" AS extraction_meta,
                ts."frameCount" AS frame_count, ts."totalFrames" AS total_frames
         FROM train_sample ts
         JOIN train_video tv ON tv.id = ts."trainVideoId"
         WHERE ts.status = 'completed'
           AND tv."strokeLabel" IN ('Forehand Volley', 'Backhand Drive', 'Flat Serve')
           AND tv."skillLevel" = 'intermediate'
         ORDER BY ts."updatedAt" DESC
         LIMIT 3`,
    sampleArg ? [sampleArg] : []
  );

  if (!rows.length) {
    console.error("No completed train samples found for verification.");
    process.exit(1);
  }

  const results = [];
  for (const row of rows) {
    console.log(`Verifying retrieval for ${row.stroke_label} (${row.id})…`);
    results.push(await verifySample(row));
  }

  const payload = {
    verifiedAt: new Date().toISOString(),
    samples_tested: results.length,
    all_top_label_match: results.every((r) => r.label_match_top_neighbor),
    results,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");
  console.log("\n", JSON.stringify(payload, null, 2));
  console.log("\nWrote", OUT_JSON);

  await pool.end();
  if (!payload.all_top_label_match) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
