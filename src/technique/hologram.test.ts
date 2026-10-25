import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSdposeKeypoints } from './hologram'

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
