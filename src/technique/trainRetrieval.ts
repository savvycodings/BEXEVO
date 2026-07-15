import { randomUUID } from "crypto";
import { pool, db } from "../db";
import type { TechniqueRetrievalResult, TrainPoseFrame } from "../db/schema";
import {
  embedTrainPoseFrames,
  embedPoseQueryFrames,
  formatVectorSqlLiteral,
  POSE_EMBEDDING_DIM,
  POSE_EMBEDDING_SPEC_VERSION,
  type PoseFrameVector,
  type RetrievalEmbeddingInput,
} from "./poseEmbedding";
import {
  MESH_EMBEDDING_SPEC_VERSION,
  embedTrainMeshFrames,
  embedMeshQueryFrames,
  meshConfidenceFromMetrics,
  type MeshFrameVector,
} from "./meshEmbedding";
import {
  adminStrokeLabelKey,
  RETRIEVAL_CONFIDENCE_THRESHOLD,
} from "../train/trainShotDisplay";
import { buildShotHypothesis, selectShotLabel } from "./shotHypothesis";
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
    ensemble: {
      embedding_source: r.embedding_source ?? null,
      channel_agreement: r.channel_agreement ?? null,
      frames_used: r.frames_used ?? null,
      pose_hypothesis: r.pose_hypothesis
        ? { stroke_label: r.pose_hypothesis.stroke_label, confidence: r.pose_hypothesis.confidence }
        : null,
      mesh_hypothesis: r.mesh_hypothesis
        ? { stroke_label: r.mesh_hypothesis.stroke_label, confidence: r.mesh_hypothesis.confidence }
        : null,
    },
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
Pro reference similarity (sequence + dual-channel ensemble ${r.spec_version}; lower distance = closer match to that labeled clip):
${JSON.stringify(payload, null, 2)}

When shot_hypothesis.confidence is at least ${RETRIEVAL_CONFIDENCE_THRESHOLD}, treat shot_hypothesis.stroke_label (admin trained shot name from the pro library) and category as the primary shot classification. Do not let stroke_preset override stroke_label — preset is legacy taxonomy metadata only.
Otherwise infer the shot from the pose sequence below.
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
    const meta = row.extractionMeta as Record<string, unknown> | null | undefined;
    try {
      const counts = await replaceTrainSampleEmbeddings(
        row.id,
        Array.isArray(seq) ? seq : null,
        meta ?? null
      );
      if (counts.pose === 0 && counts.mesh === 0) {
        console.log("[TrainRetrieval] auto-index skipped (no pose/mesh frames)", { trainSampleId });
        return;
      }
      console.log("[TrainRetrieval] auto-indexed per-frame embeddings for train_sample", {
        trainSampleId,
        pose: counts.pose,
        mesh: counts.mesh,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[TrainRetrieval] auto-index upsert failed — apply migration 0011/0035 + vector on Neon", {
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

/** Single-row upsert (legacy single-frame helper, frameIndex defaults to 0). */
export async function upsertTrainSampleEmbedding(
  trainSampleId: string,
  vector: number[],
  specVersion: string = POSE_EMBEDDING_SPEC_VERSION,
  frameIndex = 0,
  meshConfidence: number | null = null
): Promise<void> {
  const id = randomUUID();
  const literal = formatVectorSqlLiteral(vector);
  await pool.query(
    `INSERT INTO train_sample_embedding (id, "trainSampleId", "specVersion", "frameIndex", "meshConfidence", embedding)
     VALUES ($1, $2, $3, $4, $5, $6::vector)
     ON CONFLICT ("trainSampleId", "specVersion", "frameIndex") DO UPDATE SET
       embedding = EXCLUDED.embedding,
       "meshConfidence" = EXCLUDED."meshConfidence",
       "createdAt" = NOW()`,
    [id, trainSampleId, specVersion, frameIndex, meshConfidence, literal]
  );
}

/**
 * Replace ALL embedding rows for a sample with the per-frame sequence:
 * N pose (v2) rows + M mesh (sam_v1) rows, one per frameIndex.
 * Count varies per sample, so we delete stale rows first then bulk insert.
 */
export async function replaceTrainSampleEmbeddings(
  trainSampleId: string,
  poseSequence: unknown,
  extractionMeta: Record<string, unknown> | null | undefined
): Promise<{ pose: number; mesh: number }> {
  const impactFrameResolved =
    extractionMeta && typeof extractionMeta.impact_frame_resolved === "number"
      ? (extractionMeta.impact_frame_resolved as number)
      : null;
  const poseFrames = embedTrainPoseFrames(
    Array.isArray(poseSequence) ? (poseSequence as Parameters<typeof embedTrainPoseFrames>[0]) : null,
    { impactFrameResolved }
  );
  const meshFrames = embedTrainMeshFrames(extractionMeta ?? null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM train_sample_embedding WHERE "trainSampleId" = $1`, [
      trainSampleId,
    ]);

    for (const pf of poseFrames) {
      await client.query(
        `INSERT INTO train_sample_embedding (id, "trainSampleId", "specVersion", "frameIndex", "meshConfidence", embedding)
         VALUES ($1, $2, $3, $4, NULL, $5::vector)`,
        [randomUUID(), trainSampleId, POSE_EMBEDDING_SPEC_VERSION, pf.seqIndex, formatVectorSqlLiteral(pf.vector)]
      );
    }
    for (const mf of meshFrames) {
      await client.query(
        `INSERT INTO train_sample_embedding (id, "trainSampleId", "specVersion", "frameIndex", "meshConfidence", embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [
          randomUUID(),
          trainSampleId,
          MESH_EMBEDDING_SPEC_VERSION,
          mf.seqIndex,
          mf.meshConfidence,
          formatVectorSqlLiteral(mf.vector),
        ]
      );
    }

    await client.query("COMMIT");
    return { pose: poseFrames.length, mesh: meshFrames.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function queryFilteredTrainCandidates(
  queryVector: number[],
  k: number,
  specVersion: string = POSE_EMBEDDING_SPEC_VERSION,
  excludeTrainSampleId?: string
): Promise<TrainNeighborCandidate[]> {
  const literal = formatVectorSqlLiteral(queryVector);
  const fetchLimit = Math.max(k * 6, 36);
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
      AND ($5::text IS NULL OR ts.id != $5)
    ORDER BY tse.embedding <=> $1::vector
    LIMIT $3`,
    [literal, "completed", fetchLimit, specVersion, excludeTrainSampleId ?? null]
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

  return filterTrainNeighborsForRetrieval(mapped);
}

export async function findNearestTrainNeighbors(
  queryVector: number[],
  k: number,
  metrics?: Record<string, unknown> | null,
  specVersion: string = POSE_EMBEDDING_SPEC_VERSION,
  excludeTrainSampleId?: string
): Promise<NeighborRow[]> {
  const filtered = await queryFilteredTrainCandidates(
    queryVector,
    k,
    specVersion,
    excludeTrainSampleId
  );
  return filtered.slice(0, k);
}

/** Run after migrations; safe to call repeatedly (upserts). */
export async function runTrainEmbeddingBackfill(): Promise<{
  processed: number;
  skipped: number;
  errors: number;
  samProcessed: number;
  samSkipped: number;
}> {
  const rows = await db.query.trainSample.findMany({
    where: (ts, { eq: _eq }) => _eq(ts.status, "completed"),
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  let samProcessed = 0;
  let samSkipped = 0;

  for (const row of rows) {
    const seq = row.poseSequence as unknown;
    const meta = row.extractionMeta as Record<string, unknown> | null | undefined;
    try {
      const counts = await replaceTrainSampleEmbeddings(
        row.id,
        Array.isArray(seq) ? seq : null,
        meta ?? null
      );
      if (counts.pose > 0) processed++;
      else skipped++;
      if (counts.mesh > 0) samProcessed++;
      else samSkipped++;
    } catch (e) {
      console.error("[TrainRetrieval] backfill row failed", row.id, e);
      errors++;
    }
  }

  return { processed, skipped, errors, samProcessed, samSkipped };
}

// ---------------------------------------------------------------------------
// Sequence + dual-channel ensemble retrieval
// ---------------------------------------------------------------------------

type EnsembleChannel = "pose" | "mesh";

type EnsembleMode = "ensemble" | "mediapipe_v2" | "sam_v1";

function ensembleMode(): EnsembleMode {
  const raw = (process.env.RETRIEVAL_EMBEDDING_MODE ?? "ensemble").trim().toLowerCase();
  if (raw === "mediapipe_v2" || raw === "v2" || raw === "mediapipe") return "mediapipe_v2";
  if (raw === "sam_v1" || raw === "sam" || raw === "mesh") return "sam_v1";
  // "ensemble" (new default) and legacy "blended" both run the dual-channel path.
  return "ensemble";
}

function envWeight(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

type Probe = {
  channel: EnsembleChannel;
  seqIndex: number;
  baseWeight: number;
  candidates: TrainNeighborCandidate[];
};

type EnsembleAggregate = {
  neighbors: NeighborRow[];
  shot_hypothesis: TechniqueRetrievalResult["shot_hypothesis"];
  pose_hypothesis: TechniqueRetrievalResult["shot_hypothesis"] | null;
  mesh_hypothesis: TechniqueRetrievalResult["shot_hypothesis"] | null;
  channel_agreement: boolean | null;
  neighbor_distance_gap: number | null;
};

/** Best (min-distance) neighbor per train_sample across a channel's probes — input to per-channel hypothesis. */
function bestPerSample(probes: Probe[]): TrainNeighborCandidate[] {
  const byId = new Map<string, TrainNeighborCandidate>();
  for (const p of probes) {
    for (const c of p.candidates) {
      const cur = byId.get(c.train_sample_id);
      if (!cur || c.distance < cur.distance) byId.set(c.train_sample_id, c);
    }
  }
  return [...byId.values()].sort((a, b) => a.distance - b.distance);
}

function aggregateEnsemble(poseProbes: Probe[], meshProbes: Probe[]): EnsembleAggregate {
  const allProbes = [...poseProbes, ...meshProbes];

  // Collapse to one row per train source (best/min distance across all probes), so that
  // a source with many probe-frame hits or duplicate clips cannot inflate a label's vote.
  const perSample = new Map<
    string,
    { cand: TrainNeighborCandidate; bestDistance: number; baseWeight: number }
  >();

  for (const probe of allProbes) {
    for (const c of probe.candidates) {
      const cur = perSample.get(c.train_sample_id);
      if (!cur || c.distance < cur.bestDistance) {
        perSample.set(c.train_sample_id, {
          cand: c,
          bestDistance: c.distance,
          baseWeight: probe.baseWeight,
        });
      }
    }
  }

  const sources = [...perSample.values()].sort(
    (a, b) => a.bestDistance - b.bestDistance
  );

  const neighbors: NeighborRow[] = sources.map((r) => ({
    train_sample_id: r.cand.train_sample_id,
    train_video_id: r.cand.train_video_id,
    stroke_name: r.cand.stroke_name,
    stroke_label: r.cand.stroke_label,
    category: r.cand.category,
    stroke_preset: r.cand.stroke_preset,
    skill_level: r.cand.skill_level,
    distance: r.bestDistance,
  }));

  const shot_hypothesis = selectShotLabel(
    sources.map((s) => ({
      stroke_label: s.cand.stroke_label,
      stroke_preset: s.cand.stroke_preset,
      category: s.cand.category,
      skill_level: s.cand.skill_level,
      distance: s.bestDistance,
      sourceWeight: s.baseWeight,
    }))
  );

  const poseBest = bestPerSample(poseProbes);
  const meshBest = bestPerSample(meshProbes);
  const pose_hypothesis = poseBest.length ? buildShotHypothesis(poseBest) : null;
  const mesh_hypothesis = meshBest.length ? buildShotHypothesis(meshBest) : null;
  const channel_agreement =
    pose_hypothesis?.stroke_label && mesh_hypothesis?.stroke_label
      ? pose_hypothesis.stroke_label === mesh_hypothesis.stroke_label
      : null;

  const neighbor_distance_gap =
    neighbors.length >= 2 ? neighbors[1]!.distance - neighbors[0]!.distance : null;

  return {
    neighbors,
    shot_hypothesis,
    pose_hypothesis,
    mesh_hypothesis,
    channel_agreement,
    neighbor_distance_gap,
  };
}

async function runChannelProbes(
  frames: Array<{ seqIndex: number; vector: number[]; baseWeight: number }>,
  channel: EnsembleChannel,
  specVersion: string,
  k: number,
  excludeTrainSampleId?: string
): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const f of frames) {
    const candidates = await queryFilteredTrainCandidates(
      f.vector,
      k,
      specVersion,
      excludeTrainSampleId
    ).catch((e) => {
      console.warn("[TrainRetrieval] probe query failed", { channel, seq: f.seqIndex, e });
      return [] as TrainNeighborCandidate[];
    });
    probes.push({ channel, seqIndex: f.seqIndex, baseWeight: f.baseWeight, candidates });
  }
  return probes;
}

/**
 * Build the weighted query frames for each channel from a metrics record.
 * Pose impact frames weigh more than prep/follow; mesh (impact-window) weighs highest.
 */
export function buildEnsembleQueryFrames(
  input: RetrievalEmbeddingInput,
  metricsRecord: Record<string, unknown> | null
): {
  pose: Array<{ seqIndex: number; vector: number[]; baseWeight: number }>;
  mesh: Array<{ seqIndex: number; vector: number[]; baseWeight: number }>;
} {
  const poseImpactW = envWeight("RETRIEVAL_POSE_IMPACT_WEIGHT", 1.0);
  const poseOtherW = envWeight("RETRIEVAL_POSE_OTHER_WEIGHT", 0.6);
  const meshW = envWeight("RETRIEVAL_MESH_WEIGHT", 1.5);

  let poseFrames: PoseFrameVector[] = [];
  try {
    poseFrames = embedPoseQueryFrames(input);
  } catch (e) {
    console.warn("[TrainRetrieval] embedPoseQueryFrames failed", e);
  }
  let meshFrames: MeshFrameVector[] = [];
  try {
    meshFrames = embedMeshQueryFrames(metricsRecord);
  } catch (e) {
    console.warn("[TrainRetrieval] embedMeshQueryFrames failed", e);
  }

  return {
    pose: poseFrames.map((f) => ({
      seqIndex: f.seqIndex,
      vector: f.vector,
      baseWeight: f.phase === "impact" ? poseImpactW : poseOtherW,
    })),
    mesh: meshFrames.map((f) => ({
      seqIndex: f.seqIndex,
      vector: f.vector,
      baseWeight: meshW,
    })),
  };
}

export type EnsembleQueryFrame = { seqIndex: number; vector: number[]; baseWeight: number };

export type EnsembleRetrievalRun = EnsembleAggregate & {
  poseHasNeighbors: boolean;
  meshHasNeighbors: boolean;
};

/**
 * Core dual-channel multi-probe execution shared by live analyze and the admin bench.
 * Each query frame runs its own k-NN; results are pooled into weighted votes.
 * `excludeTrainSampleId` drops ALL rows of that sample (LOOCV).
 */
export async function runEnsembleRetrieval(
  poseFrames: EnsembleQueryFrame[],
  meshFrames: EnsembleQueryFrame[],
  k = 8,
  excludeTrainSampleId?: string
): Promise<EnsembleRetrievalRun> {
  const poseProbes = poseFrames.length
    ? await runChannelProbes(poseFrames, "pose", POSE_EMBEDDING_SPEC_VERSION, k, excludeTrainSampleId)
    : [];
  let meshProbes = meshFrames.length
    ? await runChannelProbes(meshFrames, "mesh", MESH_EMBEDDING_SPEC_VERSION, k, excludeTrainSampleId)
    : [];

  const poseHasNeighbors = poseProbes.some((p) => p.candidates.length > 0);
  const meshHasNeighbors = meshProbes.some((p) => p.candidates.length > 0);
  if (!meshHasNeighbors && meshProbes.length) meshProbes = [];

  const agg = aggregateEnsemble(poseProbes, meshProbes);
  return { ...agg, poseHasNeighbors, meshHasNeighbors };
}

export async function retrieveForTechniqueMetrics(
  metrics: RetrievalEmbeddingInput,
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

  const metricsRecord =
    metrics && typeof metrics === "object" ? (metrics as Record<string, unknown>) : null;

  const mode = ensembleMode();
  const queryFrames = buildEnsembleQueryFrames(metrics, metricsRecord);
  const usePose = mode !== "sam_v1";
  const useMesh = mode !== "mediapipe_v2";
  const poseQuery = usePose ? queryFrames.pose : [];
  const meshQuery = useMesh ? queryFrames.mesh : [];

  if (poseQuery.length === 0 && meshQuery.length === 0) {
    return { ...base, query_embedding_ok: false, error: "no_pose_for_embedding" };
  }

  try {
    // Redundancy: if a channel is empty (no library rows / low conf), the other still answers.
    const run = await runEnsembleRetrieval(poseQuery, meshQuery, k);
    const { poseHasNeighbors, meshHasNeighbors } = run;
    const agg: EnsembleAggregate = run;

    if (agg.neighbors.length === 0) {
      console.log(
        "[TrainRetrieval] no neighbors — ensure migration 0011/0035, CREATE EXTENSION vector, and POST /train/embeddings/backfill"
      );
    }

    const meshUsed = meshHasNeighbors;
    const embedding_source: TechniqueRetrievalResult["embedding_source"] =
      poseHasNeighbors && meshUsed
        ? "ensemble"
        : meshUsed
          ? "sam_v1"
          : "mediapipe_v2";
    const spec_version =
      embedding_source === "mediapipe_v2"
        ? POSE_EMBEDDING_SPEC_VERSION
        : embedding_source === "sam_v1"
          ? MESH_EMBEDDING_SPEC_VERSION
          : "ensemble";

    const impactFrame =
      typeof metricsRecord?.impact_frame_resolved === "number"
        ? (metricsRecord.impact_frame_resolved as number)
        : undefined;

    return {
      spec_version,
      embedding_dim: POSE_EMBEDDING_DIM,
      query_embedding_ok: true,
      neighbors: agg.neighbors.slice(0, k),
      shot_hypothesis: agg.shot_hypothesis,
      neighbor_distance_gap: agg.neighbor_distance_gap,
      embedding_source,
      mesh_used: meshUsed,
      mesh_confidence: meshConfidenceFromMetrics(metricsRecord, impactFrame),
      pose_hypothesis: agg.pose_hypothesis,
      mesh_hypothesis: agg.mesh_hypothesis,
      channel_agreement: agg.channel_agreement,
      frames_used: { pose: poseQuery.length, mesh: meshQuery.length },
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const code = e?.code;
    console.warn("[TrainRetrieval] ensemble query failed", { msg, code });
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
