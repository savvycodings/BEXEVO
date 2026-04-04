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
  en?: AnalysisSection
}

const SCORE_CALIBRATION = {
  baselinePenalty: 0.8,
  technicalErrorPenalty: 0.2,
  technicalErrorPenaltyCap: 0.8,
  severeTechnicalErrorPenalty: 0.15,
  severeTechnicalErrorPenaltyCap: 0.4,
  actionablePenalty: 0.1,
  actionablePenaltyCap: 0.3,
  strengthsCredit: 0.1,
  strengthsCreditCap: 0.4,
  uncertaintyPenaltyMax: 0.2,
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
  maxScore: 10,
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

/**
 * When the closest pro-library clip is tagged `advanced`, keep the technique score in 8–10 only
 * (excellent band). Stops very low calibrated scores next to an advanced reference.
 */
export function applyProLibraryTierScoreConstraint(
  calibratedScore: number,
  topNeighborSkillLevel: string | undefined | null
): number {
  if (!Number.isFinite(calibratedScore)) return calibratedScore
  const rounded = Math.round(clampScore(calibratedScore))
  const level = String(topNeighborSkillLevel ?? '')
    .toLowerCase()
    .trim()
  if (level === 'advanced') {
    return Math.max(8, Math.min(10, rounded))
  }
  return rounded
}

