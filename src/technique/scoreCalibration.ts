type AnalysisSection = {
  diagnosis?: string
  strengths?: unknown
  technical_errors?: unknown
  actionable_corrections?: unknown
  observations?: unknown
  recommendations?: unknown
}

type AnalysisLike = {
  score?: unknown
  sport_confidence?: unknown
  technique_score?: unknown
  outcome_score?: unknown
  tactics_score?: unknown
  confidence_score?: unknown
  confidence?: unknown
  en?: AnalysisSection
}

/** Penalties are on the same scale as `score` (0–100). */
const SCORE_CALIBRATION = {
  baselinePenalty: 8,
  technicalErrorPenalty: 2,
  technicalErrorPenaltyCap: 8,
  severeTechnicalErrorPenalty: 1.5,
  severeTechnicalErrorPenaltyCap: 4,
  actionablePenalty: 1,
  actionablePenaltyCap: 3,
  strengthsCredit: 1,
  strengthsCreditCap: 4,
  uncertaintyPenaltyMax: 20,
  severeErrorKeywords: [
    'late',
    'off-balance',
    'unstable',
    'poor',
    'inconsistent',
    'incorrect',
    'collapsed',
    'open racket face',
    'closed racket face',
    'no split step',
    'crossing steps',
    'wristy',
    'over-rotation',
    'under-rotation',
  ],
  minScore: 0,
  maxScore: 100,
}

type V61Breakdown = {
  technique: number
  outcome: number
  tactics: number
}

type V61Confidence = {
  score: number
  pose_confidence: number
  tracking_stability: number
  visibility_quality: number
  band: 'high' | 'reliable' | 'moderate' | 'inconclusive'
  uncertainty_plus_minus: number
}

export type V61CalibratedScores = {
  overall: number
  rawOverall: number
  breakdown: V61Breakdown
  confidence: V61Confidence
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean)
}

function containsSevereKeyword(text: string): boolean {
  const lower = text.toLowerCase()
  return SCORE_CALIBRATION.severeErrorKeywords.some(keyword => lower.includes(keyword))
}

function countSevereErrors(errors: string[], diagnosis: string): number {
  const fromErrors = errors.filter(containsSevereKeyword).length
  const fromDiagnosis = containsSevereKeyword(diagnosis) ? 1 : 0
  return fromErrors + fromDiagnosis
}

function clampScore(value: number): number {
  return Math.max(SCORE_CALIBRATION.minScore, Math.min(SCORE_CALIBRATION.maxScore, value))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function percentFromUnknown(value: unknown): number | null {
  const num = asFiniteNumber(value)
  if (num == null) return null
  if (num <= 1 && num >= 0) return Math.round(num * 100)
  return Math.round(clampScore(num))
}

function bandFromConfidence(score: number): V61Confidence['band'] {
  if (score >= 90) return 'high'
  if (score >= 80) return 'reliable'
  if (score >= 70) return 'moderate'
  return 'inconclusive'
}

function sigmaComponent(deviation: number, sigma: number): number {
  const safeSigma = Math.max(1e-6, Math.abs(sigma))
  const exponent = -((deviation * deviation) / (2 * safeSigma * safeSigma))
  return clampScore(100 * Math.exp(exponent))
}

function parseBreakdown(analysis: AnalysisLike): V61Breakdown {
  const legacyOverall = percentFromUnknown(analysis.score) ?? 0
  const technique = percentFromUnknown(analysis.technique_score) ?? legacyOverall
  const outcome = percentFromUnknown(analysis.outcome_score) ?? legacyOverall
  const tactics = percentFromUnknown(analysis.tactics_score) ?? legacyOverall
  return {
    technique,
    outcome,
    tactics,
  }
}

function parseConfidence(analysis: AnalysisLike): V61Confidence {
  const confidenceObj =
    analysis.confidence && typeof analysis.confidence === 'object'
      ? (analysis.confidence as Record<string, unknown>)
      : null
  const poseConf = percentFromUnknown(confidenceObj?.pose_confidence) ?? 80
  const tracking = percentFromUnknown(confidenceObj?.tracking_stability) ?? 80
  const visibility = percentFromUnknown(confidenceObj?.visibility_quality) ?? 80
  const explicitScore =
    percentFromUnknown(analysis.confidence_score) ?? percentFromUnknown(confidenceObj?.score)
  const computedScore = Math.round(poseConf * 0.5 + tracking * 0.3 + visibility * 0.2)
  const score = explicitScore ?? computedScore
  const band = bandFromConfidence(score)
  const uncertaintyPlusMinus = Math.max(2, Math.round((100 - score) * 0.2))
  return {
    score: Math.round(clampScore(score)),
    pose_confidence: Math.round(clampScore(poseConf)),
    tracking_stability: Math.round(clampScore(tracking)),
    visibility_quality: Math.round(clampScore(visibility)),
    band,
    uncertainty_plus_minus: uncertaintyPlusMinus,
  }
}

export function calibrateTechniqueScore(analysis: AnalysisLike): number {
  const rawScore =
    typeof analysis?.score === 'number' && Number.isFinite(analysis.score)
      ? analysis.score
      : 0

  const en = analysis?.en ?? {}
  const strengths = toStringList(en.strengths ?? en.observations)
  const technicalErrors = toStringList(en.technical_errors)
  const actionable = toStringList(en.actionable_corrections ?? en.recommendations)
  const diagnosis = typeof en.diagnosis === 'string' ? en.diagnosis : ''
  const severeErrors = countSevereErrors(technicalErrors, diagnosis)
  const sportConfidence =
    typeof analysis?.sport_confidence === 'number' && Number.isFinite(analysis.sport_confidence)
      ? Math.max(0, Math.min(1, analysis.sport_confidence))
      : 1

  const technicalPenalty = Math.min(
    technicalErrors.length * SCORE_CALIBRATION.technicalErrorPenalty,
    SCORE_CALIBRATION.technicalErrorPenaltyCap
  )
  const severePenalty = Math.min(
    severeErrors * SCORE_CALIBRATION.severeTechnicalErrorPenalty,
    SCORE_CALIBRATION.severeTechnicalErrorPenaltyCap
  )
  const actionablePenalty = Math.min(
    actionable.length * SCORE_CALIBRATION.actionablePenalty,
    SCORE_CALIBRATION.actionablePenaltyCap
  )
  const strengthsCredit = Math.min(
    strengths.length * SCORE_CALIBRATION.strengthsCredit,
    SCORE_CALIBRATION.strengthsCreditCap
  )
  const uncertaintyPenalty = (1 - sportConfidence) * SCORE_CALIBRATION.uncertaintyPenaltyMax

  const totalPenalty =
    SCORE_CALIBRATION.baselinePenalty +
    technicalPenalty +
    severePenalty +
    actionablePenalty +
    uncertaintyPenalty -
    strengthsCredit

  const adjusted = rawScore - totalPenalty

  return Math.round(clampScore(adjusted))
}

/** Arithmetic mean of the three pillar scores (matches UI: overall = combo of pillars). */
export function averagePillarOverall(breakdown: V61Breakdown): number {
  return Math.round(
    clampScore((breakdown.technique + breakdown.outcome + breakdown.tactics) / 3)
  )
}

/** @deprecated Use `averagePillarOverall` — equal pillar weights only. */
export const weightedPillarOverall = averagePillarOverall

const SCORE_DISPLAY_BOOST_DEFAULT = 12
const SCORE_DISPLAY_BOOST_MAX = 25

/** Tunable uplift on displayed pillar scores after LLM output (`XEVO_SCORE_DISPLAY_BOOST`, default 12). */
export function parseScoreDisplayBoost(): number {
  const raw = String(process.env.XEVO_SCORE_DISPLAY_BOOST ?? "").trim()
  if (!raw) return SCORE_DISPLAY_BOOST_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n)) return SCORE_DISPLAY_BOOST_DEFAULT
  return Math.max(0, Math.min(SCORE_DISPLAY_BOOST_MAX, Math.round(n)))
}

export function applyScoreDisplayBoost(
  breakdown: V61Breakdown,
  boost: number
): V61Breakdown {
  const b = Math.round(boost)
  if (b <= 0) return breakdown
  return {
    technique: clampScore(breakdown.technique + b),
    outcome: clampScore(breakdown.outcome + b),
    tactics: clampScore(breakdown.tactics + b),
  }
}

export type V61DisplayedScores = V61CalibratedScores & {
  pillarBlendPreBoost: number
  scoreDisplayBoost: number
}

/**
 * Applies display boost to pillars; `rawOverall` / `pillarBlendPreBoost` stay pre-boost for audit.
 */
export function finalizeDisplayedScores(
  v61: V61CalibratedScores,
  boost?: number
): V61DisplayedScores {
  const scoreDisplayBoost = boost ?? parseScoreDisplayBoost()
  const pillarBlendPreBoost = v61.rawOverall
  const breakdown =
    scoreDisplayBoost > 0
      ? applyScoreDisplayBoost(v61.breakdown, scoreDisplayBoost)
      : v61.breakdown
  const overall = averagePillarOverall(breakdown)
  return {
    ...v61,
    overall,
    breakdown,
    rawOverall: pillarBlendPreBoost,
    pillarBlendPreBoost,
    scoreDisplayBoost,
  }
}

/**
 * V6.1 score structure: overall = average of technique, outcome, tactics (shown in app).
 * Legacy text penalties are not subtracted from overall (see `calibration_trace` audit fields).
 */
export function calibrateTechniqueScoreV61(analysis: AnalysisLike): V61CalibratedScores {
  const breakdown = parseBreakdown(analysis)
  const confidence = parseConfidence(analysis)
  const pillarAverage = averagePillarOverall(breakdown)
  const overall = pillarAverage
  return {
    overall,
    rawOverall: pillarAverage,
    breakdown,
    confidence,
  }
}

/** Pre-v6.1.2 penalty stack on a 0–100 score (kept for calibration_trace audit only). */
export function penaltyAdjustedOverallLegacy(analysis: AnalysisLike, baseScore: number): number {
  return calibrateTechniqueScore({ ...analysis, score: baseScore })
}

/**
 * Legacy hook for pro-library retrieval: an earlier version forced scores to ≥80 when the top
 * neighbor was tagged `advanced`, which collapsed real-world distributions. The pipeline now
 * returns the calibrated score unchanged (still clamped 0–100). The neighbor skill is kept in
 * `calibration_trace` for audit only.
 */
export function applyProLibraryTierScoreConstraint(
  calibratedScore: number,
  _topNeighborSkillLevel: string | undefined | null
): number {
  if (!Number.isFinite(calibratedScore)) return calibratedScore
  return Math.round(clampScore(calibratedScore))
}

