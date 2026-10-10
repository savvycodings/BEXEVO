import { test } from 'node:test'
import assert from 'node:assert/strict'
import { correctFrame } from './engine/correct'
import { standingPose } from './engine/testPoses'
import { angleAt } from './engine/vec'
import { LM } from './engine/landmarks'
import { playerTrackFromStored, racketSideFromMetrics, resolveStrengths, selectProReference, PoseCorrectionError } from './inputs'

const ZERO = { racketArm: 0, freeArm: 0, trunk: 0, legs: 0 }
const refs = [
  { id: 'fv-front', strokePreset: 'forehand_volley', racketSide: 'RIGHT', facingRatio: 0.65 },
  { id: 'fv-side', strokePreset: 'forehand_volley', racketSide: 'RIGHT', facingRatio: 0.21 },
  { id: 'bandeja-side', strokePreset: 'bandeja', racketSide: 'RIGHT', facingRatio: 0.2 },
]

test('matching reference: front-view player gets the front-view forehand volley', () => {
  assert.equal(selectProReference(refs, 'forehand_volley', 0.68).id, 'fv-front')
  assert.equal(selectProReference(refs, 'forehand_volley', 0.22).id, 'fv-side')
})

test('no reference for the stroke is refused', () => {
  assert.throws(() => selectProReference(refs, 'smash', 0.6), (e: unknown) => e instanceof PoseCorrectionError && /smash/.test(e.message))
})

test('only side-view references for a front-view player is refused', () => {
  assert.throws(() => selectProReference(refs, 'bandeja', 0.68), /camera angle/)
})

test('old analysis without world landmarks asks for a re-analyze', () => {
  const old = [{ frame: 0, landmarks: { NOSE: { x: 0.5, y: 0.2 } } }]
  assert.throws(() => playerTrackFromStored(old, { fps: 30, width: 1080, height: 1920 }), (e: unknown) => e instanceof PoseCorrectionError && e.status === 409 && /Re-analyze/.test(e.message))
})

test('stored frames become a full-length track with gaps as null', () => {
  const w = { NOSE: { x: 0, y: -0.6, z: 0 } }
  const l = { NOSE: { x: 0.5, y: 0.2, z: 0, visibility: 0.9 } }
  const t = playerTrackFromStored([{ frame: 0, landmarks: l, world: w }, { frame: 2, landmarks: l, world: w }], { fps: 30, width: 100, height: 200 })
  assert.equal(t.frames.length, 3)
  assert.equal(t.frames[1]!.image, null)
  assert.equal(t.frames[2]!.image![0]![3], 0.9)
})

test('racket hand from the stored dominant hand', () => {
  assert.equal(racketSideFromMetrics({ stroke_side: { dominant_hand: 'right' } }), 'RIGHT')
  assert.equal(racketSideFromMetrics({ stroke_side: { dominant_hand: 'left' } }), 'LEFT')
  assert.equal(racketSideFromMetrics({}), undefined)
})

test('explicit strengths: −0.5 moves the racket arm away from the pro by half the difference', () => {
  const s = resolveStrengths({ racketArm: -0.5 }, { ...ZERO, racketArm: 1 })
  assert.deepEqual(s, { ...ZERO, racketArm: -0.5 })
  const out = correctFrame(standingPose({ elbowDeg: 140 }), standingPose({ elbowDeg: 165 }), 'RIGHT', s)
  const elbow = angleAt(out[LM.RIGHT_SHOULDER]!, out[LM.RIGHT_ELBOW]!, out[LM.RIGHT_WRIST]!)
  assert.ok(Math.abs(elbow - 127.5) < 0.5, `elbow ${elbow}`)
  assert.throws(() => resolveStrengths({ racketArm: 3 }, ZERO), /between/)
  assert.throws(() => resolveStrengths({ nose: 1 }, ZERO), /Unknown region/)
})
