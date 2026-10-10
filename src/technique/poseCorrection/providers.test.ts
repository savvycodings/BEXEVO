import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { falVaceProvider, resolvePoseVideoProvider, type FalLike } from './providers'
import { estimateCost } from './engine/window'

test('provider selection: fake in fakes mode, fal VACE by default, unknown id errors', () => {
  assert.equal(resolvePoseVideoProvider({ XEVO_E2E_FAKES: '1' }).id, 'fake')
  assert.equal(resolvePoseVideoProvider({}).id, 'fal-wan-vace-pose')
  assert.throws(() => resolvePoseVideoProvider({ XEVO_POSE_VIDEO_PROVIDER: 'nope' }), /Unknown/)
})

test('cost = 81/16 × price', () => {
  assert.equal(estimateCost(81 / 16, resolvePoseVideoProvider({}).pricePerSecond('480p')), 0.203)
})

test('fal VACE input: skeleton without preprocessing, real first frame', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-prov-'))
  await fs.writeFile(path.join(dir, 'pose.mp4'), 'v')
  await fs.writeFile(path.join(dir, 'first.png'), 'i')
  let sent: Record<string, unknown> = {}
  const client: FalLike = {
    config: () => {},
    storage: { upload: async (b: Blob) => `https://fal.test/${b.type}` },
    subscribe: async (_e, o) => {
      sent = o.input
      return { data: { video: { url: 'https://fal.test/out.mp4' } }, requestId: 'req-1' }
    },
  }
  const prev = process.env.FAL_KEY
  process.env.FAL_KEY = 'test'
  const p = falVaceProvider({ id: 'x', endpoint: 'fal-ai/wan-vace-14b/pose', prices: { '480p': 0.04, '580p': 0.06, '720p': 0.08 }, client, downloader: async () => {} })
  const r = await p.generate(
    { poseVideoPath: path.join(dir, 'pose.mp4'), firstFramePath: path.join(dir, 'first.png'), prompt: 'p', negativePrompt: 'n', numFrames: 81, fps: 30, resolution: '480p', seed: 7 },
    path.join(dir, 'out.mp4'),
  )
  process.env.FAL_KEY = prev
  assert.equal(sent.preprocess, false)
  assert.equal(sent.first_frame_url, 'https://fal.test/image/png')
  assert.equal(sent.video_url, 'https://fal.test/video/mp4')
  assert.equal(sent.num_frames, 81)
  assert.equal(r.requestId, 'req-1')
})
