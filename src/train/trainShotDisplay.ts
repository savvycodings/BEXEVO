/** Human-facing train shot title (admin catalog label), not enum preset. */

import type { ShotClassification } from "../technique/correctionPrompt";
import { isBandejaNeighbor } from "../technique/trainRetrievalRerank";
import type { TrainNeighborCandidate } from "../technique/trainRetrievalHygiene";

const TRAIN_LEVEL_SUFFIXES = new Set(["Beginner", "Intermediate", "Advanced"]);

/** Minimum k-NN label agreement before retrieval drives display and correction shot text. */
export const RETRIEVAL_CONFIDENCE_THRESHOLD = 0.35;

/** When label vote is weak and top-2 library poses are similarly close, avoid a forced shot name. */
export const NEIGHBOR_DISTANCE_GAP_MIN = 0.02;

function categoryDisplayName(category: string): string {
  return category
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function adminStrokeLabelKey(
  strokeLabel: string | null | undefined,
  strokeName: string
): string {
  const fromCol = (strokeLabel ?? "").trim();
  if (fromCol) return fromCol;
  const parts = strokeName.split(" · ");
  if (parts.length >= 2 && TRAIN_LEVEL_SUFFIXES.has(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" · ").trim();
  }
  return strokeName.trim();
}

function looksLikeStrokePresetId(s: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(s.trim());
}

export type CanonicalShotSource =
  | "retrieval_hypothesis"
  | "rerank_neighbor"
  | "neighbor"
  | "ai_shot_context"
  | "low_confidence_fallback"
  | "fallback";

export type CanonicalShotResolution = {
  shotName: string;
  category: string | null;
  skillLevel: string | null;
  confidence: number;
  source: CanonicalShotSource;
};

function firstSentenceShotContext(shotContext: string): string {
  const first = shotContext.split(/[.!?]/)[0]?.trim() ?? "";
  if (!first) return "";
  return first.length > 36 ? `${first.slice(0, 34)}…` : first;
}

function neighborAsCandidate(
  n: Record<string, unknown>
): TrainNeighborCandidate | null {
  const stroke_label = typeof n.stroke_label === "string" ? n.stroke_label : "";
  if (!stroke_label.trim()) return null;
  return {
    train_sample_id: String(n.train_sample_id ?? ""),
    train_video_id: String(n.train_video_id ?? ""),
    stroke_name: typeof n.stroke_name === "string" ? n.stroke_name : stroke_label,
    stroke_label,
    category: typeof n.category === "string" ? n.category : "",
    stroke_preset: typeof n.stroke_preset === "string" ? n.stroke_preset : "",
    skill_level: typeof n.skill_level === "string" ? n.skill_level : "",
    distance: typeof n.distance === "number" ? n.distance : 0,
    extraction_meta: null,
  };
}

/** After bandeja/overhead rerank, prefer bandeja/overhead library label over Save Return fallback. */
function resolutionFromRerankTopNeighbor(
  retrieval: Record<string, unknown>,
  neighbors: Array<Record<string, unknown>>,
  hypConf: number
): CanonicalShotResolution | null {
  const rerank = retrieval.rerank as
    | { applied?: boolean; bandeja_contention?: boolean; supports_overhead?: boolean }
    | undefined;
  if (!rerank?.applied || neighbors.length === 0) return null;

  if (rerank.bandeja_contention || rerank.supports_overhead) {
    for (const n of neighbors) {
      const c = neighborAsCandidate(n);
      if (c && isBandejaNeighbor(c)) {
        return {
          shotName: c.stroke_label,
          category: c.category || "overhead",
          skillLevel: c.skill_level || null,
          confidence: hypConf,
          source: "rerank_neighbor",
        };
      }
    }
  }

  const top = neighbors[0]!;
  const stroke_label = typeof top.stroke_label === "string" ? top.stroke_label.trim() : "";
  if (!stroke_label || looksLikeStrokePresetId(stroke_label)) return null;

  const candidate = neighborAsCandidate(top);
  const overheadShot =
    top.category === "overhead" || (candidate != null && isBandejaNeighbor(candidate));
  if (!overheadShot) return null;

  return {
    shotName: stroke_label,
    category: typeof top.category === "string" ? top.category : null,
    skillLevel: typeof top.skill_level === "string" ? top.skill_level : null,
    confidence: hypConf,
    source: "rerank_neighbor",
  };
}

/**
 * One shot name for Activities, analyze hints, and correction Comfy (v9).
 * Never uses stroke_preset for display.
 */
export function resolveCanonicalShotFromMetrics(
  metrics: Record<string, unknown> | null | undefined
): CanonicalShotResolution {
  const fallback: CanonicalShotResolution = {
    shotName: "Technique",
    category: null,
    skillLevel: null,
    confidence: 0,
    source: "fallback",
  };
  if (!metrics || typeof metrics !== "object") return fallback;

  const retrieval = metrics.retrieval as Record<string, unknown> | undefined;
  const hyp = retrieval?.shot_hypothesis as Record<string, unknown> | undefined;
  const hypConf = typeof hyp?.confidence === "number" ? hyp.confidence : 0;
  const hypLabel =
    typeof hyp?.stroke_label === "string" ? hyp.stroke_label.trim() : "";
  const neighbors = Array.isArray(retrieval?.neighbors)
    ? (retrieval.neighbors as Array<Record<string, unknown>>)
    : [];
  const storedGap = retrieval?.neighbor_distance_gap;
  const neighborDistanceGap =
    typeof storedGap === "number" && Number.isFinite(storedGap)
      ? storedGap
      : neighbors.length >= 2 &&
          typeof neighbors[0]?.distance === "number" &&
          typeof neighbors[1]?.distance === "number"
        ? (neighbors[1]!.distance as number) - (neighbors[0]!.distance as number)
        : null;
  const ambiguousRetrieval =
    hypConf < RETRIEVAL_CONFIDENCE_THRESHOLD &&
    neighborDistanceGap != null &&
    neighborDistanceGap < NEIGHBOR_DISTANCE_GAP_MIN;

  const rerankTop =
    retrieval != null
      ? resolutionFromRerankTopNeighbor(retrieval, neighbors, hypConf)
      : null;
  if (rerankTop) return rerankTop;

  if (
    !ambiguousRetrieval &&
    hypConf >= RETRIEVAL_CONFIDENCE_THRESHOLD &&
    hypLabel &&
    !looksLikeStrokePresetId(hypLabel)
  ) {
    return {
      shotName: hypLabel,
      category: typeof hyp?.category === "string" ? hyp.category : null,
      skillLevel: typeof hyp?.skill_level === "string" ? hyp.skill_level : null,
      confidence: hypConf,
      source: "retrieval_hypothesis",
    };
  }

  if (ambiguousRetrieval) {
    const top = neighbors[0];
    const topLabel =
      typeof top?.stroke_label === "string" ? top.stroke_label.trim() : "";
    const rerank = retrieval?.rerank as { applied?: boolean } | undefined;
    if (rerank?.applied && topLabel && !looksLikeStrokePresetId(topLabel)) {
      return {
        shotName: topLabel,
        category: typeof top?.category === "string" ? top.category : null,
        skillLevel: typeof top?.skill_level === "string" ? top.skill_level : null,
        confidence: hypConf,
        source: "rerank_neighbor",
      };
    }
    const cat =
      typeof top?.category === "string" && top.category.trim()
        ? categoryDisplayName(top.category.trim())
        : null;
    return {
      shotName: cat ?? "Technique",
      category: typeof top?.category === "string" ? top.category : null,
      skillLevel: typeof top?.skill_level === "string" ? top.skill_level : null,
      confidence: hypConf,
      source: "low_confidence_fallback",
    };
  }

  for (const n of neighbors.slice(0, 3)) {
    if (typeof n.stroke_label === "string" && n.stroke_label.trim()) {
      const key = n.stroke_label.trim();
      if (!looksLikeStrokePresetId(key)) {
        return {
          shotName: key,
          category: typeof n.category === "string" ? n.category : null,
          skillLevel: typeof n.skill_level === "string" ? n.skill_level : null,
          confidence: hypConf,
          source: "neighbor",
        };
      }
    }
    const strokeName = typeof n.stroke_name === "string" ? n.stroke_name : "";
    const colLabel = typeof n.stroke_label === "string" ? n.stroke_label : null;
    const key = adminStrokeLabelKey(colLabel, strokeName);
    if (key && !looksLikeStrokePresetId(key)) {
      return {
        shotName: key,
        category: typeof n.category === "string" ? n.category : null,
        skillLevel: typeof n.skill_level === "string" ? n.skill_level : null,
        confidence: hypConf,
        source: "neighbor",
      };
    }
  }

  const ai = metrics.ai_analysis as Record<string, unknown> | undefined;
  const en = ai?.en as Record<string, unknown> | undefined;
  if (typeof en?.shot_context === "string" && en.shot_context.trim()) {
    const first = firstSentenceShotContext(en.shot_context.trim());
    if (first) {
      return {
        shotName: first,
        category: null,
        skillLevel: null,
        confidence: 0,
        source: "ai_shot_context",
      };
    }
  }

  return fallback;
}

/** Maps resolved retrieval shot into correction image `ShotClassification`. */
export function shotClassificationFromResolved(
  resolved: CanonicalShotResolution
): ShotClassification {
  return {
    shot_family: resolved.category ?? "unknown",
    shot_name: resolved.shotName,
    variant: "unknown",
    tactical_phase: "unknown",
    court_zone: "unknown",
    ball_context: "unknown",
    player_side: "unknown",
    contact_height: "unknown",
    contact_timing: "unknown",
    spin_profile: "unknown",
    objective: "unknown",
    diagnostic_features: [],
    confidence: resolved.confidence,
  };
}

/**
 * Human shot title for Activities / coach lists from persisted analysis metrics.
 */
export function deriveHumanShotLabelFromMetrics(
  metrics: Record<string, unknown> | null | undefined
): string {
  return resolveCanonicalShotFromMetrics(metrics).shotName;
}
