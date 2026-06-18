import { db, techniqueAnalysis, techniqueVideo, user, userProfile } from "../db";
import { desc, eq } from "drizzle-orm";
import { pool } from "../db";
import {
  ACCURACY_PASS_PERCENT,
  MIN_TRAIN_SAMPLES_PER_LABEL,
  RECENT_ANALYSIS_LIMIT,
} from "./constants";
import { buildEvalSnapshot } from "./evalSnapshot";
import { labelsMatch, percentFromRatio, passedFromScore } from "./scoring";
import { adminStrokeLabelKey } from "../train/trainShotDisplay";
import { buildShotHypothesis } from "../technique/shotHypothesis";
import {
  blendStoredTrainVectors,
  embedTrainMeshFromExtractionMeta,
  MESH_EMBEDDING_SPEC_VERSION,
  parsePoseEnrichment,
} from "../technique/meshEmbedding";
import {
  embedTrainPoseSequence,
  POSE_EMBEDDING_SPEC_VERSION,
} from "../technique/poseEmbedding";
import {
  findNearestTrainNeighbors,
  type NeighborRow,
} from "../technique/trainRetrieval";

export const BENCH_STEP_CATALOG = [
  { id: "1_library_ready", title: "Library ready", order: 1 },
  { id: "2_loocv", title: "LOOCV", order: 2 },
  { id: "3_blend", title: "Blend sweep", order: 3 },
  { id: "4_mesh_train", title: "Train mesh", order: 4 },
  { id: "5_analysis_audit", title: "Analysis audit", order: 5 },
  { id: "6_fallbacks", title: "Fallbacks", order: 6 },
] as const;

export type BenchStepId = (typeof BENCH_STEP_CATALOG)[number]["id"];

export type BenchStepResult = {
  stepId: BenchStepId;
  title: string;
  passed: boolean;
  scorePercent: number;
  summary: string;
  evidence: Record<string, unknown>;
  failures: Array<Record<string, unknown>>;
  tables: Record<string, unknown>;
  charts: Record<string, unknown>;
};

export type BenchSubmissionRow = {
  analysisId: string;
  username: string;
  createdAt: string;
  shot: string;
  score: number | null;
  videoUrl: string;
  hasMesh: boolean;
  embedding_source: string | null;
};

const BLEND_WEIGHTS = [0, 0.2, 0.4, 0.5, 0.6, 1] as const;

type LibrarySample = {
  trainSampleId: string;
  strokeLabel: string;
  v2Vector: number[] | null;
  samVector: number[] | null;
};

function parsePgVector(raw: unknown): number[] | null {
  if (Array.isArray(raw) && raw.every((x) => typeof x === "number")) {
    return raw as number[];
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) {
        return parsed as number[];
      }
    } catch {
      const trimmed = raw.replace(/^\[|\]$/g, "").trim();
      if (!trimmed) return null;
      const nums = trimmed.split(",").map((s) => Number(s.trim()));
      if (nums.every((n) => Number.isFinite(n))) return nums;
    }
  }
  return null;
}

async function loadLibrarySamples(): Promise<LibrarySample[]> {
  const { rows } = await pool.query<{
    trainSampleId: string;
    strokeLabel: string | null;
    strokeName: string;
    poseSequence: unknown;
    extractionMeta: unknown;
    v2Emb: unknown;
    samEmb: unknown;
  }>(
    `SELECT
      ts.id AS "trainSampleId",
      tv."strokeLabel" AS "strokeLabel",
      tv."strokeName" AS "strokeName",
      ts."poseSequence" AS "poseSequence",
      ts."extractionMeta" AS "extractionMeta",
      v2.embedding AS "v2Emb",
      sam.embedding AS "samEmb"
    FROM train_sample ts
    INNER JOIN train_video tv ON tv.id = ts."trainVideoId"
    LEFT JOIN train_sample_embedding v2
      ON v2."trainSampleId" = ts.id AND v2."specVersion" = $1
    LEFT JOIN train_sample_embedding sam
      ON sam."trainSampleId" = ts.id AND sam."specVersion" = $2
    WHERE ts.status = 'completed'
    ORDER BY ts."createdAt" DESC`,
    [POSE_EMBEDDING_SPEC_VERSION, MESH_EMBEDDING_SPEC_VERSION]
  );

  return rows.map((r) => {
    const label = adminStrokeLabelKey(r.strokeLabel, r.strokeName);
    let v2Vector = parsePgVector(r.v2Emb);
    let samVector = parsePgVector(r.samEmb);
    if (!v2Vector) {
      const seq = Array.isArray(r.poseSequence) ? r.poseSequence : null;
      v2Vector = embedTrainPoseSequence(seq);
    }
    if (!samVector) {
      const meta =
        r.extractionMeta && typeof r.extractionMeta === "object"
          ? (r.extractionMeta as Record<string, unknown>)
          : null;
      samVector = embedTrainMeshFromExtractionMeta(meta);
    }
    return {
      trainSampleId: r.trainSampleId,
      strokeLabel: label,
      v2Vector,
      samVector,
    };
  });
}

function buildQueryVector(
  sample: LibrarySample,
  meshWeight: number
): { vector: number[] | null; spec: string } {
  const mw = Math.max(0, Math.min(1, meshWeight));
  if (mw <= 0) {
    return { vector: sample.v2Vector, spec: POSE_EMBEDDING_SPEC_VERSION };
  }
  if (mw >= 1) {
    return { vector: sample.samVector, spec: MESH_EMBEDDING_SPEC_VERSION };
  }
  if (!sample.v2Vector || !sample.samVector) {
    return { vector: sample.v2Vector ?? sample.samVector, spec: sample.samVector ? MESH_EMBEDDING_SPEC_VERSION : POSE_EMBEDDING_SPEC_VERSION };
  }
  return {
    vector: blendStoredTrainVectors(sample.v2Vector, sample.samVector, mw),
    spec: MESH_EMBEDDING_SPEC_VERSION,
  };
}

async function neighborsForLoocv(
  sample: LibrarySample,
  meshWeight: number,
  k = 8
): Promise<{ neighbors: NeighborRow[]; libraryFallback: boolean }> {
  const { vector, spec } = buildQueryVector(sample, meshWeight);
  if (!vector) return { neighbors: [], libraryFallback: false };

  let neighbors = await findNearestTrainNeighbors(
    vector,
    k,
    null,
    spec,
    sample.trainSampleId
  );
  let libraryFallback = false;
  if (
    neighbors.length === 0 &&
    spec === MESH_EMBEDDING_SPEC_VERSION &&
    sample.v2Vector
  ) {
    libraryFallback = true;
    neighbors = await findNearestTrainNeighbors(
      sample.v2Vector,
      k,
      null,
      POSE_EMBEDDING_SPEC_VERSION,
      sample.trainSampleId
    );
  }
  return { neighbors, libraryFallback };
}

function topKHit(expected: string, neighbors: NeighborRow[], k: number): boolean {
  const slice = neighbors.slice(0, k);
  return slice.some((n) => labelsMatch(expected, n.stroke_label));
}

async function runLoocvAtWeight(
  samples: LibrarySample[],
  meshWeight: number
): Promise<{
  top1Ok: number;
  top3Ok: number;
  total: number;
  fallbackCount: number;
  byShot: Record<string, { total: number; top1: number; top3: number }>;
  failures: Array<Record<string, unknown>>;
}> {
  let top1Ok = 0;
  let top3Ok = 0;
  let total = 0;
  let fallbackCount = 0;
  const byShot: Record<string, { total: number; top1: number; top3: number }> = {};
  const failures: Array<Record<string, unknown>> = [];

  for (const sample of samples) {
    const { vector } = buildQueryVector(sample, meshWeight);
    if (!vector) continue;
    total++;
    const { neighbors, libraryFallback } = await neighborsForLoocv(sample, meshWeight);
    if (libraryFallback) fallbackCount++;

    const hyp = buildShotHypothesis(neighbors);
    const predicted = hyp.stroke_label ?? neighbors[0]?.stroke_label ?? null;
    const t1 = labelsMatch(sample.strokeLabel, predicted);
    const t3 = topKHit(sample.strokeLabel, neighbors, 3);
    if (t1) top1Ok++;
    if (t3) top3Ok++;

    const shotKey = sample.strokeLabel || "unknown";
    if (!byShot[shotKey]) byShot[shotKey] = { total: 0, top1: 0, top3: 0 };
    byShot[shotKey].total++;
    if (t1) byShot[shotKey].top1++;
    if (t3) byShot[shotKey].top3++;

    if (!t1 && failures.length < 12) {
      failures.push({
        id: sample.trainSampleId,
        reason: neighbors.length === 0 ? "no_neighbors" : "top1_mismatch",
        used: {
          expected: sample.strokeLabel,
          predicted,
          library_fallback: libraryFallback,
          mesh_weight: meshWeight,
          gap:
            neighbors.length >= 2
              ? neighbors[1]!.distance - neighbors[0]!.distance
              : null,
          neighbors: neighbors.slice(0, 5).map((n) => ({
            stroke_label: n.stroke_label,
            distance: Math.round(n.distance * 1000) / 1000,
          })),
        },
      });
    }
  }

  return { top1Ok, top3Ok, total, fallbackCount, byShot, failures };
}

function benchResult(
  stepId: BenchStepId,
  title: string,
  scorePercent: number,
  summary: string,
  extra: {
    evidence?: Record<string, unknown>;
    failures?: Array<Record<string, unknown>>;
    tables?: Record<string, unknown>;
    charts?: Record<string, unknown>;
  }
): BenchStepResult {
  return {
    stepId,
    title,
    passed: passedFromScore(scorePercent),
    scorePercent,
    summary,
    evidence: extra.evidence ?? {},
    failures: extra.failures ?? [],
    tables: extra.tables ?? {},
    charts: extra.charts ?? {},
  };
}

export async function runBenchStep(
  stepId: BenchStepId,
  opts?: { analysisId?: string; blendMeshWeight?: number }
): Promise<BenchStepResult> {
  const def = BENCH_STEP_CATALOG.find((s) => s.id === stepId);
  const title = def?.title ?? stepId;

  switch (stepId) {
    case "1_library_ready":
      return runLibraryReady(title);
    case "2_loocv":
      return runLoocvStep(title, opts?.blendMeshWeight);
    case "3_blend":
      return runBlendSweep(title);
    case "4_mesh_train":
      return runMeshTrain(title);
    case "5_analysis_audit":
      return runAnalysisAudit(title, opts?.analysisId);
    case "6_fallbacks":
      return runFallbacks(title);
    default:
      throw new Error(`Unknown bench step: ${stepId}`);
  }
}

async function runLibraryReady(title: string): Promise<BenchStepResult> {
  const { rows: counts } = await pool.query<{ spec: string; n: string }>(
    `SELECT tse."specVersion" AS spec, COUNT(*)::text AS n
     FROM train_sample_embedding tse
     INNER JOIN train_sample ts ON ts.id = tse."trainSampleId"
     WHERE ts.status = 'completed'
     GROUP BY tse."specVersion"`
  );
  const v2 = Number(counts.find((r) => r.spec === POSE_EMBEDDING_SPEC_VERSION)?.n ?? 0);
  const sam = Number(counts.find((r) => r.spec === MESH_EMBEDDING_SPEC_VERSION)?.n ?? 0);

  const { rows: thin } = await pool.query<{ label: string; n: string }>(
    `SELECT COALESCE(NULLIF(TRIM(tv."strokeLabel"), ''), tv."strokeName") AS label, COUNT(*)::text AS n
     FROM train_sample ts
     INNER JOIN train_video tv ON tv.id = ts."trainVideoId"
     INNER JOIN train_sample_embedding tse ON tse."trainSampleId" = ts.id AND tse."specVersion" = $1
     WHERE ts.status = 'completed'
     GROUP BY 1
     HAVING COUNT(*) < $2`,
    [POSE_EMBEDDING_SPEC_VERSION, MIN_TRAIN_SAMPLES_PER_LABEL]
  );

  const ok = thin.length === 0 && v2 > 0 ? 1 : 0;
  const total = 1;
  const scorePercent = percentFromRatio(ok, total);
  return benchResult("1_library_ready", title, scorePercent, `${v2} v2 · ${sam} sam_v1`, {
    evidence: {
      v2_count: v2,
      sam_v1_count: sam,
      thin_labels: thin.map((r) => ({ label: r.label, count: Number(r.n) })),
      thresholds: { min_per_label: MIN_TRAIN_SAMPLES_PER_LABEL },
    },
    failures: thin.map((r) => ({
      id: r.label,
      reason: "thin_label",
      used: { label: r.label, count: Number(r.n), min: MIN_TRAIN_SAMPLES_PER_LABEL },
    })),
    tables: {
      embedding_counts: [
        { spec: POSE_EMBEDDING_SPEC_VERSION, count: v2 },
        { spec: MESH_EMBEDDING_SPEC_VERSION, count: sam },
      ],
    },
    charts: {
      ringScores: [{ label: "v2", value: Math.min(100, v2 * 10) }, { label: "sam", value: Math.min(100, sam * 10) }],
    },
  });
}

async function runLoocvStep(title: string, meshWeight?: number): Promise<BenchStepResult> {
  const samples = await loadLibrarySamples();
  const w = typeof meshWeight === "number" ? meshWeight : 0.4;
  const r = await runLoocvAtWeight(samples, w);
  const scorePercent = percentFromRatio(r.top1Ok, r.total);
  const byShotRows = Object.entries(r.byShot).map(([label, s]) => ({
    label,
    total: s.total,
    top1_pct: percentFromRatio(s.top1, s.total),
    top3_pct: percentFromRatio(s.top3, s.total),
  }));

  return benchResult(
    "2_loocv",
    title,
    scorePercent,
    r.total === 0
      ? "0 library samples"
      : `top1 ${r.top1Ok}/${r.total} · top3 ${r.top3Ok}/${r.total} · w=${w}`,
    {
      evidence: {
        mesh_weight: w,
        sample_count: samples.length,
        evaluated: r.total,
        fallback_count: r.fallbackCount,
      },
      failures: r.failures,
      tables: { by_shot: byShotRows },
      charts: {
        ringScores: [
          { label: "top1", value: scorePercent },
          { label: "top3", value: percentFromRatio(r.top3Ok, r.total) },
        ],
        lineSeries: byShotRows.map((row) => ({
          label: row.label.slice(0, 12),
          value: row.top1_pct,
        })),
      },
    }
  );
}

async function runBlendSweep(title: string): Promise<BenchStepResult> {
  const samples = await loadLibrarySamples();
  const byWeight: Array<{
    mesh_weight: number;
    label: string;
    top1_pct: number;
    top3_pct: number;
    evaluated: number;
    fallback_pct: number;
  }> = [];

  for (const w of BLEND_WEIGHTS) {
    const r = await runLoocvAtWeight(samples, w);
    const label =
      w <= 0 ? "mp" : w >= 1 ? "mesh" : `${Math.round(w * 100)}/${Math.round((1 - w) * 100)}`;
    byWeight.push({
      mesh_weight: w,
      label,
      top1_pct: percentFromRatio(r.top1Ok, r.total),
      top3_pct: percentFromRatio(r.top3Ok, r.total),
      evaluated: r.total,
      fallback_pct: percentFromRatio(r.fallbackCount, r.total),
    });
  }

  const best = byWeight.reduce((a, b) => (b.top1_pct > a.top1_pct ? b : a), byWeight[0]!);
  const scorePercent = best?.top1_pct ?? 0;

  return benchResult(
    "3_blend",
    title,
    scorePercent,
    samples.length === 0
      ? "0 samples"
      : `best ${best?.label} top1=${best?.top1_pct}%`,
    {
      evidence: { sample_count: samples.length, weights: [...BLEND_WEIGHTS] },
      tables: { by_weight: byWeight },
      charts: {
        lineSeries: byWeight.map((row) => ({
          label: row.label,
          value: row.top1_pct,
          mesh_weight: row.mesh_weight,
        })),
      },
    }
  );
}

async function runMeshTrain(title: string): Promise<BenchStepResult> {
  const { rows } = await pool.query<{ total: string; with_mesh: string; with_sam: string }>(
    `SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (
        WHERE (ts."extractionMeta"->'pose_enrichment'->'frames') IS NOT NULL
          AND jsonb_array_length(ts."extractionMeta"->'pose_enrichment'->'frames') > 0
      )::text AS with_mesh,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM train_sample_embedding tse
          WHERE tse."trainSampleId" = ts.id AND tse."specVersion" = $1
        )
      )::text AS with_sam
    FROM train_sample ts
    WHERE ts.status = 'completed'`,
    [MESH_EMBEDDING_SPEC_VERSION]
  );
  const total = Number(rows[0]?.total ?? 0);
  const withMesh = Number(rows[0]?.with_mesh ?? 0);
  const withSam = Number(rows[0]?.with_sam ?? 0);
  const scorePercent = percentFromRatio(withSam, total);

  return benchResult(
    "4_mesh_train",
    title,
    scorePercent,
    total === 0 ? "0 train samples" : `mesh ${withMesh}/${total} · sam idx ${withSam}/${total}`,
    {
      evidence: { total, with_pose_enrichment: withMesh, with_sam_index: withSam },
      failures:
        withMesh < total
          ? [{ id: "train_mesh", reason: "missing_pose_enrichment", used: { withMesh, total } }]
          : [],
      charts: {
        ringScores: [
          { label: "mesh", value: percentFromRatio(withMesh, total) },
          { label: "sam", value: scorePercent },
        ],
      },
    }
  );
}

async function runAnalysisAudit(
  title: string,
  analysisId?: string
): Promise<BenchStepResult> {
  if (!analysisId) {
    return benchResult("5_analysis_audit", title, 0, "Select a submission", {
      failures: [{ id: "—", reason: "no_analysis_selected", used: {} }],
    });
  }

  const row = await db.query.techniqueAnalysis.findFirst({
    where: (a, { eq: _eq }) => _eq(a.id, analysisId),
  });
  if (!row || row.status !== "completed") {
    return benchResult("5_analysis_audit", title, 0, "Analysis not found", {
      failures: [{ id: analysisId, reason: "not_completed", used: { status: row?.status } }],
    });
  }

  const metrics = (row.metrics ?? {}) as Record<string, unknown>;
  const ai = metrics.ai_analysis as Record<string, unknown> | undefined;
  const evalSnap =
    ((metrics.retrieval as Record<string, unknown> | undefined)?.eval as ReturnType<
      typeof buildEvalSnapshot
    > | undefined) ?? buildEvalSnapshot(metrics, ai);

  const hasRetrieval = Boolean(
    (metrics.retrieval as Record<string, unknown> | undefined)?.query_embedding_ok
  );
  const scorePercent = hasRetrieval ? 100 : 0;

  return benchResult("5_analysis_audit", title, scorePercent, evalSnap.display_shot ?? "—", {
    evidence: { analysis_id: analysisId, eval: evalSnap },
    failures: evalSnap.llm_disagrees_retrieval
      ? [
          {
            id: analysisId,
            reason: "llm_disagrees_retrieval",
            used: {
              predicted: evalSnap.predicted_shot,
              llm_shot: evalSnap.llm_shot,
              neighbors: evalSnap.top_k_neighbors,
            },
          },
        ]
      : [],
    tables: {
      neighbors: evalSnap.top_k_neighbors,
      signals: [
        { key: "embedding_source", value: evalSnap.embedding_source },
        { key: "spec_version", value: evalSnap.spec_version },
        { key: "mesh_confidence", value: evalSnap.mesh_confidence },
        { key: "distance_gap", value: evalSnap.distance_gap },
        { key: "library_fallback", value: evalSnap.library_fallback },
      ],
    },
    charts: {
      ringScores: [
        {
          label: "mesh",
          value:
            typeof evalSnap.mesh_confidence === "number"
              ? Math.round(evalSnap.mesh_confidence * 100)
              : 0,
        },
      ],
    },
  });
}

async function runFallbacks(title: string): Promise<BenchStepResult> {
  const rows = await db
    .select()
    .from(techniqueAnalysis)
    .where(eq(techniqueAnalysis.status, "completed"))
    .orderBy(desc(techniqueAnalysis.createdAt))
    .limit(RECENT_ANALYSIS_LIMIT);

  const bySource: Record<string, number> = {};
  let fallback = 0;
  let llmDisagree = 0;
  let withRetrieval = 0;

  for (const row of rows) {
    const metrics = (row.metrics ?? {}) as Record<string, unknown>;
    const retrieval = metrics.retrieval as Record<string, unknown> | undefined;
    if (!retrieval?.query_embedding_ok) continue;
    withRetrieval++;
    const src = String(retrieval.embedding_source ?? "unknown");
    bySource[src] = (bySource[src] ?? 0) + 1;
    const evalSnap = retrieval.eval as Record<string, unknown> | undefined;
    if (evalSnap?.library_fallback === true) fallback++;
    else if (
      retrieval.spec_version === "v2" &&
      (retrieval.mesh_used === true || src === "blended" || src === "sam_v1")
    ) {
      fallback++;
    }
    if (evalSnap?.llm_disagrees_retrieval === true) llmDisagree++;
  }

  const total = withRetrieval;
  const scorePercent =
    total === 0 ? 0 : percentFromRatio(total - fallback - llmDisagree, total);

  return benchResult(
    "6_fallbacks",
    title,
    scorePercent,
    total === 0
      ? "No retrieval rows"
      : `fallback ${fallback}/${total} · LLM≠ret ${llmDisagree}/${total}`,
    {
      evidence: { analyzed: rows.length, with_retrieval: total },
      tables: {
        by_source: Object.entries(bySource).map(([source, count]) => ({
          source,
          count,
          pct: percentFromRatio(count, total),
        })),
      },
      charts: {
        ringScores: Object.entries(bySource).map(([label, count]) => ({
          label,
          value: percentFromRatio(count, total),
        })),
      },
    }
  );
}

function publicVideoUrl(secureUrl: string | null, cloudinaryPublicId: string | null): string {
  const publicVideoBase = (process.env.PUBLIC_VIDEO_BASE_URL || "").trim();
  const publicBase = (process.env.PUBLIC_BASE_URL || "").trim();
  const authBase = (process.env.BETTER_AUTH_URL || "").trim();
  const baseUrl = publicVideoBase || publicBase || authBase;
  if (secureUrl?.startsWith("http")) return secureUrl;
  const path = secureUrl || `/technique/video/${cloudinaryPublicId}`;
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function listBenchSubmissions(opts?: {
  limit?: number;
  search?: string;
}): Promise<BenchSubmissionRow[]> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
  const analyses = await db
    .select({
      id: techniqueAnalysis.id,
      createdAt: techniqueAnalysis.createdAt,
      metrics: techniqueAnalysis.metrics,
      secureUrl: techniqueVideo.secureUrl,
      cloudinaryPublicId: techniqueVideo.cloudinaryPublicId,
      username: userProfile.username,
      userName: user.name,
      userEmail: user.email,
    })
    .from(techniqueAnalysis)
    .innerJoin(techniqueVideo, eq(techniqueAnalysis.techniqueVideoId, techniqueVideo.id))
    .innerJoin(user, eq(techniqueAnalysis.userId, user.id))
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(eq(techniqueAnalysis.status, "completed"))
    .orderBy(desc(techniqueAnalysis.createdAt))
    .limit(limit);

  const search = (opts?.search ?? "").trim().toLowerCase();
  const rows: BenchSubmissionRow[] = [];

  for (const a of analyses) {
    const metrics = (a.metrics ?? {}) as Record<string, unknown>;
    const username =
      (a.username ?? a.userName ?? a.userEmail?.split("@")[0] ?? "user").trim() || "user";
    if (search && !username.toLowerCase().includes(search)) continue;

    const display =
      (metrics.retrieval as Record<string, unknown> | undefined)?.eval &&
      typeof ((metrics.retrieval as Record<string, unknown>).eval as Record<string, unknown>)
        .display_shot === "string"
        ? String(((metrics.retrieval as Record<string, unknown>).eval as Record<string, unknown>).display_shot)
        : null;

    const ai = metrics.ai_analysis as Record<string, unknown> | undefined;
    const shot =
      display ??
      (typeof (metrics.retrieval as Record<string, unknown> | undefined)?.shot_hypothesis ===
      "object"
        ? String(
            (
              (metrics.retrieval as Record<string, unknown>).shot_hypothesis as Record<
                string,
                unknown
              >
            ).stroke_label ?? "—"
          )
        : "—");

    const score =
      typeof ai?.score === "number" && Number.isFinite(ai.score) ? Math.round(ai.score) : null;
    const pe = parsePoseEnrichment(metrics);
    const retrieval = metrics.retrieval as Record<string, unknown> | undefined;

    rows.push({
      analysisId: a.id,
      username,
      createdAt: a.createdAt?.toISOString() ?? new Date().toISOString(),
      shot,
      score,
      videoUrl: publicVideoUrl(a.secureUrl, a.cloudinaryPublicId),
      hasMesh: Array.isArray(pe?.frames) && pe.frames.length > 0,
      embedding_source:
        typeof retrieval?.embedding_source === "string" ? retrieval.embedding_source : null,
    });
  }

  return rows;
}

export function isBenchStepId(id: string): id is BenchStepId {
  return BENCH_STEP_CATALOG.some((s) => s.id === id);
}

export { ACCURACY_PASS_PERCENT };
