import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapMediaPipeToHologramKeypoints,
  parseSdposeKeypoints,
  pickPoseLandmarksForHologram,
} from './hologram'

test('parseSdposeKeypoints names and normalises joints, dropping low-confidence ones', () => {
  const body = Array.from({ length: 18 }, (_, i) => [i * 10, i * 20, 0.9]).flat()
  body[4 * 3 + 2] = 0.1 // right wrist: below threshold
  const text = JSON.stringify([
    {
      canvas_width: 1000,
      canvas_height: 500,
      people: [{ pose_keypoints_2d: body, foot_keypoints_2d: [100, 400, 0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    },
  ])
  const k = parseSdposeKeypoints(text)!
  assert.deepEqual(k.right_elbow, { x: 0.03, y: 0.12, score: 0.9 })
  assert.equal(k.right_wrist, undefined)
  assert.deepEqual(k.left_big_toe, { x: 0.1, y: 0.8, score: 0.8 })
  assert.equal(k.right_heel, undefined)
})

test('parseSdposeKeypoints returns null without a person', () => {
  assert.equal(parseSdposeKeypoints('[{"canvas_width":10,"canvas_height":10,"people":[]}]'), null)
  assert.equal(parseSdposeKeypoints('not json'), null)
})

test('mapMediaPipeToHologramKeypoints projects elbows into the crop and synthesises neck', () => {
  const crop = { left: 100, top: 50, side: 200, srcW: 400, srcH: 400 }
  // Full-frame point at pixel (200,150) -> crop (0.5, 0.5)
  const k = mapMediaPipeToHologramKeypoints(
    {
      LEFT_SHOULDER: { x: 0.4, y: 0.3 },
      RIGHT_SHOULDER: { x: 0.6, y: 0.3 },
      LEFT_ELBOW: { x: 200 / 400, y: 150 / 400 },
      RIGHT_ELBOW: { x: 0.55, y: 0.5 },
    },
    crop
  )!
  assert.deepEqual(k.left_elbow, { x: 0.5, y: 0.5, score: 0.9 })
  assert.ok(k.neck)
  assert.equal(k.neck.x, 0.5)
})

test('pickPoseLandmarksForHologram chooses the nearest frame to contact', () => {
  const poseData = [
    { frame: 10, landmarks: { LEFT_ELBOW: { x: 0.1, y: 0.2 } } },
    { frame: 40, landmarks: { LEFT_ELBOW: { x: 0.4, y: 0.5 } } },
    { frame: 90, landmarks: { LEFT_ELBOW: { x: 0.9, y: 0.9 } } },
  ]
  const lm = pickPoseLandmarksForHologram(poseData, { frame: 42 })!
  assert.equal(lm.LEFT_ELBOW.x, 0.4)
  const byMs = pickPoseLandmarksForHologram(poseData, { contactMs: 3000 }, 30)!
  assert.equal(byMs.LEFT_ELBOW.x, 0.9)
})
