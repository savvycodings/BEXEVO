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

export type NeighborRow = {
  train_sample_id: string;
  train_video_id: string;
  stroke_name: string;
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

When shot_hypothesis.confidence is at least 0.35, treat stroke_preset and category as the primary shot classification (map to clear padel shot names for the user). Otherwise infer the shot from the pose sequence below.
`;
}

export function buildShotHypothesis(
  neighbors: NeighborRow[]
): TechniqueRetrievalResult["shot_hypothesis"] {
  if (neighbors.length === 0) {
    return {
      stroke_preset: null,
      category: null,
      skill_level: null,
      confidence: 0,
    };
  }

  const byPreset = new Map<
    string,
    { w: number; category: string; skill_level: string }
  >();
  for (const n of neighbors) {
    const add = 1 / (n.distance + 0.03);
    const cur = byPreset.get(n.stroke_preset);
    if (cur) {
      cur.w += add;
    } else {
      byPreset.set(n.stroke_preset, {
        w: add,
        category: n.category,
        skill_level: n.skill_level,
      });
    }
  }

  const sorted = [...byPreset.entries()].sort((a, b) => b[1].w - a[1].w);
  const top = sorted[0];
  const second = sorted[1];
  let confidence: number;
  if (second) {
    confidence = Math.max(
      0,
      Math.min(1, (top[1].w - second[1].w) / (top[1].w + 1e-6))
    );
  } else {
    confidence = Math.max(0, Math.min(1, 1 - neighbors[0].distance / 0.45));
  }

  return {
    stroke_preset: top[0],
    category: top[1].category,
    skill_level: top[1].skill_level,
    confidence,
  };
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
  const { rows } = await pool.query<{
    trainSampleId: string;
    trainVideoId: string;
    strokeName: string;
    category: string;
    stroke_preset: string;
    skill_level: string;
    dist: string;
  }>(
    `SELECT
      tse."trainSampleId" AS "trainSampleId",
      tv.id AS "trainVideoId",
      tv."strokeName" AS "strokeName",
      tv.category::text AS category,
      tv."strokePreset"::text AS stroke_preset,
      tv."skillLevel"::text AS skill_level,
      (tse.embedding <=> $1::vector)::float8 AS dist
    FROM train_sample_embedding tse
    INNER JOIN train_sample ts ON ts.id = tse."trainSampleId"
    INNER JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.status = $2
    ORDER BY tse.embedding <=> $1::vector
    LIMIT $3`,
    [literal, "completed", k]
  );

  return rows.map((r) => ({
    train_sample_id: r.trainSampleId,
    train_video_id: r.trainVideoId,
    stroke_name: r.strokeName,
    category: r.category,
    stroke_preset: r.stroke_preset,
    skill_level: r.skill_level,
    distance: Number(r.dist),
  }));
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
    return {
      spec_version: POSE_EMBEDDING_SPEC_VERSION,
      embedding_dim: POSE_EMBEDDING_DIM,
      query_embedding_ok: true,
      neighbors: neighbors.map((n) => ({
        train_sample_id: n.train_sample_id,
        train_video_id: n.train_video_id,
        stroke_name: n.stroke_name,
        category: n.category,
        stroke_preset: n.stroke_preset,
        skill_level: n.skill_level,
        distance: n.distance,
      })),
      shot_hypothesis: buildShotHypothesis(neighbors),
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
 * (Embedding matched the whole sequence; this picks a comparable instant for landmark deltas.)
 */
export function pickAlignedProPoseFrame(
  userVideoFrameIndex: number,
  videoTotalFrames: number,
  proSeq: TrainPoseFrame[]
): TrainPoseFrame | null {
  if (!proSeq.length) return null;
  const tf = Math.max(1, videoTotalFrames);
  const t = Math.max(0, Math.min(1, userVideoFrameIndex / tf));
  const idx = Math.min(proSeq.length - 1, Math.round(t * (proSeq.length - 1)));
  return proSeq[idx] ?? null;
}
