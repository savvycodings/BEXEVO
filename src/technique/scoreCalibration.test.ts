import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProLibraryTierScoreConstraint,
  applyScoreDisplayBoost,
  calibrateTechniqueScoreV61,
  finalizeDisplayedScores,
  parseScoreDisplayBoost,
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

test('applyScoreDisplayBoost adds boost to each pillar', () => {
  const boosted = applyScoreDisplayBoost(
    { technique: 50, outcome: 50, tactics: 50 },
    12
  )
  assert.deepEqual(boosted, { technique: 62, outcome: 62, tactics: 62 })
  assert.equal(finalizeDisplayedScores(
    calibrateTechniqueScoreV61({
      score: 50,
      technique_score: 50,
      outcome_score: 50,
      tactics_score: 50,
      en: {},
    }),
    12
  ).overall, 62)
})

test('applyScoreDisplayBoost clamps at 100', () => {
  const boosted = applyScoreDisplayBoost(
    { technique: 95, outcome: 95, tactics: 95 },
    12
  )
  assert.deepEqual(boosted, { technique: 100, outcome: 100, tactics: 100 })
})

test('finalizeDisplayedScores with boost 0 leaves scores unchanged', () => {
  const v61 = calibrateTechniqueScoreV61({
    score: 70,
    technique_score: 70,
    outcome_score: 70,
    tactics_score: 70,
    en: {},
  })
  const displayed = finalizeDisplayedScores(v61, 0)
  assert.equal(displayed.overall, 70)
  assert.equal(displayed.pillarBlendPreBoost, 70)
  assert.equal(displayed.scoreDisplayBoost, 0)
})

test('parseScoreDisplayBoost defaults to 12 when env unset', () => {
  const prev = process.env.XEVO_SCORE_DISPLAY_BOOST
  delete process.env.XEVO_SCORE_DISPLAY_BOOST
  try {
    assert.equal(parseScoreDisplayBoost(), 12)
  } finally {
    if (prev === undefined) delete process.env.XEVO_SCORE_DISPLAY_BOOST
    else process.env.XEVO_SCORE_DISPLAY_BOOST = prev
  }
})
