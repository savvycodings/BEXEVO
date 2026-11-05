import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findProClip, proClipId, readProContactFrame } from './proShotLibrary'

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
