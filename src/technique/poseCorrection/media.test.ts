import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { countFrames, encodeFrames, extractFrame, extractFramesAt, ffmpeg, probe } from './ffmpeg'
import { openPosePoints, outputSize, renderPoseFrames } from './render'
import { frameOf, standingPose } from './engine/testPoses'

let dir = ''
let clip = ''
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmvp-media-'))
  clip = path.join(dir, 'src.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', clip])
})

test('probe reads duration, size and fps', async () => {
  const p = await probe(clip)
  assert.ok(Math.abs(p.durationS - 2) < 0.05)
  assert.equal(p.width, 320)
  assert.equal(p.height, 240)
  assert.equal(p.fps, 25)
})

test('probe rejects a non-video file', async () => {
  const f = path.join(dir, 'x.gif.txt')
  await fs.writeFile(f, 'hello')
  await assert.rejects(probe(f), /Not a readable video/)
})

test('extractFrame: valid t, t = 0, out of range', async () => {
  const out = path.join(dir, 'f.png')
  await extractFrame(clip, 1.2, out)
  assert.equal((await sharp(out).metadata()).width, 320)
  await extractFrame(clip, 0, out)
  await assert.rejects(extractFrame(clip, 5, out), RangeError)
  await assert.rejects(extractFrame(clip, -1, out), RangeError)
})

test('extractFramesAt + encodeFrames give exactly N frames at the size', async () => {
  const times = Array.from({ length: 81 }, (_, i) => 0.1 + (1.7 * i) / 80)
  const fdir = path.join(dir, 'frames')
  const paths = await extractFramesAt(clip, times, fdir, 160, 128)
  assert.equal(paths.length, 81)
  const out = path.join(dir, 'enc.mp4')
  await encodeFrames(fdir, 30, out)
  const p = await probe(out)
  assert.equal(p.width, 160)
  assert.equal(p.fps, 30)
  assert.equal(await countFrames(out), 81)
})

test('renderPoseFrames draws 81 black-background frames at the provider size', async () => {
  const { w, h } = outputSize(1080, 1920, '480p')
  assert.deepEqual({ w, h }, { w: 480, h: 848 })
  const img = frameOf(standingPose()).image
  const pdir = path.join(dir, 'pose')
  await renderPoseFrames(Array.from({ length: 81 }, () => img), w, h, pdir)
  const files = (await fs.readdir(pdir)).filter((f) => f.endsWith('.png'))
  assert.equal(files.length, 81)
  const meta = await sharp(path.join(pdir, '0001.png')).metadata()
  assert.equal(meta.width, 480)
  assert.equal(meta.height, 848)
  assert.equal(openPosePoints(img, w, h).length, 18)
})
