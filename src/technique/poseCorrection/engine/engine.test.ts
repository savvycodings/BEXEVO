import { test } from 'node:test'
import assert from 'node:assert/strict'
import { correctFrame, easeIn } from './correct'
import { defaultStrengths, listCorrections } from './corrections'
import { densify, LM, mirrorTrack, rejectPoseOutliers } from './landmarks'
import { fitScale, projectCorrection } from './project'
import { alignReference, detectStroke, warpTime } from './stroke'
import { frameOf, standingPose, trackOf } from './testPoses'
import type { Strengths, StrokeInfo, Vec3 } from './types'
import { angleAt, len, sub } from './vec'
import { estimateCost, planWindow, WindowError } from './window'
import { facingRatio, viewsDiffer } from './view'

const ZERO: Strengths = { racketArm: 0, freeArm: 0, trunk: 0, legs: 0 }
const R = { sh: LM.RIGHT_SHOULDER, el: LM.RIGHT_ELBOW, wr: LM.RIGHT_WRIST }
const elbow = (w: Vec3[]) => angleAt(w[R.sh]!, w[R.el]!, w[R.wr]!)
const close = (a: number, b: number, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)

test('hinge formula: 140° vs 165° → 152.5° at 0.5, 127.5° at −0.5, 165° at 1', () => {
  const player = standingPose({ elbowDeg: 140 })
  const ref = standingPose({ elbowDeg: 165 })
  close(elbow(correctFrame(player, ref, 'RIGHT', { ...ZERO, racketArm: 0.5 })), 152.5)
  close(elbow(correctFrame(player, ref, 'RIGHT', { ...ZERO, racketArm: -0.5 })), 127.5)
  close(elbow(correctFrame(player, ref, 'RIGHT', { ...ZERO, racketArm: 1 })), 165)
  close(elbow(correctFrame(player, ref, 'RIGHT', { ...ZERO, racketArm: 1.5 })), 177.5)
})

test('strength 0 everywhere is the identity', () => {
  const player = standingPose({ elbowDeg: 120, kneeDeg: 150 })
  const ref = standingPose({ elbowDeg: 170, kneeDeg: 175 })
  const out = correctFrame(player, ref, 'RIGHT', ZERO)
  out.forEach((p, i) => p.forEach((v, k) => close(v, player[i]![k]!, 1e-6)))
})

test("bone lengths stay the player's own", () => {
  const player = standingPose({ elbowDeg: 120, armLen: 0.25 })
  const ref = standingPose({ elbowDeg: 170, armLen: 0.35, kneeDeg: 130 })
  const out = correctFrame(player, ref, 'RIGHT', { racketArm: 1, freeArm: 1, trunk: 1, legs: 1.5 })
  const bones: Array<[number, number]> = [
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
    [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
  ]
  for (const [a, b] of bones) {
    const before = len(sub(player[a]!, player[b]!))
    const after = len(sub(out[a]!, out[b]!))
    assert.ok(Math.abs(after - before) / before < 0.01, `bone ${a}-${b}: ${before} → ${after}`)
  }
})

test('regions at 0 are untouched while racket arm is corrected', () => {
  const player = standingPose({ elbowDeg: 140, kneeDeg: 150 })
  const ref = standingPose({ elbowDeg: 165, kneeDeg: 175 })
  const out = correctFrame(player, ref, 'RIGHT', { ...ZERO, racketArm: 1 })
  for (const j of [LM.LEFT_ELBOW, LM.LEFT_WRIST, LM.LEFT_KNEE, LM.RIGHT_ANKLE, LM.LEFT_SHOULDER]) {
    player[j]!.forEach((v, k) => close(out[j]![k]!, v, 1e-6))
  }
  assert.notDeepEqual(out[R.wr], player[R.wr])
})

test('ease-in ramps 0 → 1 over 0.3 s', () => {
  assert.equal(easeIn(1, 1), 0)
  assert.equal(easeIn(1.3, 1), 1)
  close(easeIn(1.15, 1), 0.5, 1e-9)
})

test('uncorrected pose reprojects onto the original image', () => {
  const world = standingPose({ elbowDeg: 140 })
  const f = frameOf(world)
  const a = fitScale(f, 1080, 1920)!
  close(a, 400, 1e-6)
  const img = projectCorrection(f, world, a, 1080, 1920)
  img.forEach((p, i) => { close(p[0]!, f.image[i]![0]!, 1e-9); close(p[1]!, f.image[i]![1]!, 1e-9) })
  // a corrected wrist moves by the projected world change
  const moved = world.map((p) => [...p] as Vec3)
  moved[R.wr] = [moved[R.wr]![0] + 0.1, moved[R.wr]![1], moved[R.wr]![2]]
  const img2 = projectCorrection(f, moved, a, 1080, 1920)
  close((img2[R.wr]![0]! - f.image[R.wr]![0]!) * 1080, 40, 1e-6)
})

/** Synthetic swing: the right wrist sweeps fastest around frame `peak`. */
function swingTrack(n: number, peak: number, side: 'RIGHT' | 'LEFT' = 'RIGHT') {
  const wrist = side === 'RIGHT' ? R.wr : LM.LEFT_WRIST
  const frames = Array.from({ length: n }, (_, i) => {
    const w = standingPose()
    const x = 0.6 * Math.tanh((i - peak) / 3) // fastest at `peak`
    w[wrist] = [w[wrist]![0] + x, w[wrist]![1], w[wrist]![2]]
    return frameOf(w, i / 30)
  })
  return trackOf(frames)
}

test('stroke: racket side, contact at peak wrist speed, start/end around it', () => {
  const s = detectStroke(swingTrack(60, 30))
  assert.equal(s.racketSide, 'RIGHT')
  assert.ok(Math.abs(s.contactFrame - 30) <= 1, `contact ${s.contactFrame}`)
  assert.ok(s.startFrame < 30 && s.endFrame > 30)
  assert.equal(detectStroke(swingTrack(60, 20, 'LEFT')).racketSide, 'LEFT')
  assert.equal(detectStroke(swingTrack(60, 30), { contactT: 1 }).contactFrame, 30)
})

test('time warp pairs the same stroke phase', () => {
  const p: StrokeInfo = { racketSide: 'RIGHT', startFrame: 10, contactFrame: 30, endFrame: 40, startT: 1 / 3, contactT: 1, endT: 4 / 3 }
  const r: StrokeInfo = { racketSide: 'RIGHT', startFrame: 20, contactFrame: 80, endFrame: 100, startT: 20 / 60, contactT: 80 / 60, endT: 100 / 60 }
  close(warpTime(1, p, r, 60), 80, 1e-6) // contact ↔ contact
  close(warpTime(1 / 3, p, r, 60), 20, 1e-6) // start ↔ start
  close(warpTime(4 / 3, p, r, 60), 100, 1e-6) // end ↔ end
  close(warpTime(2 / 3, p, r, 60), 50, 1e-6) // halfway to contact
})

test('mirroring swaps names and flips x', () => {
  const tr = densify({ ...swingTrack(10, 5), frames: swingTrack(10, 5).frames })
  const m = mirrorTrack(tr)
  const f = tr.frames[3]!
  const g = m.frames[3]!
  close(g.image[LM.LEFT_WRIST]![0]!, 1 - f.image[R.wr]![0]!, 1e-9)
  close(g.world[LM.LEFT_WRIST]![0], -f.world[R.wr]![0], 1e-9)
  assert.equal(detectStroke(m).racketSide, 'LEFT')
})

test('corrections list: bent elbow at contact, and empty when close', () => {
  const stroke: StrokeInfo = { racketSide: 'RIGHT', startFrame: 0, contactFrame: 1, endFrame: 2, startT: 0, contactT: 1 / 30, endT: 2 / 30 }
  const player = [0, 1, 2].map((i) => frameOf(standingPose({ elbowDeg: i === 1 ? 140 : 165 }), i / 30))
  const ref = [0, 1, 2].map((i) => frameOf(standingPose({ elbowDeg: 165 }), i / 30))
  const list = listCorrections(player, ref, stroke, 10)
  assert.equal(list.length, 1)
  const c = list[0]!
  assert.equal(c.region, 'racketArm')
  assert.equal(c.phase, 'contact')
  close(c.playerDeg, 140, 0.2)
  close(c.refDeg, 165, 0.2)
  assert.match(c.sentence, /140° vs pro 165° \(25° more bent/)
  assert.deepEqual(defaultStrengths(list), { racketArm: 1, freeArm: 0, trunk: 0, legs: 0 })
  assert.deepEqual(listCorrections(ref, ref, stroke, 10), [])
})

test('alignReference returns one reference pose per player frame', () => {
  const player = swingTrack(30, 15)
  const ref = swingTrack(60, 40)
  const ps = detectStroke(player)
  const rs = detectStroke(ref)
  const al = alignReference(player, ps, ref, rs)
  assert.equal(al.length, 30)
})

const stroke = (s: number, c: number, e: number): StrokeInfo => ({
  racketSide: 'RIGHT', startFrame: 0, contactFrame: 0, endFrame: 0, startT: s, contactT: c, endT: e,
})

test('window: short stroke widens to 2.7 s around contact, 81 frames at 30 fps', () => {
  const w = planWindow(stroke(1.0, 1.2, 1.5), 6, 5)
  close(w.end - w.start, 2.7, 1e-6)
  close((w.start + w.end) / 2, 1.2 + 0.0, 1e-6 + 0.2) // shifted into the clip if needed
  assert.equal(w.fps, 30)
  assert.equal(w.times.length, 81)
  close(w.billedSeconds, 81 / 16, 1e-9)
})

test('window: clip shorter than 2.7 s uses the whole clip', () => {
  const w = planWindow(stroke(0.5, 1.2, 1.8), 2.6, 5)
  assert.equal(w.start, 0)
  close(w.end, 2.6, 1e-9)
  assert.equal(w.fps, 30)
})

test('window: long stroke keeps its length and lowers fps; over cap is rejected', () => {
  const w = planWindow(stroke(1, 2, 4.4), 10, 5)
  close(w.end - w.start, 4.0, 1e-6)
  assert.equal(w.fps, 20)
  assert.throws(() => planWindow(stroke(1, 3, 6), 10, 5), WindowError)
  assert.throws(() => planWindow(stroke(1, 2, 3), 10, 5, { start: 0, end: 6 }), WindowError)
  assert.throws(() => planWindow(stroke(1, 2, 3), 10, 5, { start: 2, end: 2 }), WindowError)
})

test('cost = 81/16 × price', () => {
  assert.equal(estimateCost(81 / 16, 0.04), 0.203)
})

test('stroke start includes a backswing separated by a short pause', () => {
  // speed humps: backswing (frames 10–20, ~40% of peak), pause (21–22, ~15%), swing peak at 30
  const n = 50
  const frames = Array.from({ length: n }, (_, i) => frameOf(standingPose(), i / 30))
  let x = 0
  const speed = (i: number) =>
    i >= 10 && i <= 20 ? 0.4 : i === 21 || i === 22 ? 0.15 : i >= 23 && i <= 36 ? 1 - Math.abs(i - 30) / 8 : 0.01
  frames.forEach((f, i) => {
    x += speed(i) * 0.02
    f.image[R.wr] = [0.5 + x, 0.5, 0, 1]
  })
  const s = detectStroke(trackOf(frames))
  assert.ok(Math.abs(s.contactFrame - 30) <= 1, `contact ${s.contactFrame}`)
  assert.ok(s.startFrame <= 11, `start ${s.startFrame} should include the backswing`)
})

test('default strengths: racket arm only', () => {
  const c = (region: 'racketArm' | 'trunk' | 'legs') => ({ region, phase: 'contact' as const, joint: '', playerDeg: 0, refDeg: 20, deltaDeg: 20, sentence: '' })
  assert.deepEqual(defaultStrengths([c('racketArm'), c('trunk'), c('legs')]), { racketArm: 1, freeArm: 0, trunk: 0, legs: 0 })
  assert.deepEqual(defaultStrengths([c('trunk')]), { racketArm: 0, freeArm: 0, trunk: 0, legs: 0 })
})

test('camera angle: front vs side is refused, front vs front accepted', () => {
  const front = trackOf([frameOf(standingPose())])
  // side view: shoulders and hips collapse onto one x in the image
  const sideFrame = frameOf(standingPose())
  for (const i of [11, 12, 23, 24]) sideFrame.image[i]![0] = 0.5 + (i % 2 ? 0.003 : -0.003)
  const side = trackOf([sideFrame])
  assert.ok(facingRatio(front) > 0.45, `front ${facingRatio(front)}`)
  assert.ok(facingRatio(side) < 0.3, `side ${facingRatio(side)}`)
  assert.equal(viewsDiffer(front, side), true)
  assert.equal(viewsDiffer(front, front), false)
})

test('racket side override wins over the fastest wrist', () => {
  assert.equal(detectStroke(swingTrack(60, 30, 'LEFT'), { racketSide: 'RIGHT' }).racketSide, 'RIGHT')
})

test('pose outliers: a jump to a smaller person in the background is dropped and filled', () => {
  const frames = Array.from({ length: 12 }, (_, i) => frameOf(standingPose(), i / 30))
  // frames 5–6: the tracker jumps 0.2 to the left onto a figure at 60% size
  for (const i of [5, 6]) {
    const small = standingPose().map((p) => [p[0] * 0.6, p[1] * 0.6, p[2]] as Vec3)
    const f = frameOf(small, i / 30)
    frames[i] = { ...f, image: f.image.map((p) => [p[0]! - 0.2, p[1]!, p[2]!, p[3]!]) }
  }
  const cleaned = rejectPoseOutliers({ ...trackOf(frames), frames: frames.map((f) => ({ t: f.t, image: f.image, world: f.world })) })
  assert.equal(cleaned.frames[5]!.image, null)
  assert.equal(cleaned.frames[6]!.image, null)
  assert.ok(cleaned.frames[4]!.image && cleaned.frames[7]!.image)
  const dense = densify(cleaned)
  close(dense.frames[5]!.image[LM.NOSE]![0]!, frames[4]!.image[LM.NOSE]![0]!, 1e-6)
})

test('pose outliers: a steady track is untouched', () => {
  const frames = Array.from({ length: 12 }, (_, i) => frameOf(standingPose({ kneeDeg: 150 + i }), i / 30))
  const cleaned = rejectPoseOutliers({ ...trackOf(frames), frames: frames.map((f) => ({ t: f.t, image: f.image, world: f.world })) })
  assert.equal(cleaned.frames.filter((f) => f.image).length, 12)
})
