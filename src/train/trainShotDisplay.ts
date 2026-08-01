/** Human-facing train shot title (admin catalog label), not enum preset. */

import type { ShotClassification } from "../technique/correctionPrompt";

const TRAIN_LEVEL_SUFFIXES = new Set(["Beginner", "Intermediate", "Advanced"]);

/** Minimum k-NN label agreement before retrieval drives display and correction shot text. */
export const RETRIEVAL_CONFIDENCE_THRESHOLD = 0.35;

/** When label vote is weak and top-2 library poses are similarly close, avoid a forced shot name. */
export const NEIGHBOR_DISTANCE_GAP_MIN = 0.02;

/**
 * Drop train-library clip indices from admin labels ("Bandeja 1" → "Bandeja").
 * Keeps the shot family name for UI, voting, and coaching text.
 */
export function stripTrainClipIndexSuffix(label: string): string {
  const t = label.trim();
  if (!t) return t;
  // "Bandeja 1", "Bandeja #2", "Bandeja-3", "Bandeja_4"
  const stripped = t
    .replace(/\s*[#._-]\s*\d+\s*$/i, "")
    .replace(/\s+\d+\s*$/i, "")
    .trim();
  return stripped || t;
}

export function adminStrokeLabelKey(
  strokeLabel: string | null | undefined,
  strokeName: string
): string {
  const fromCol = (strokeLabel ?? "").trim();
  if (fromCol) return stripTrainClipIndexSuffix(fromCol);
  const parts = strokeName.split(" · ");
  if (parts.length >= 2 && TRAIN_LEVEL_SUFFIXES.has(parts[parts.length - 1] ?? "")) {
    return stripTrainClipIndexSuffix(parts.slice(0, -1).join(" · ").trim());
  }
  return stripTrainClipIndexSuffix(strokeName.trim());
}

function looksLikeStrokePresetId(s: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(s.trim());
}

export type CanonicalShotSource =
  | "retrieval_hypothesis"
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
  // The retrieval hypothesis already applies the shared nearest-neighbor + de-duplicated
  // vote selection (selectShotLabel in shotHypothesis.ts), so it is the single source of
  // truth for the shot name across activities, the LLM prompt, and correction images.
  // Trust it whenever it resolved to a real admin label (not a raw preset id), regardless
  // of the confidence gate — the gate previously caused display/hypothesis to disagree.
  if (hypLabel && !looksLikeStrokePresetId(hypLabel)) {
    return {
      shotName: stripTrainClipIndexSuffix(hypLabel),
      category: typeof hyp?.category === "string" ? hyp.category : null,
      skillLevel: typeof hyp?.skill_level === "string" ? hyp.skill_level : null,
      confidence: hypConf,
      source: "retrieval_hypothesis",
    };
  }

  // No usable hypothesis label (null or a raw preset id) → nearest labeled neighbor.
  for (const n of neighbors.slice(0, 3)) {
    if (typeof n.stroke_label === "string" && n.stroke_label.trim()) {
      const key = stripTrainClipIndexSuffix(n.stroke_label.trim());
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
