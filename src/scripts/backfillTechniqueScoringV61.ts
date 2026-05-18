import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db, techniqueAnalysis } from '../db'
import {
  applyProLibraryTierScoreConstraint,
  calibrateTechniqueScoreV61,
} from '../technique/scoreCalibration'
import { storedAiBreakdownToPercent, storedAiScoreToPercent } from '../technique/techniqueScoreScale'

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function toRating(score: number): 'excellent' | 'good' | 'needs_improvement' | 'poor' {
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  if (score >= 30) return 'needs_improvement'
  return 'poor'
}

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1] ?? 0)) : null
  const rows = await db.query.techniqueAnalysis.findMany({
    where: (ta, { eq: _eq }) => _eq(ta.status, 'completed'),
    orderBy: (ta, { desc: _desc }) => [_desc(ta.createdAt)],
    ...(limit ? { limit } : {}),
  })

  let changed = 0
  for (const row of rows) {
    const metrics = (row.metrics ?? {}) as Record<string, unknown>
    const ai = (metrics.ai_analysis ?? null) as Record<string, unknown> | null
    if (!ai || typeof ai !== 'object') continue

    const ver = String(ai.scoring_version ?? '').toLowerCase()
    const hasV61Already =
      !force &&
      /^v6\.1/.test(ver) &&
      typeof ai.technique_score === 'number' &&
      typeof ai.outcome_score === 'number' &&
      typeof ai.tactics_score === 'number' &&
      typeof ai.confidence_score === 'number'
    if (hasV61Already) continue

    const legacyScore = storedAiScoreToPercent(ai)
    if (legacyScore == null) continue
    const existingBreakdown = storedAiBreakdownToPercent(ai)
    const v61 = calibrateTechniqueScoreV61({
      ...ai,
      score: legacyScore,
      technique_score: existingBreakdown.technique ?? legacyScore,
      outcome_score: existingBreakdown.outcome ?? legacyScore,
      tactics_score: existingBreakdown.tactics ?? legacyScore,
      confidence_score:
        typeof ai.confidence_score === 'number' ? Number(ai.confidence_score) : undefined,
      confidence: ai.confidence,
    })
    const topProSkill =
      (metrics?.retrieval as Record<string, unknown> | undefined)?.neighbors &&
      Array.isArray((metrics?.retrieval as Record<string, unknown>)?.neighbors)
        ? (
            ((metrics?.retrieval as Record<string, unknown>)?.neighbors as Array<Record<string, unknown>>)[0]
              ?.skill_level as string | undefined
          )
        : undefined
    const finalScore = applyProLibraryTierScoreConstraint(v61.overall, topProSkill)

    ai.score = finalScore
    ai.score_scale = 'percent'
    ai.scoring_version = 'v6.1.2'
    ai.technique_score = clampPercent(v61.breakdown.technique)
    ai.outcome_score = clampPercent(v61.breakdown.outcome)
    ai.tactics_score = clampPercent(v61.breakdown.tactics)
    ai.confidence_score = clampPercent(v61.confidence.score)
    ai.breakdown = {
      technique: clampPercent(v61.breakdown.technique),
      outcome: clampPercent(v61.breakdown.outcome),
      tactics: clampPercent(v61.breakdown.tactics),
    }
    ai.confidence = {
      score: clampPercent(v61.confidence.score),
      pose_confidence: clampPercent(v61.confidence.pose_confidence),
      tracking_stability: clampPercent(v61.confidence.tracking_stability),
      visibility_quality: clampPercent(v61.confidence.visibility_quality),
      band: v61.confidence.band,
      uncertainty_plus_minus: v61.confidence.uncertainty_plus_minus,
    }
    ai.rating = toRating(finalScore)
    ai.calibration_trace = {
      ...(typeof ai.calibration_trace === 'object' && ai.calibration_trace
        ? (ai.calibration_trace as Record<string, unknown>)
        : {}),
      migration: force ? 'backfill_v6_1_1_force' : 'backfill_v6_1_1',
      migrated_at: new Date().toISOString(),
      weighted_formula: 'overall = round((technique + outcome + tactics) / 3)',
      pro_library_neighbor_skill: topProSkill ?? null,
      pro_tier_score_constraint: 'disabled_v6.1.2 (no advanced-neighbor floor)',
    }

    if (!dryRun) {
      await db
        .update(techniqueAnalysis)
        .set({
          metrics: {
            ...metrics,
            ai_analysis: ai,
          },
        })
        .where(eq(techniqueAnalysis.id, row.id))
    }
    changed += 1
  }

  console.log(
    `[backfillTechniqueScoringV61] scanned=${rows.length} changed=${changed} dryRun=${dryRun} force=${force}`
  )
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfillTechniqueScoringV61] failed', err)
    process.exit(1)
  })

