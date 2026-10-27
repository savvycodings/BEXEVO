import test from 'node:test'
import assert from 'node:assert/strict'
import { mediapipeFramesToOrbit } from './hologramOrbit'

test('mediapipeFramesToOrbit keeps image-space joints and builds the neck', () => {
  const frames = mediapipeFramesToOrbit([
    {
      frame: 3,
      landmarks: {
        NOSE: { x: 0.5, y: 0.2, visibility: 0.9 },
        LEFT_SHOULDER: { x: 0.4, y: 0.4, visibility: 0.8 },
        RIGHT_SHOULDER: { x: 0.6, y: 0.4, visibility: 0.7 },
        LEFT_WRIST: { x: 0.2, y: 0.7, visibility: 0.1 },
      },
    },
  ])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].frame, 3)
  assert.deepEqual(frames[0].keypoints.nose, { x: 0.5, y: 0.2, score: 0.9 })
  assert.deepEqual(frames[0].keypoints.neck, { x: 0.5, y: 0.4, score: 0.7 })
  assert.equal(frames[0].keypoints.left_wrist, undefined)
})
