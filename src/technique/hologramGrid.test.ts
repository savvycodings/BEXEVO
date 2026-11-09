import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  HOLOGRAM_GRID_CELL,
  HOLOGRAM_GRID_SIZE,
  buildHologramGrid,
  partCenter,
  sliceHologramGrid,
} from './hologramGrid'

test('partCenter uses MediaPipe landmarks for torso and racket side', () => {
  const landmarks = {
    LEFT_SHOULDER: { x: 0.4, y: 0.3, visibility: 0.9 },
    RIGHT_SHOULDER: { x: 0.6, y: 0.3, visibility: 0.9 },
    LEFT_HIP: { x: 0.42, y: 0.55, visibility: 0.9 },
    RIGHT_HIP: { x: 0.58, y: 0.55, visibility: 0.9 },
    RIGHT_WRIST: { x: 0.7, y: 0.45, visibility: 0.95 },
    LEFT_WRIST: { x: 0.3, y: 0.45, visibility: 0.2 },
  }
  const torso = partCenter(landmarks, 'torso', 'RIGHT')!
  assert.ok(Math.abs(torso.x - 0.5) < 0.01)
  assert.ok(torso.y > 0.3 && torso.y < 0.55)
  assert.deepEqual(partCenter(landmarks, 'racket', 'RIGHT'), { x: 0.7, y: 0.45 })
  assert.equal(partCenter(landmarks, 'head', 'RIGHT'), null)
})

test('buildHologramGrid and sliceHologramGrid round-trip cell 0', async () => {
  const source = await sharp({
    create: { width: 900, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer()
  const fullBody = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer()
  const landmarks = {
    NOSE: { x: 0.5, y: 0.2, visibility: 0.9 },
    LEFT_SHOULDER: { x: 0.4, y: 0.35, visibility: 0.9 },
    RIGHT_SHOULDER: { x: 0.6, y: 0.35, visibility: 0.9 },
    LEFT_ELBOW: { x: 0.35, y: 0.45, visibility: 0.9 },
    RIGHT_ELBOW: { x: 0.65, y: 0.45, visibility: 0.9 },
    LEFT_WRIST: { x: 0.3, y: 0.5, visibility: 0.9 },
    RIGHT_WRIST: { x: 0.7, y: 0.5, visibility: 0.9 },
    LEFT_HIP: { x: 0.42, y: 0.55, visibility: 0.9 },
    RIGHT_HIP: { x: 0.58, y: 0.55, visibility: 0.9 },
    LEFT_KNEE: { x: 0.44, y: 0.7, visibility: 0.9 },
    RIGHT_KNEE: { x: 0.56, y: 0.7, visibility: 0.9 },
    LEFT_ANKLE: { x: 0.45, y: 0.85, visibility: 0.9 },
    RIGHT_ANKLE: { x: 0.55, y: 0.85, visibility: 0.9 },
  }
  const built = await buildHologramGrid({
    sourceFrame: source,
    fullBody,
    landmarks,
    fullBodyCrop: { left: 150, top: 200, side: 600, srcW: 900, srcH: 1200 },
    racketSide: 'RIGHT',
  })
  const meta = await sharp(built.grid).metadata()
  assert.equal(meta.width, HOLOGRAM_GRID_SIZE)
  assert.equal(meta.height, HOLOGRAM_GRID_SIZE)
  assert.ok(built.filledParts.includes('head'))
  assert.ok(built.filledParts.includes('racket'))

  const sliced = await sliceHologramGrid(built.grid, HOLOGRAM_GRID_CELL)
  const fullMeta = await sharp(sliced.full).metadata()
  assert.equal(fullMeta.width, HOLOGRAM_GRID_CELL)
  assert.ok(sliced.parts.head)
  assert.ok(sliced.parts.torso)
})
