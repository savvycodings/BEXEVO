import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProLibraryTierScoreConstraint,
  calibrateTechniqueScoreV61,
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
