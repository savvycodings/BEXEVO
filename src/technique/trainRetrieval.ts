import { randomUUID } from "crypto";
import { pool, db } from "../db";
import type { TechniqueRetrievalResult, TrainPoseFrame } from "../db/schema";
import {
  embedTrainPoseSequence,
  embedPoseForProRetrieval,
  formatVectorSqlLiteral,
  POSE_EMBEDDING_DIM,
  POSE_EMBEDDING_SPEC_VERSION,
} from "./poseEmbedding";
import {
  adminStrokeLabelKey,
  RETRIEVAL_CONFIDENCE_THRESHOLD,
} from "../train/trainShotDisplay";
import { buildShotHypothesis } from "./shotHypothesis";
import {
  filterTrainNeighborsForRetrieval,
  type TrainNeighborCandidate,
} from "./trainRetrievalHygiene";

export { buildShotHypothesis } from "./shotHypothesis";

export type NeighborRow = {
  train_sample_id: string;
  train_video_id: string;
  /** Full stored name, often includes skill level suffix. */
  stroke_name: string;
  /** Admin catalog label for UI (e.g. "Drop Shot forehand"). */
  stroke_label: string;
  category: string;
  stroke_preset: string;
  skill_level: string;
  distance: number;
};

export function formatRetrievalForPrompt(r: TechniqueRetrievalResult | undefined): string {
  if (!r?.query_embedding_ok) {
    return "";
  }
  if (r.error) {
    return `\n(Pro-reference retrieval unavailable: ${r.error})\n`;
  }
  if (!r.neighbors.length) {
    return "\n(Pro-reference library has no indexed embeddings yet; infer shot from pose only.)\n";
  }
  const payload = {
    shot_hypothesis: r.shot_hypothesis,
    neighbors: r.neighbors.slice(0, 6).map((n) => ({
      stroke_label: n.stroke_label,
      stroke_name: n.stroke_name,
      category: n.category,
      stroke_preset: n.stroke_preset,
      skill_level: n.skill_level,
      distance: Math.round(n.distance * 1000) / 1000,
    })),
  };
  return `
Pro reference similarity (pose embedding ${r.spec_version}; lower distance = closer match to that labeled clip):
${JSON.stringify(payload, null, 2)}

When shot_hypothesis.confidence is at least ${RETRIEVAL_CONFIDENCE_THRESHOLD}, treat shot_hypothesis.stroke_label (admin trained shot name from the pro library) and category as the primary shot classification. Do not let stroke_preset override stroke_label — preset is legacy taxonomy metadata only. Otherwise infer the shot from the pose sequence below.
`;
}

/**
 * After train Modal finishes successfully, upsert pgvector row so technique k-NN
 * sees this pro clip without a manual POST /embeddings/backfill.
 * Never throws: failures are logged only (caller must not treat as Modal failure).
 */
export async function indexTrainSampleEmbeddingIfReady(trainSampleId: string): Promise<void> {
  try {
    const row = await db.query.trainSample.findFirst({
      where: (ts, { eq: _eq }) => _eq(ts.id, trainSampleId),
    });
    if (!row || row.status !== "completed") {
      console.log("[TrainRetrieval] auto-index skipped (sample not completed yet)", {
        trainSampleId,
        status: row?.status ?? null,
      });
      return;
    }
    const seq = row.poseSequence as unknown;
    const vec = embedTrainPoseSequence(Array.isArray(seq) ? seq : null);
    if (!vec) {
      console.log("[TrainRetrieval] auto-index skipped (no poseSequence)", { trainSampleId });
      return;
    }
    try {
      await upsertTrainSampleEmbedding(row.id, vec);
      console.log("[TrainRetrieval] auto-indexed embedding for train_sample", { trainSampleId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[TrainRetrieval] auto-index upsert failed — apply migration 0011 + vector on Neon", {
        trainSampleId,
        message: msg,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error ? e.cause : undefined;
    console.warn("[TrainRetrieval] auto-index read failed (DB schema/migration or connectivity)", {
      trainSampleId,
      message: msg,
      cause: cause instanceof Error ? cause.message : cause,
    });
  }
}

export async function upsertTrainSampleEmbedding(
  trainSampleId: string,
  vector: number[]
): Promise<void> {
  const id = randomUUID();
  const literal = formatVectorSqlLiteral(vector);
  await pool.query(
    `INSERT INTO train_sample_embedding (id, "trainSampleId", "specVersion", embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT ("trainSampleId") DO UPDATE SET
       "specVersion" = EXCLUDED."specVersion",
       embedding = EXCLUDED.embedding,
       "createdAt" = NOW()`,
    [id, trainSampleId, POSE_EMBEDDING_SPEC_VERSION, literal]
  );
}

export async function findNearestTrainNeighbors(
  queryVector: number[],
  k: number
): Promise<NeighborRow[]> {
  const literal = formatVectorSqlLiteral(queryVector);
  const fetchLimit = Math.max(k * 4, 24);
  const { rows } = await pool.query<{
    trainSampleId: string;
    trainVideoId: string;
    strokeName: string;
    strokeLabel: string | null;
    category: string;
    stroke_preset: string;
    skill_level: string;
    dist: string;
    extraction_meta: TrainNeighborCandidate["extraction_meta"];
  }>(
    `SELECT
      tse."trainSampleId" AS "trainSampleId",
      tv.id AS "trainVideoId",
      tv."strokeName" AS "strokeName",
      tv."strokeLabel" AS "strokeLabel",
      tv.category::text AS category,
      tv."strokePreset"::text AS stroke_preset,
      tv."skillLevel"::text AS skill_level,
      ts."extractionMeta" AS extraction_meta,
      (tse.embedding <=> $1::vector)::float8 AS dist
    FROM train_sample_embedding tse
    INNER JOIN train_sample ts ON ts.id = tse."trainSampleId"
    INNER JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.status = $2
      AND tse."specVersion" = $4
    ORDER BY tse.embedding <=> $1::vector
    LIMIT $3`,
    [literal, "completed", fetchLimit, POSE_EMBEDDING_SPEC_VERSION]
  );

  const mapped: TrainNeighborCandidate[] = rows.map((r) => {
    const stroke_label = adminStrokeLabelKey(r.strokeLabel, r.strokeName);
    return {
      train_sample_id: r.trainSampleId,
      train_video_id: r.trainVideoId,
      stroke_name: r.strokeName,
      stroke_label,
      category: r.category,
      stroke_preset: r.stroke_preset,
      skill_level: r.skill_level,
      distance: Number(r.dist),
      extraction_meta: r.extraction_meta ?? null,
    };
  });

  return filterTrainNeighborsForRetrieval(mapped)
    .slice(0, k)
    .map(({ extraction_meta: _em, ...rest }) => rest);
}

/** Run after migrations; safe to call repeatedly (upserts). */
export async function runTrainEmbeddingBackfill(): Promise<{
  processed: number;
  skipped: number;
  errors: number;
}> {
  const rows = await db.query.trainSample.findMany({
    where: (ts, { eq: _eq }) => _eq(ts.status, "completed"),
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const seq = row.poseSequence as unknown;
    const vec = embedTrainPoseSequence(Array.isArray(seq) ? seq : null);
    if (!vec) {
      skipped++;
      continue;
    }
    try {
      await upsertTrainSampleEmbedding(row.id, vec);
      processed++;
    } catch (e) {
      console.error("[TrainRetrieval] backfill row failed", row.id, e);
      errors++;
    }
  }

  return { processed, skipped, errors };
}

export async function retrieveForTechniqueMetrics(
  metrics: Parameters<typeof embedPoseForProRetrieval>[0],
  k = 8
): Promise<TechniqueRetrievalResult> {
  const base: TechniqueRetrievalResult = {
    spec_version: POSE_EMBEDDING_SPEC_VERSION,
    embedding_dim: POSE_EMBEDDING_DIM,
    query_embedding_ok: false,
    neighbors: [],
    shot_hypothesis: {
      stroke_preset: null,
      stroke_label: null,
      category: null,
      skill_level: null,
      confidence: 0,
    },
  };

  let query: number[] | null;
  try {
    query = embedPoseForProRetrieval(metrics);
  } catch (e) {
    console.warn("[TrainRetrieval] embedPoseForProRetrieval failed", e);
    return {
      ...base,
      query_embedding_ok: false,
      error: "embed_failed",
    };
  }

  if (!query) {
    return {
      ...base,
      query_embedding_ok: false,
      error: "no_pose_for_embedding",
    };
  }

  try {
    const neighbors = await findNearestTrainNeighbors(query, k);
    if (neighbors.length === 0) {
      console.log(
        "[TrainRetrieval] no neighbors — ensure migration 0011, CREATE EXTENSION vector, and POST /train/embeddings/backfill with completed train_sample rows"
      );
    }
    const neighbor_distance_gap =
      neighbors.length >= 2
        ? neighbors[1]!.distance - neighbors[0]!.distance
        : null;

    return {
      spec_version: POSE_EMBEDDING_SPEC_VERSION,
      embedding_dim: POSE_EMBEDDING_DIM,
      query_embedding_ok: true,
      neighbors: neighbors.map((n) => ({
        train_sample_id: n.train_sample_id,
        train_video_id: n.train_video_id,
        stroke_name: n.stroke_name,
        stroke_label: n.stroke_label,
        category: n.category,
        stroke_preset: n.stroke_preset,
        skill_level: n.skill_level,
        distance: n.distance,
      })),
      shot_hypothesis: buildShotHypothesis(neighbors),
      neighbor_distance_gap,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const code = e?.code;
    console.warn("[TrainRetrieval] nearest query failed", { msg, code });
    return {
      ...base,
      query_embedding_ok: true,
      error: msg.includes("train_sample_embedding") ? "table_or_extension_missing" : "query_failed",
    };
  }
}

/** Load Modal pose sequence for a train_sample (pro library clip). */
export async function getTrainSamplePoseSequence(
  trainSampleId: string
): Promise<TrainPoseFrame[] | null> {
  const row = await db.query.trainSample.findFirst({
    where: (ts, { eq }) => eq(ts.id, trainSampleId),
    columns: { status: true, poseSequence: true },
  });
  if (!row || row.status !== "completed") return null;
  const seq = row.poseSequence;
  if (!Array.isArray(seq) || seq.length === 0) return null;
  return seq as TrainPoseFrame[];
}

/**
 * Map user video frame index to a pro-library frame by relative position in the clip.
 * Embedding matched the whole pro sequence; this picks a comparable instant for landmark targets.
 * Uses frame_idx when present (train_modal_app) so array order matches video timeline.
 */
export function pickAlignedProPoseFrame(
  userVideoFrameIndex: number,
  videoTotalFrames: number,
  proSeq: TrainPoseFrame[]
): TrainPoseFrame | null {
  if (!proSeq.length) return null;
  const sorted = [...proSeq].sort((a, b) => a.frame_idx - b.frame_idx);
  const tf = Math.max(1, videoTotalFrames);
  const t = Math.max(0, Math.min(1, userVideoFrameIndex / Math.max(1, tf - 1)));
  const proMaxIdx = sorted[sorted.length - 1]?.frame_idx ?? sorted.length - 1;
  const targetProIdx = Math.round(t * Math.max(0, proMaxIdx));

  let best = sorted[0]!;
  let bestD = Math.abs(best.frame_idx - targetProIdx);
  for (const row of sorted) {
    const d = Math.abs(row.frame_idx - targetProIdx);
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  return best;
}

/** Frame indices to try when extracting a pro-library still (pose frame_idx may exceed video length). */
export function proReferenceFrameCandidates(
  userVideoFrameIndex: number,
  videoTotalFrames: number,
  proSeq: TrainPoseFrame[]
): number[] {
  if (!proSeq.length) return [];
  const sorted = [...proSeq].sort((a, b) => a.frame_idx - b.frame_idx);
  const tf = Math.max(1, videoTotalFrames);
  const t = Math.max(0, Math.min(1, userVideoFrameIndex / Math.max(1, tf - 1)));
  const ordinal = Math.round(t * Math.max(0, sorted.length - 1));
  const rows = [
    sorted[ordinal],
    sorted[Math.max(0, ordinal - 1)],
    sorted[Math.min(sorted.length - 1, ordinal + 1)],
    sorted[sorted.length - 1],
    sorted[0],
  ].filter((r): r is TrainPoseFrame => !!r);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const idx = row.frame_idx;
    if (typeof idx === "number" && idx >= 0 && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

/** Relative position in user clip (0–1) for pro still extraction ratio fallback. */
export function proTimelineRatioForUserFrame(
  userVideoFrameIndex: number,
  videoTotalFrames: number
): number {
  const tf = Math.max(1, videoTotalFrames);
  return Math.max(0, Math.min(1, userVideoFrameIndex / Math.max(1, tf - 1)));
}
