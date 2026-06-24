import type { TechniqueRetrievalResult } from "../db/schema";
import { BLEND_FORMULA_ID, retrievalBlendMeshWeight } from "../technique/meshEmbedding";
import { resolveCanonicalShotFromMetrics } from "../train/trainShotDisplay";
import { labelsMatch } from "./scoring";

export type RetrievalEvalSnapshot = {
  expected_shot: string | null;
  predicted_shot: string | null;
  display_shot: string;
  llm_shot: string | null;
  llm_category: string | null;
  top_k_neighbors: Array<{
    stroke_label: string;
    distance: number;
    train_sample_id: string;
  }>;
  distance_gap: number | null;
  mesh_confidence: number | null;
  embedding_source: string | null;
  spec_version: string | null;
  blend_mesh_weight: number | null;
  blend_formula_id: string | null;
  llm_disagrees_retrieval: boolean;
  library_fallback: boolean;
  /** Sequence ensemble: per-channel shot labels + agreement + probe counts. */
  pose_shot: string | null;
  mesh_shot: string | null;
  channel_agreement: boolean | null;
  frames_used: { pose: number; mesh: number } | null;
};

function llmShotFromAnalysis(aiAnalysis: Record<string, unknown> | null | undefined): string | null {
  const en = aiAnalysis?.en;
  if (!en || typeof en !== "object") return null;
  const ctx = (en as Record<string, unknown>).shot_context;
  return typeof ctx === "string" && ctx.trim() ? ctx.trim() : null;
}

export function buildEvalSnapshot(
  metrics: Record<string, unknown>,
  aiAnalysis?: Record<string, unknown> | null,
  opts?: { expectedShot?: string | null; blendMeshWeight?: number }
): RetrievalEvalSnapshot {
  const retrieval = metrics.retrieval as TechniqueRetrievalResult | undefined;
  const hyp = retrieval?.shot_hypothesis;
  const predicted =
    typeof hyp?.stroke_label === "string" && hyp.stroke_label.trim()
      ? hyp.stroke_label.trim()
      : null;
  const display = resolveCanonicalShotFromMetrics(metrics);
  const llmShot = llmShotFromAnalysis(aiAnalysis ?? undefined);
  const llmCategory =
    typeof aiAnalysis?.primary_train_category === "string"
      ? aiAnalysis.primary_train_category
      : null;

  const neighbors = (retrieval?.neighbors ?? []).slice(0, 8).map((n) => ({
    stroke_label: n.stroke_label,
    distance: Math.round(n.distance * 1000) / 1000,
    train_sample_id: n.train_sample_id,
  }));

  const embeddingSource = retrieval?.embedding_source ?? null;
  const specVersion = retrieval?.spec_version ?? null;
  const libraryFallback =
    specVersion === "v2" &&
    (embeddingSource === "blended" ||
      embeddingSource === "sam_v1" ||
      retrieval?.mesh_used === true);

  const blendWeight =
    embeddingSource === "blended"
      ? (opts?.blendMeshWeight ?? retrievalBlendMeshWeight())
      : null;

  // F10 fix: compare canonical labels, and treat the LLM's "Pro library match: X"
  // phrasing (which echoes retrieval) as agreement instead of false-positive noise.
  const llmEchoesRetrieval = !!llmShot && /pro library match/i.test(llmShot);
  const llmDisagrees =
    predicted != null &&
    llmShot != null &&
    !llmEchoesRetrieval &&
    !labelsMatch(display.shotName, llmShot) &&
    !labelsMatch(predicted, llmShot);

  return {
    expected_shot: opts?.expectedShot ?? null,
    predicted_shot: predicted,
    display_shot: display.shotName,
    llm_shot: llmShot,
    llm_category: llmCategory,
    top_k_neighbors: neighbors,
    distance_gap:
      typeof retrieval?.neighbor_distance_gap === "number"
        ? retrieval.neighbor_distance_gap
        : null,
    mesh_confidence:
      typeof retrieval?.mesh_confidence === "number" ? retrieval.mesh_confidence : null,
    embedding_source: embeddingSource,
    spec_version: specVersion,
    blend_mesh_weight: blendWeight,
    blend_formula_id: blendWeight != null ? BLEND_FORMULA_ID : null,
    llm_disagrees_retrieval: llmDisagrees,
    library_fallback: libraryFallback,
    pose_shot:
      typeof retrieval?.pose_hypothesis?.stroke_label === "string"
        ? retrieval.pose_hypothesis.stroke_label
        : null,
    mesh_shot:
      typeof retrieval?.mesh_hypothesis?.stroke_label === "string"
        ? retrieval.mesh_hypothesis.stroke_label
        : null,
    channel_agreement:
      typeof retrieval?.channel_agreement === "boolean" ? retrieval.channel_agreement : null,
    frames_used: retrieval?.frames_used ?? null,
  };
}

export function attachEvalToMetrics(
  metrics: Record<string, unknown>,
  aiAnalysis?: Record<string, unknown> | null,
  opts?: { expectedShot?: string | null; blendMeshWeight?: number }
): Record<string, unknown> {
  const retrieval = metrics.retrieval;
  if (!retrieval || typeof retrieval !== "object") return metrics;
  const evalSnap = buildEvalSnapshot(metrics, aiAnalysis, opts);
  return {
    ...metrics,
    retrieval: {
      ...(retrieval as Record<string, unknown>),
      eval: evalSnap,
    },
  };
}
