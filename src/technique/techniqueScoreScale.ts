import { averagePhysicalMetrics, parsePhysicalMetrics } from "./physicalMetrics";

/**
 * Technique analyses historically stored `ai_analysis.score` on a 0–10 scale.
 * New analyses set `score_scale: "percent"` and use 0–100.
 */
export function storedAiScoreToPercent(ai: Record<string, unknown> | null | undefined): number | null {
  const score = typeof ai?.score === 'number' ? ai.score : null
  if (score == null || !Number.isFinite(score)) return null
  if (String(ai?.score_scale).toLowerCase() === 'percent') {
    return Math.round(Math.max(0, Math.min(100, score)))
  }
  const raw = typeof ai?.score_model_raw === 'number' ? ai.score_model_raw : null
  const legacyDecile =
    score <= 10 && score >= 0 && (raw == null || raw <= 10)
  if (legacyDecile) {
    return Math.round(Math.max(0, Math.min(100, score * 10)))
  }
  return Math.round(Math.max(0, Math.min(100, score)))
}

/**
 * User-facing ring / list score: average of the five physical metrics when present.
 * Falls back to calibrated pillar overall (`ai_analysis.score`) for older rows.
 */
export function headlineScoreFromAnalysis(
  ai: Record<string, unknown> | null | undefined
): number | null {
  const pm = parsePhysicalMetrics(ai?.physical_metrics)
  if (pm) return averagePhysicalMetrics(pm)
  return storedAiScoreToPercent(ai)
}

function normalize0to100(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value >= 0 && value <= 1) return Math.round(value * 100)
  return Math.round(Math.max(0, Math.min(100, value)))
}

export function storedAiBreakdownToPercent(
  ai: Record<string, unknown> | null | undefined
): { technique: number | null; outcome: number | null; tactics: number | null } {
  const technique =
    normalize0to100(ai?.technique_score) ??
    normalize0to100((ai?.breakdown as Record<string, unknown> | undefined)?.technique)
  const outcome =
    normalize0to100(ai?.outcome_score) ??
    normalize0to100((ai?.breakdown as Record<string, unknown> | undefined)?.outcome)
  const tactics =
    normalize0to100(ai?.tactics_score) ??
    normalize0to100((ai?.breakdown as Record<string, unknown> | undefined)?.tactics)
  return { technique, outcome, tactics }
}

export function storedAiConfidenceToPercent(
  ai: Record<string, unknown> | null | undefined
): { score: number | null; band: string | null; uncertaintyPlusMinus: number | null } {
  const confidenceObj =
    ai?.confidence && typeof ai.confidence === 'object'
      ? (ai.confidence as Record<string, unknown>)
      : null
  const score = normalize0to100(ai?.confidence_score) ?? normalize0to100(confidenceObj?.score)
  const band = typeof confidenceObj?.band === 'string' ? confidenceObj.band : null
  const uncertaintyPlusMinus =
    typeof confidenceObj?.uncertainty_plus_minus === 'number' &&
    Number.isFinite(confidenceObj.uncertainty_plus_minus)
      ? Math.max(0, Math.round(confidenceObj.uncertainty_plus_minus))
      : null
  return { score, band, uncertaintyPlusMinus }
}
