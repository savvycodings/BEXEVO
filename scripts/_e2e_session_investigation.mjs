/**
 * E2E session investigation: pull full retrieval/impact/ensemble metrics for recent
 * or explicit analysis IDs. Writes server/scripts/_e2e_session_investigation.json
 *
 * Usage:
 *   pnpm exec tsx scripts/_e2e_session_investigation.mjs
 *   ANALYSIS_IDS=id1,id2 pnpm exec tsx scripts/_e2e_session_investigation.mjs
 *   LIMIT=5 pnpm exec tsx scripts/_e2e_session_investigation.mjs
 */
import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { withNeonRetry, createPool } from "./_neon_retry.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIMIT = Number(process.env.LIMIT ?? 5);
const EXPLICIT_IDS = (process.env.ANALYSIS_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const pool = createPool(pg, process.env.DATABASE_URL);

function pickHyp(h) {
  if (!h || typeof h !== "object") return null;
  return {
    stroke_label: h.stroke_label ?? null,
    stroke_preset: h.stroke_preset ?? null,
    category: h.category ?? null,
    skill_level: h.skill_level ?? null,
    confidence:
      typeof h.confidence === "number" ? h.confidence : Number(h.confidence) || null,
  };
}

function summarizeAnalysis(row, tv) {
  const m = row.metrics ?? {};
  const r = m.retrieval ?? {};
  const evalSnap = r.eval ?? null;
  const neighbors = Array.isArray(r.neighbors) ? r.neighbors : [];

  return {
    analysis_id: row.id,
    createdAt: row.createdAt,
    techniqueVideoId: row.techniqueVideoId,
    userId: row.userId,
    video: tv
      ? {
          bytes: tv.bytes ?? null,
          format: tv.format ?? null,
          cloudinaryPublicId: tv.cloudinaryPublicId ?? null,
        }
      : null,
    user_clips: m.user_clips ?? null,
    video_duration_ms: m.video_duration_ms ?? null,
    total_frames: m.total_frames ?? null,
    impact_frame_resolved: m.impact_frame_resolved ?? null,
    impact_frame_source: m.impact_frame_source ?? null,
    yolo_contacts: m.detection_summary?.contact_window_frames?.slice?.(0, 16) ?? null,
    pose_enrichment_frame_count: m.pose_enrichment?.frames?.length ?? 0,
    retrieval: {
      query_embedding_ok: r.query_embedding_ok ?? false,
      spec_version: r.spec_version ?? null,
      embedding_source: r.embedding_source ?? null,
      mesh_used: r.mesh_used ?? null,
      mesh_confidence: r.mesh_confidence ?? null,
      neighbor_distance_gap: r.neighbor_distance_gap ?? null,
      shot_hypothesis: pickHyp(r.shot_hypothesis),
      pose_hypothesis: pickHyp(r.pose_hypothesis),
      mesh_hypothesis: pickHyp(r.mesh_hypothesis),
      channel_agreement: r.channel_agreement ?? null,
      frames_used: r.frames_used ?? null,
      eval: evalSnap,
      top_neighbors: neighbors.slice(0, 8).map((n) => ({
        train_sample_id: n.train_sample_id,
        train_video_id: n.train_video_id,
        stroke_label: n.stroke_label,
        stroke_preset: n.stroke_preset,
        category: n.category,
        distance: typeof n.distance === "number" ? Math.round(n.distance * 10000) / 10000 : n.distance,
      })),
    },
    ai_score: m.ai_analysis?.score ?? null,
    llm_shot_context: m.ai_analysis?.en?.shot_context?.slice?.(0, 240) ?? null,
    correction_shot: m.correction_context?.shot_and_handedness?.shot?.shot_name ?? null,
  };
}

async function libraryHealth(client) {
  const emb = await client.query(`
    SELECT "specVersion", COUNT(*)::int AS rows,
           COUNT(DISTINCT "trainSampleId")::int AS samples,
           COUNT(DISTINCT "frameIndex") FILTER (WHERE "frameIndex" > 0)::int AS rows_with_multi_frame
    FROM train_sample_embedding
    GROUP BY 1 ORDER BY 1
  `);

  const hasFrameIndex = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'train_sample_embedding' AND column_name = 'frameIndex'
    ) AS ok
  `);

  const trainSamples = await client.query(`
    SELECT ts.id AS train_sample_id, ts."createdAt", ts.status,
           ts."frameCount", ts."totalFrames",
           tv.id AS train_video_id, tv."strokeLabel", tv."strokeName",
           (ts."extractionMeta"->'sampler'->>'stride') AS stride,
           (ts."extractionMeta"->>'impact_frame_resolved') AS impact_frame_resolved,
           (jsonb_array_length(COALESCE(ts."extractionMeta"->'pose_enrichment'->'frames', '[]'::jsonb)))::int AS mesh_frames
    FROM train_sample ts
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.status = 'completed'
    ORDER BY ts."createdAt" DESC
    LIMIT 15
  `);

  const perSampleEmb = await client.query(`
    SELECT tse."trainSampleId", tse."specVersion", COUNT(*)::int AS frame_rows
    FROM train_sample_embedding tse
    GROUP BY 1, 2
    ORDER BY frame_rows DESC
    LIMIT 20
  `);

  return {
    frameIndex_column: hasFrameIndex.rows[0]?.ok ?? false,
    embedding_counts: emb.rows,
    latest_train_samples: trainSamples.rows,
    top_per_sample_frame_rows: perSampleEmb.rows,
  };
}

async function neighborTrainLookup(client, trainSampleIds) {
  if (!trainSampleIds.length) return [];
  const { rows } = await client.query(
    `
    SELECT ts.id AS train_sample_id, tv."strokeLabel", tv."strokeName",
           ts."createdAt", ts."totalFrames",
           (ts."extractionMeta"->'sampler'->>'stride') AS stride
    FROM train_sample ts
    JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.id = ANY($1::text[])
    `,
    [trainSampleIds]
  );
  return rows;
}

async function main() {
  const out = await withNeonRetry(async () => {
    const client = await pool.connect();
    try {
      const library = await libraryHealth(client);

      let analyses;
      if (EXPLICIT_IDS.length) {
        const { rows } = await client.query(
          `SELECT * FROM technique_analysis WHERE id = ANY($1::text[]) ORDER BY "createdAt" ASC`,
          [EXPLICIT_IDS]
        );
        analyses = rows;
      } else {
        const { rows } = await client.query(
          `SELECT * FROM technique_analysis WHERE status = 'completed'
           ORDER BY "createdAt" DESC LIMIT $1`,
          [LIMIT]
        );
        analyses = rows.reverse(); // chronological ASC for submission 1..N
      }

      const videoIds = analyses.map((a) => a.techniqueVideoId).filter(Boolean);
      const videosById = new Map();
      if (videoIds.length) {
        const { rows: vids } = await client.query(
          `SELECT id, bytes, format, "cloudinaryPublicId", "secureUrl" FROM technique_video WHERE id = ANY($1::text[])`,
          [videoIds]
        );
        for (const v of vids) videosById.set(v.id, v);
      }

      const submissions = analyses.map((a) =>
        summarizeAnalysis(a, videosById.get(a.techniqueVideoId))
      );

      const allNeighborIds = [
        ...new Set(
          submissions.flatMap((s) =>
            (s.retrieval.top_neighbors ?? []).map((n) => n.train_sample_id).filter(Boolean)
          )
        ),
      ];
      const neighborTrain = await neighborTrainLookup(client, allNeighborIds);

      return {
        queried_at: new Date().toISOString(),
        retrieval_mode_env: process.env.RETRIEVAL_EMBEDDING_MODE ?? null,
        library,
        submissions,
        neighbor_train_samples: neighborTrain,
      };
    } finally {
      client.release();
    }
  });

  const outPath = path.join(__dirname, "_e2e_session_investigation.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
