/**
 * Compare MediaPipe landmarks + mesh enrichment for submission C vs pro library train clips.
 * Writes server/scripts/_e2e_pose_mesh_compare.json
 *
 * Usage:
 *   pnpm exec tsx scripts/_e2e_pose_mesh_compare.mjs
 *   ANALYSIS_ID=039a239c-... TRAIN_SAMPLE_ID=4132cf12-... pnpm exec tsx scripts/_e2e_pose_mesh_compare.mjs
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { withNeonRetry, createPool } from "./_neon_retry.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_ID =
  process.env.ANALYSIS_ID ?? "039a239c-662e-4423-aeab-49dd083a1720";
const RETURN_TRAIN =
  process.env.TRAIN_SAMPLE_ID ?? "4132cf12-613e-4bad-8f81-517b39e6f29c";
const VOLLEY_TRAIN =
  process.env.VOLLEY_TRAIN_ID ?? "31950f20-dfe8-49c8-a7d7-412604c48a4f";

const KEY_JOINTS = [
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_ELBOW",
  "RIGHT_ELBOW",
  "LEFT_WRIST",
  "RIGHT_WRIST",
  "LEFT_HIP",
  "RIGHT_HIP",
];

function pickKeyLandmarks(lm) {
  if (!lm || typeof lm !== "object") return null;
  const out = {};
  for (const name of KEY_JOINTS) {
    const p = lm[name];
    if (p && typeof p.x === "number" && typeof p.y === "number") {
      out[name] = {
        x: Math.round(p.x * 1000) / 1000,
        y: Math.round(p.y * 1000) / 1000,
        z: typeof p.z === "number" ? Math.round(p.z * 1000) / 1000 : undefined,
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

function landmarksAtFrame(poseData, frame) {
  if (!Array.isArray(poseData)) return null;
  const row = poseData.find((p) => p.frame === frame);
  return row?.landmarks ?? null;
}

function summarizeMeshFrames(poseEnrichment) {
  const frames = poseEnrichment?.frames;
  if (!Array.isArray(frames)) return { count: 0, frames: [] };
  return {
    count: frames.length,
    provider: poseEnrichment.provider ?? null,
    spec_version: poseEnrichment.spec_version ?? null,
    frames: frames.map((f) => ({
      frame: f.frame ?? null,
      mesh_confidence:
        typeof f.mesh_confidence === "number"
          ? Math.round(f.mesh_confidence * 1000) / 1000
          : null,
      has_feature_vector: Array.isArray(f.feature_vector) && f.feature_vector.length > 0,
      has_landmarks_3d:
        f.landmarks_3d && typeof f.landmarks_3d === "object"
          ? Object.keys(f.landmarks_3d).length
          : 0,
    })),
  };
}

function summarizeImpactSequence(seq) {
  if (!Array.isArray(seq)) return null;
  return seq.map((p) => ({
    phase: p.phase,
    frame: p.frame,
    key_landmarks: pickKeyLandmarks(p.landmarks),
  }));
}

function cosineDistance(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-12) return null;
  return 1 - dot / denom;
}

async function loadAnalysis(client, id) {
  const { rows } = await client.query(
    `SELECT ta.id, ta.metrics, tv.bytes, tv."cloudinaryPublicId"
     FROM technique_analysis ta
     JOIN technique_video tv ON tv.id = ta."techniqueVideoId"
     WHERE ta.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

async function loadTrainSample(client, trainSampleId) {
  const { rows } = await client.query(
    `SELECT ts.id, ts."poseSequence", ts."extractionMeta", ts."totalFrames",
            tv."strokeLabel", tv.bytes AS train_video_bytes
     FROM train_sample ts
     JOIN train_video tv ON tv.id = ts."trainVideoId"
     WHERE ts.id = $1`,
    [trainSampleId]
  );
  return rows[0] ?? null;
}

async function loadEmbeddingFrameDistances(client, trainSampleId, specVersion, limit = 5) {
  const { rows } = await client.query(
    `SELECT "frameIndex", "meshConfidence",
            embedding <=> (
              SELECT embedding FROM train_sample_embedding e2
              WHERE e2."trainSampleId" = $1 AND e2."specVersion" = $2
              ORDER BY "frameIndex" ASC LIMIT 1
            ) AS self_dist
     FROM train_sample_embedding
     WHERE "trainSampleId" = $1 AND "specVersion" = $2
     ORDER BY "frameIndex" ASC
     LIMIT $3`,
    [trainSampleId, specVersion, limit]
  );
  return rows;
}

function summarizeTechniqueSide(row, { landmarksToEmbeddingVector, meshProxyFeatureVector }) {
  const m = row.metrics ?? {};
  const impact = m.impact_frame_resolved ?? null;
  const impactLm =
    landmarksAtFrame(m.pose_data, impact) ??
    m.impact_pose_sequence?.find((p) => p.phase === "impact")?.landmarks ??
    null;

  let poseVecAtImpact = null;
  let meshVecFromMpProxy = null;
  if (impactLm && landmarksToEmbeddingVector) {
    poseVecAtImpact = landmarksToEmbeddingVector(impactLm);
    if (meshProxyFeatureVector) meshVecFromMpProxy = meshProxyFeatureVector(impactLm);
  }

  const meshAtImpact =
    m.pose_enrichment?.frames?.find((f) => f.frame === impact) ?? null;

  return {
    analysis_id: row.id,
    video_bytes: row.bytes,
    total_frames: m.total_frames ?? null,
    pose_data_frame_count: Array.isArray(m.pose_data) ? m.pose_data.length : 0,
    impact_frame_resolved: impact,
    impact_frame_source: m.impact_frame_source ?? null,
    user_clips: m.user_clips ?? null,
    yolo_contact_count: m.detection_summary?.contact_window_frames?.length ?? 0,
    impact_key_landmarks: pickKeyLandmarks(impactLm),
    impact_pose_sequence: summarizeImpactSequence(m.impact_pose_sequence),
    pose_enrichment: summarizeMeshFrames(m.pose_enrichment),
    mesh_at_impact: meshAtImpact
      ? {
          frame: meshAtImpact.frame,
          mesh_confidence: meshAtImpact.mesh_confidence ?? null,
          has_feature_vector: Array.isArray(meshAtImpact.feature_vector),
        }
      : null,
    retrieval: {
      embedding_source: m.retrieval?.embedding_source ?? null,
      frames_used: m.retrieval?.frames_used ?? null,
      top_neighbors: (m.retrieval?.neighbors ?? []).slice(0, 3).map((n) => ({
        stroke_label: n.stroke_label,
        distance: n.distance,
        train_sample_id: n.train_sample_id,
      })),
    },
    _computed: {
      pose_embedding_dim: poseVecAtImpact?.length ?? null,
      mesh_proxy_from_mp_at_impact_dim: meshVecFromMpProxy?.length ?? null,
    },
  };
}

function summarizeTrainSide(row, { landmarksToEmbeddingVector, meshProxyFeatureVector }) {
  const meta = row.extractionMeta ?? {};
  const impact =
    typeof meta.impact_frame_resolved === "number"
      ? meta.impact_frame_resolved
      : typeof meta.impact_frame_resolved === "string"
        ? Number(meta.impact_frame_resolved)
        : null;

  const poseSeq = Array.isArray(row.poseSequence) ? row.poseSequence : [];
  const impactRow =
    poseSeq.find((p) => (p.frame_idx ?? p.frame) === impact) ??
    poseSeq[poseSeq.length - 1] ??
    null;
  const impactLm = impactRow?.landmarks ?? null;

  let poseVec = null;
  if (impactLm && landmarksToEmbeddingVector) {
    poseVec = landmarksToEmbeddingVector(impactLm);
  }

  const meshFrame =
    meta.pose_enrichment?.frames?.find((f) => f.frame === impact) ??
    meta.pose_enrichment?.frames?.[0] ??
    null;

  return {
    train_sample_id: row.id,
    stroke_label: row.strokeLabel,
    train_video_bytes: row.train_video_bytes,
    total_frames: row.totalFrames,
    pose_sequence_frames: poseSeq.length,
    impact_frame_resolved: impact,
    stride: meta.sampler?.stride ?? null,
    impact_key_landmarks: pickKeyLandmarks(impactLm),
    pose_enrichment: summarizeMeshFrames(meta.pose_enrichment),
    mesh_at_impact: meshFrame
      ? {
          frame: meshFrame.frame,
          mesh_confidence: meshFrame.mesh_confidence ?? null,
          has_feature_vector: Array.isArray(meshFrame.feature_vector),
        }
      : null,
    _computed: {
      pose_embedding_dim: poseVec?.length ?? null,
    },
  };
}

async function compareEmbeddings(client, techniqueSummary, trainSummary, imports) {
  const { landmarksToEmbeddingVector } = imports;
  const analysisRow = await loadAnalysis(client, ANALYSIS_ID);
  const m = analysisRow?.metrics ?? {};
  const impact = m.impact_frame_resolved;
  const queryLm =
    landmarksAtFrame(m.pose_data, impact) ??
    m.impact_pose_sequence?.find((p) => p.phase === "impact")?.landmarks;
  if (!queryLm || !landmarksToEmbeddingVector) {
    return { note: "missing query landmarks at impact" };
  }
  const queryVec = landmarksToEmbeddingVector(queryLm);

  const comparisons = [];
  for (const trainId of [RETURN_TRAIN, VOLLEY_TRAIN]) {
    const train = await loadTrainSample(client, trainId);
    const ts = summarizeTrainSide(train, imports);
    const meta = train.extractionMeta ?? {};
    const trainImpact =
      typeof meta.impact_frame_resolved === "number"
        ? meta.impact_frame_resolved
        : Number(meta.impact_frame_resolved);
    const poseSeq = train.poseSequence ?? [];
    const trainRow =
      poseSeq.find((p) => (p.frame_idx ?? p.frame) === trainImpact) ??
      poseSeq[poseSeq.length - 1];
    const trainLm = trainRow?.landmarks;
    if (!trainLm) {
      comparisons.push({ train_sample_id: trainId, error: "no train landmarks at impact" });
      continue;
    }
    const trainVec = landmarksToEmbeddingVector(trainLm);
    comparisons.push({
      train_sample_id: trainId,
      stroke_label: train.strokeLabel,
      pose_cosine_distance_at_impact: cosineDistance(queryVec, trainVec),
      query_impact_frame: impact,
      train_impact_frame: trainImpact,
    });

    const meshQueryFrame = m.pose_enrichment?.frames?.find((f) => f.frame === impact);
    const meshTrainFrame = meta.pose_enrichment?.frames?.find((f) => f.frame === trainImpact);
    if (meshQueryFrame?.feature_vector && meshTrainFrame?.feature_vector) {
      comparisons.push({
        train_sample_id: trainId,
        mesh_cosine_distance_at_impact: cosineDistance(
          meshQueryFrame.feature_vector,
          meshTrainFrame.feature_vector
        ),
      });
    }
  }
  return comparisons;
}

async function main() {
  const { landmarksToEmbeddingVector } = await import("../src/technique/poseEmbedding.ts");
  const { meshProxyFeatureVector } = await import("../src/technique/meshEmbedding.ts");
  const imports = { landmarksToEmbeddingVector, meshProxyFeatureVector };

  const pool = createPool(pg, process.env.DATABASE_URL);

  const out = await withNeonRetry(async () => {
    const client = await pool.connect();
    try {
      const analysisRow = await loadAnalysis(client, ANALYSIS_ID);
      if (!analysisRow) throw new Error(`Analysis not found: ${ANALYSIS_ID}`);

      const returnTrain = await loadTrainSample(client, RETURN_TRAIN);
      const volleyTrain = await loadTrainSample(client, VOLLEY_TRAIN);

      const technique = summarizeTechniqueSide(analysisRow, imports);
      const trainReturn = summarizeTrainSide(returnTrain, imports);
      const trainVolley = summarizeTrainSide(volleyTrain, imports);
      const embeddingComparisons = await compareEmbeddings(
        client,
        technique,
        trainReturn,
        imports
      );

      return {
        queried_at: new Date().toISOString(),
        analysis_id: ANALYSIS_ID,
        technique_upload: technique,
        pro_library: {
          forehand_return: trainReturn,
          forehand_volley: trainVolley,
        },
        landmark_embedding_comparison: embeddingComparisons,
        interpretation: {
          closer_pose_match:
            embeddingComparisons
              .filter((c) => typeof c.pose_cosine_distance_at_impact === "number")
              .sort((a, b) => a.pose_cosine_distance_at_impact - b.pose_cosine_distance_at_impact)[0]
              ?.stroke_label ?? null,
          note:
            "Lower pose_cosine_distance = more similar MediaPipe body pose at impact. Retrieval uses 10-frame ensemble, not single impact frame alone.",
        },
      };
    } finally {
      client.release();
    }
  });

  const outPath = path.join(__dirname, "_e2e_pose_mesh_compare.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
