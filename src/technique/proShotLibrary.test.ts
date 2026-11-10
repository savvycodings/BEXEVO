import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  findProClip,
  findProImpactStill,
  proClipId,
  proImpactStillDiskPath,
  proImpactStillPublicPath,
  readProContactFrame,
} from './proShotLibrary'

test('findProClip reads the shot and camera file, and the contact map', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-lib-'))
  const dir = path.join(root, 'forehand_volley')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'front.mp4'), 'video')
  fs.writeFileSync(path.join(root, 'contacts.json'), JSON.stringify({ 'forehand_volley:front': 41.2 }))
  const prev = process.env.PRO_LIBRARY_ROOT
  process.env.PRO_LIBRARY_ROOT = root
  try {
    const clip = findProClip('forehand_volley', 'front')
    assert.equal(clip?.id, proClipId('forehand_volley', 'front'))
    assert.equal(clip?.videoPath, path.join(dir, 'front.mp4'))
    assert.equal(readProContactFrame('forehand_volley:front'), 41)
    assert.equal(findProClip('forehand_volley', 'behind'), null)
    assert.equal(readProContactFrame('missing:front'), null)
  } finally {
    if (prev == null) delete process.env.PRO_LIBRARY_ROOT
    else process.env.PRO_LIBRARY_ROOT = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findProImpactStill prefers impact/{preset}__{view}.png', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-impact-'))
  const impact = path.join(root, 'impact')
  fs.mkdirSync(impact, { recursive: true })
  const id = proClipId('forehand_volley', 'front')
  const png = path.join(impact, 'forehand_volley__front.png')
  fs.writeFileSync(png, 'png')
  const prev = process.env.PRO_LIBRARY_ROOT
  process.env.PRO_LIBRARY_ROOT = root
  try {
    assert.equal(proImpactStillDiskPath(id), png)
    assert.equal(proImpactStillPublicPath(id), '/pro-library/impact/forehand_volley__front.png')
    const still = findProImpactStill('forehand_volley', 'front')
    assert.equal(still?.id, id)
    assert.equal(still?.imagePath, png)
    assert.equal(findProImpactStill('forehand_volley', 'behind'), null)
  } finally {
    if (prev == null) delete process.env.PRO_LIBRARY_ROOT
    else process.env.PRO_LIBRARY_ROOT = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findProImpactStill falls back to jpeg when png is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-impact-jpg-'))
  const impact = path.join(root, 'impact')
  fs.mkdirSync(impact, { recursive: true })
  const jpg = path.join(impact, 'forehand_volley__front.jpg')
  fs.writeFileSync(jpg, 'jpg')
  const prev = process.env.PRO_LIBRARY_ROOT
  process.env.PRO_LIBRARY_ROOT = root
  try {
    const still = findProImpactStill('forehand_volley', 'front')
    assert.equal(still?.imagePath, jpg)
  } finally {
    if (prev == null) delete process.env.PRO_LIBRARY_ROOT
    else process.env.PRO_LIBRARY_ROOT = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})
