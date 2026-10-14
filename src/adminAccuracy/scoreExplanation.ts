/**
 * How an analysis' displayed technique score was built, step by step, from what the pipeline
 * stored in metrics.ai_analysis (see the v6.1.3 block in techniqueRouter and scoreCalibration).
 * For the admin Training accuracy screen.
 */
import { pillarDisplayBoostAmount } from "../technique/scoreCalibration";

type Pillars = { technique: number; outcome: number; tactics: number };
const PILLARS = ["technique", "outcome", "tactics"] as const;

export type ScoreExplanation = {
  final: number;
  rating: string | null;
  scoringVersion: string | null;
  /** Step 1: what the analyzer measured before the model saw the clip. */
  inputs: {
    poseFrames: number;
    impactFrame: number | null;
    shot: string | null;
    embeddingSource: string | null;
    topNeighbor: { stroke: string; distance: number | null } | null;
    isPadel: boolean | null;
    sportConfidence: number | null;
  };
  /** Step 2: the model's own overall score and its three pillars, before the display boost. */
  modelRaw: number | null;
  pillarsRaw: Pillars | null;
  pillarAverage: number | null;
  /** Step 3: points added to each pillar, and what set them. */
  boost: {
    points: number;
    merit: number | null;
    perPillar: Pillars | null;
    factors: Record<string, number> | null;
  } | null;
  /** Step 4: pillars after the boost; final = their average. */
  pillarsFinal: Pillars | null;
  confidence: {
    score: number | null;
    band: string | null;
    pose: number | null;
    tracking: number | null;
    visibility: number | null;
    plusMinus: number | null;
  } | null;
  feedback: { diagnosis: string | null; strengths: string[]; errors: string[]; corrections: string[] };
  /** Old penalty-based score, kept by the pipeline for comparison only. */
  legacyPenaltyScore: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];

function pillarsOf(v: unknown): Pillars | null {
  const o = obj(v);
  if (!o) return null;
  const [t, out, tac] = PILLARS.map((k) => num(o[k]));
  return t != null && out != null && tac != null ? { technique: t, outcome: out, tactics: tac } : null;
}

/** The pre-boost pillar that `boost` turns into `shown` (boost is a monotonic step per pillar). */
export function unboostPillar(shown: number, boost: number): number {
  for (let pre = 100; pre >= 0; pre--) {
    if (Math.min(100, pre + pillarDisplayBoostAmount(pre, boost)) <= shown) return pre;
  }
  return 0;
}

export function explainScore(
  metrics: Record<string, unknown>,
  topNeighbor: { strokeLabel: string; distance: number | null } | null
): ScoreExplanation | null {
  const ai = obj(metrics.ai_analysis);
  const final = num(ai?.score);
  if (!ai || final == null) return null;

  const trace = obj(ai.calibration_trace);
  const retrieval = obj(metrics.retrieval);
  const evalSnap = obj(retrieval?.eval);
  const en = obj(ai.en) ?? {};
  const conf = obj(ai.confidence);

  const pillarsFinal = pillarsOf(ai.breakdown);
  const points = num(trace?.score_display_boost);
  const pillarsRaw =
    pillarsFinal && points != null
      ? {
          technique: unboostPillar(pillarsFinal.technique, points),
          outcome: unboostPillar(pillarsFinal.outcome, points),
          tactics: unboostPillar(pillarsFinal.tactics, points),
        }
      : null;
  const factors = obj(trace?.score_display_boost_factors);

  return {
    final,
    rating: str(ai.rating),
    scoringVersion: str(ai.scoring_version),
    inputs: {
      poseFrames: Array.isArray(metrics.pose_data) ? metrics.pose_data.length : 0,
      impactFrame: num(metrics.impact_frame_resolved),
      shot: str(evalSnap?.display_shot) ?? str(obj(retrieval?.shot_hypothesis)?.stroke_label),
      embeddingSource: str(retrieval?.embedding_source) ?? str(evalSnap?.embedding_source),
      topNeighbor: topNeighbor ? { stroke: topNeighbor.strokeLabel, distance: topNeighbor.distance } : null,
      isPadel: typeof ai.is_padel === "boolean" ? ai.is_padel : null,
      sportConfidence: num(ai.sport_confidence),
    },
    modelRaw: num(ai.score_model_raw) ?? num(trace?.model_score_raw),
    pillarsRaw,
    pillarAverage: num(trace?.pillar_blend),
    boost:
      points != null
        ? {
            points,
            merit: num(trace?.score_display_boost_merit),
            perPillar:
              pillarsFinal && pillarsRaw
                ? {
                    technique: pillarsFinal.technique - pillarsRaw.technique,
                    outcome: pillarsFinal.outcome - pillarsRaw.outcome,
                    tactics: pillarsFinal.tactics - pillarsRaw.tactics,
                  }
                : null,
            factors: factors
              ? Object.fromEntries(
                  Object.entries(factors).filter((e): e is [string, number] => num(e[1]) != null)
                )
              : null,
          }
        : null,
    pillarsFinal,
    confidence: conf
      ? {
          score: num(conf.score),
          band: str(conf.band),
          pose: num(conf.pose_confidence),
          tracking: num(conf.tracking_stability),
          visibility: num(conf.visibility_quality),
          plusMinus: num(conf.uncertainty_plus_minus),
        }
      : null,
    feedback: {
      diagnosis: str(en.diagnosis),
      strengths: list(en.strengths ?? en.observations),
      errors: list(en.technical_errors),
      corrections: list(en.actionable_corrections ?? en.recommendations),
    },
    legacyPenaltyScore: num(trace?.legacy_penalty_adjusted_audit),
  };
}
