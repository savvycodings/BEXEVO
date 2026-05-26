import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProLibraryTierScoreConstraint,
  applyScoreDisplayBoost,
  calibrateTechniqueScoreV61,
  computeDynamicScoreDisplayBoost,
  finalizeDisplayedScores,
} from './scoreCalibration'

test('applyProLibraryTierScoreConstraint does not floor advanced neighbors at 80', () => {
  assert.equal(applyProLibraryTierScoreConstraint(42, 'advanced'), 42)
  assert.equal(applyProLibraryTierScoreConstraint(42, 'ADVANCED'), 42)
  assert.equal(applyProLibraryTierScoreConstraint(79, 'advanced'), 79)
})

test('applyProLibraryTierScoreConstraint clamps to 0–100', () => {
  assert.equal(applyProLibraryTierScoreConstraint(150, 'advanced'), 100)
  assert.equal(applyProLibraryTierScoreConstraint(-5, null), 0)
})

test('applyProLibraryTierScoreConstraint leaves non-finite scores unchanged', () => {
  assert.equal(applyProLibraryTierScoreConstraint(Number.NaN, 'advanced'), Number.NaN)
})

test('calibrateTechniqueScoreV61 is monotonic in pillar blend (same feedback text)', () => {
  const low = calibrateTechniqueScoreV61({
    score: 70,
    technique_score: 70,
    outcome_score: 70,
    tactics_score: 70,
    en: {},
  })
  const high = calibrateTechniqueScoreV61({
    score: 90,
    technique_score: 90,
    outcome_score: 90,
    tactics_score: 90,
    en: {},
  })
  assert.ok(high.overall > low.overall)
  assert.equal(low.overall, 70)
  assert.equal(high.overall, 90)
})

test('calibrateTechniqueScoreV61 overall matches average of pillars', () => {
  const v = calibrateTechniqueScoreV61({
    score: 80,
    technique_score: 60,
    outcome_score: 80,
    tactics_score: 100,
    en: {},
  })
  assert.equal(v.rawOverall, 80)
  assert.deepEqual(v.breakdown, { technique: 60, outcome: 80, tactics: 100 })
  assert.equal(v.overall, 80)
})

test('applyScoreDisplayBoost with flat mode adds same boost to each pillar', () => {
  const boosted = applyScoreDisplayBoost({ technique: 50, outcome: 50, tactics: 50 }, 12, false)
  assert.deepEqual(boosted, { technique: 62, outcome: 62, tactics: 62 })
})

test('applyScoreDisplayBoost per-pillar differs when pillars differ', () => {
  const boosted = applyScoreDisplayBoost(
    { technique: 40, outcome: 60, tactics: 75 },
    10,
    true
  )
  assert.equal(boosted.technique - 40, 9)
  assert.equal(boosted.tactics - 75, 10)
  assert.ok(boosted.technique < boosted.tactics)
})

test('applyScoreDisplayBoost clamps at 100', () => {
  const boosted = applyScoreDisplayBoost({ technique: 95, outcome: 95, tactics: 95 }, 12, false)
  assert.deepEqual(boosted, { technique: 100, outcome: 100, tactics: 100 })
})

test('finalizeDisplayedScores with boost override 0 leaves scores unchanged', () => {
  const v61 = calibrateTechniqueScoreV61({
    score: 70,
    technique_score: 70,
    outcome_score: 70,
    tactics_score: 70,
    en: {},
  })
  const displayed = finalizeDisplayedScores({ en: {} }, v61, 0)
  assert.equal(displayed.overall, 70)
  assert.equal(displayed.pillarBlendPreBoost, 70)
  assert.equal(displayed.scoreDisplayBoost, 0)
})

test('computeDynamicScoreDisplayBoost: strong session yields high boost', () => {
  const v61 = calibrateTechniqueScoreV61({
    score: 88,
    technique_score: 88,
    outcome_score: 90,
    tactics_score: 86,
    confidence_score: 92,
    en: {
      strengths: ['Good split step', 'Stable base', 'Clean contact'],
      technical_errors: [],
    },
  })
  const { boost, merit } = computeDynamicScoreDisplayBoost(
    {
      en: {
        strengths: ['Good split step', 'Stable base', 'Clean contact'],
        technical_errors: [],
      },
    },
    v61
  )
  assert.ok(merit >= 0.75)
  assert.ok(boost >= 9)
  assert.ok(boost <= 12)
})

test('computeDynamicScoreDisplayBoost: many errors lowers boost vs clean session at same pillars', () => {
  const base = {
    score: 68,
    technique_score: 68,
    outcome_score: 66,
    tactics_score: 70,
    confidence_score: 80,
  }
  const v61 = calibrateTechniqueScoreV61(base)
  const clean = computeDynamicScoreDisplayBoost(
    { en: { strengths: ['Solid rhythm'], technical_errors: [] } },
    v61
  )
  const noisy = computeDynamicScoreDisplayBoost(
    {
      en: {
        technical_errors: [
          'Late contact',
          'Off-balance finish',
          'Poor split step',
          'Wristy swing',
        ],
        actionable_corrections: ['Reset base', 'Earlier prep'],
      },
    },
    v61
  )
  assert.ok(noisy.boost < clean.boost)
  assert.ok(noisy.boost >= 1 && noisy.boost <= 12)
  assert.ok(clean.boost >= 1 && clean.boost <= 12)
})

test('finalizeDisplayedScores dynamic boost changes overall vs raw pillars', () => {
  const v61 = calibrateTechniqueScoreV61({
    score: 65,
    technique_score: 65,
    outcome_score: 65,
    tactics_score: 65,
    en: { strengths: ['Good intent'] },
  })
  const displayed = finalizeDisplayedScores({ en: { strengths: ['Good intent'] } }, v61)
  assert.ok(displayed.scoreDisplayBoost >= 1 && displayed.scoreDisplayBoost <= 12)
  assert.ok(displayed.overall !== displayed.pillarBlendPreBoost || displayed.scoreDisplayBoost === 0)
  assert.equal(displayed.scoreDisplayBoostMerit, displayed.scoreDisplayBoostFactors.merit)
})
