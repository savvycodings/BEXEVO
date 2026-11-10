/**
 * Extract labeled contact frames from pro-library videos into impact/{preset}__{view}.png.
 * Frames come from contacts.json (CoreShots sheet). Run from FAXevo/server:
 *   node scripts/stageProImpactStills.mjs
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'

const root = path.join(process.cwd(), 'uploads', 'pro-library')
const contactsPath = path.join(root, 'contacts.json')
const impactDir = path.join(root, 'impact')
const VIDEO_EXTS = ['.mp4', '.mov', '.MP4', '.MOV']

if (!fs.existsSync(contactsPath)) {
  console.error('Missing', contactsPath)
  process.exit(1)
}

const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'))
fs.mkdirSync(impactDir, { recursive: true })

const ffmpeg = ffmpegStatic || 'ffmpeg'
let ok = 0
const miss = []

for (const [id, frame] of Object.entries(contacts)) {
  if (typeof frame !== 'number' || !Number.isFinite(frame)) continue
  const [preset, view] = id.split(':')
  if (!preset || !view) continue
  let video = null
  for (const ext of VIDEO_EXTS) {
    const p = path.join(root, preset, `${view}${ext}`)
    if (fs.existsSync(p)) {
      video = p
      break
    }
  }
  if (!video) {
    miss.push(`${id}:novideo`)
    continue
  }
  const out = path.join(impactDir, `${preset}__${view}.jpg`)
  try {
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-i',
        video,
        '-vf',
        `select=eq(n\\,${Math.round(frame)})`,
        '-vframes',
        '1',
        '-q:v',
        '3',
        out,
      ],
      { stdio: 'pipe' }
    )
    if (!fs.existsSync(out) || fs.statSync(out).size < 100) throw new Error('empty')
    ok += 1
  } catch {
    try {
      const t = Math.max(0, Math.round(frame) / 30)
      execFileSync(
        ffmpeg,
        ['-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-q:v', '3', out],
        {
          stdio: 'pipe',
        }
      )
      if (!fs.existsSync(out) || fs.statSync(out).size < 100) throw new Error('empty2')
      ok += 1
    } catch (e2) {
      miss.push(`${id}:${String(e2?.message || e2).slice(0, 80)}`)
    }
  }
}

console.log(JSON.stringify({ ok, missCount: miss.length, miss, impactDir, sample: fs.readdirSync(impactDir).slice(0, 8) }, null, 2))
if (miss.length) process.exit(1)
