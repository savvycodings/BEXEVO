/**
 * Sanity audit: all intermediate batch uploads (52 shots) — pose, mesh, embeddings.
 * Usage: pnpm exec tsx scripts/audit-shots-upload.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db";
import { retrieveForTechniqueMetrics } from "../src/technique/trainRetrieval";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XEVO_ROOT = path.resolve(__dirname, "../..");
const OUT = path.resolve(XEVO_ROOT, "shots-upload-audit.json");

type Row = {
  sample_id: string;
  stroke_label: string;
  view_profile: string;
  category: string;
  status: string;
  pose_seq_len: number;
  impact_frame: number | null;
  mesh_frames: number;
  emb_v2: number;
  emb_sam: number;
};

async function main() {
  const { rows: summary } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE ts.status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE ts.status = 'failed')::int AS failed,
      COUNT(*)::int AS total_samples
    FROM train_sample ts
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE tv."skillLevel" = 'intermediate'
      AND ts."createdAt" >= '2026-07-11'::date
  `);

  const { rows } = await pool.query<Row>(`
  SELECT
    ts.id AS sample_id,
    tv."strokeLabel" AS stroke_label,
    tvp."viewProfile" AS view_profile,
    tv.category,
    ts.status,
    COALESCE(jsonb_array_length(ts."poseSequence"), 0)::int AS pose_seq_len,
    NULLIF(ts."extractionMeta"->>'impact_frame_resolved', '')::int AS impact_frame,
    COALESCE(jsonb_array_length(ts."extractionMeta"->'pose_enrichment'->'frames'), 0)::int AS mesh_frames,
    COALESCE(emb.v2, 0)::int AS emb_v2,
    COALESCE(emb.sam, 0)::int AS emb_sam
  FROM train_sample ts
  JOIN train_video tv ON tv.id = ts."trainVideoId"
  LEFT JOIN train_video_view_profile tvp ON tvp."trainVideoId" = tv.id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE "specVersion" = 'v2') AS v2,
      COUNT(*) FILTER (WHERE "specVersion" = 'sam_v1') AS sam
    FROM train_sample_embedding tse
    WHERE tse."trainSampleId" = ts.id
  ) emb ON true
  WHERE tv."skillLevel" = 'intermediate'
    AND ts."createdAt" >= '2026-07-11'::date
  ORDER BY tv."strokeLabel", tvp."viewProfile", ts."updatedAt" DESC
  `);

  const { rows: embTotals } = await pool.query(`
    SELECT tse."specVersion", COUNT(*)::int AS rows
    FROM train_sample_embedding tse
    JOIN train_sample ts ON ts.id = tse."trainSampleId"
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE tv."skillLevel" = 'intermediate'
      AND ts."createdAt" >= '2026-07-11'::date
      AND ts.status = 'completed'
    GROUP BY tse."specVersion"
  `);

  const issues = rows.filter(
    (r) =>
      r.status !== "completed" ||
      r.pose_seq_len < 10 ||
      r.emb_v2 < 1
  );

  // Unique shot×view combos (latest completed sample per combo)
  const comboMap = new Map<string, Row>();
  for (const r of rows) {
    if (r.status !== "completed") continue;
    const key = `${r.stroke_label}|${r.view_profile}`;
    if (!comboMap.has(key)) comboMap.set(key, r);
  }

  // Retrieval smoke test on one sample per category
  const retrievalTests: Record<string, unknown>[] = [];
  const testIds = [...comboMap.values()].slice(0, 5).map((r) => r.sample_id);
  for (const sid of testIds) {
    const { rows: srows } = await pool.query(
      `SELECT ts.id, tv."strokeLabel" AS stroke_label, ts."poseSequence", ts."extractionMeta",
              ts."frameCount", ts."totalFrames"
       FROM train_sample ts
       JOIN train_video tv ON tv.id = ts."trainVideoId"
       WHERE ts.id = $1`,
      [sid]
    );
    const s = srows[0];
    if (!s) continue;
    const seq = Array.isArray(s.poseSequence) ? s.poseSequence : [];
    const meta = (s.extractionMeta ?? {}) as Record<string, unknown>;
    const pose_data = seq
      .filter((fr: { landmarks?: unknown }) => fr?.landmarks)
      .map((fr: { frame_idx?: number; frame?: number; landmarks: Record<string, unknown> }) => ({
        frame: fr.frame_idx ?? fr.frame ?? 0,
        landmarks: fr.landmarks,
      }));
    const metrics = {
      pose_data,
      impact_frame_resolved: meta.impact_frame_resolved,
      total_frames: s.totalFrames ?? s.frameCount ?? pose_data.length,
      video_duration_ms: 3000,
      pose_enrichment: meta.pose_enrichment,
    };
    const retrieval = await retrieveForTechniqueMetrics(metrics);
    retrievalTests.push({
      sampleId: sid,
      expected: s.stroke_label,
      top_label: retrieval.neighbors[0]?.stroke_label ?? null,
      top_distance: retrieval.neighbors[0]?.distance ?? null,
      hypothesis: retrieval.shot_hypothesis?.stroke_label,
      hypothesis_conf: retrieval.shot_hypothesis?.confidence,
      neighbor_count: retrieval.neighbors.length,
      match: retrieval.neighbors[0]?.stroke_label === s.stroke_label,
    });
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(XEVO_ROOT, "shots-upload-manifest.json"), "utf8")
  );
  const expectedCombos = new Set(
    (manifest.entries as { strokeLabel: string; viewProfile: string }[]).map(
      (e) => `${e.strokeLabel}|${e.viewProfile}`
    )
  );
  const gotCombos = new Set([...comboMap.keys()]);
  const missingCombos = [...expectedCombos].filter((k) => !gotCombos.has(k));

  const payload = {
    auditedAt: new Date().toISOString(),
    manifest_clips: manifest.entries.length,
    summary: summary[0],
    unique_shot_view_combos: comboMap.size,
    expected_combos_from_manifest: expectedCombos.size,
    missing_combos: missingCombos,
    embedding_totals: embTotals,
    issues_count: issues.length,
    issues,
    retrieval_smoke_tests: retrievalTests,
    all_retrieval_match: retrievalTests.every((t) => t.match),
    samples: rows,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({
    summary: payload.summary,
    unique_combos: payload.unique_shot_view_combos,
    expected: payload.expected_combos_from_manifest,
    missing: payload.missing_combos,
    emb: payload.embedding_totals,
    issues: payload.issues_count,
    retrieval_ok: payload.all_retrieval_match,
    out: OUT,
  }, null, 2));

  await pool.end();
  if (issues.length > 0 || missingCombos.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
