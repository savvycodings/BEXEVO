/**
 * Copy the downloaded core-shot videos into uploads/pro-library/{stroke}/{camera}.ext
 * Run from FAXevo/server: node scripts/copyProLibrary.mjs
 */
import fs from 'fs'
import path from 'path'

const sourceRoot = path.resolve(process.cwd(), '..', '..', 'AI camera shots')
const destRoot = path.join(process.cwd(), 'uploads', 'pro-library')

const shots = [
  ['NetPlay/Forehand volley', 'forehand_volley'],
  ['NetPlay/Backhand volley', 'backhand_volley'],
  ['Groundstrokes/Forehand drive', 'forehand_drive'],
  ['Groundstrokes/Backhand drive', 'backhand_drive'],
  ['Lobs/Forehand lob', 'forehand_lob'],
  ['Lobs/Backhand lob', 'backhand_lob'],
  ['Overheads/Bandeja', 'bandeja'],
  ['Overheads/Smash', 'smash'],
  ['Serves/Slice serve', 'slice_serve'],
]

const cameras = [
  ['front camera', 'front'],
  ['back camera', 'behind'],
  ['side camera', 'side'],
  ['45 right side left camara', 'deg45_right_side_left_camera'],
  ['45 right side right camara', 'deg45_right_side_right_camera'],
  ['45 left side right camara', 'deg45_left_side_right_camera'],
  ['45 left side left camara', 'deg45_left_side_left_camera'],
]

let copied = 0
const missing = []
for (const [folder, preset] of shots) {
  const dir = path.join(sourceRoot, ...folder.split('/'))
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  for (const [prefix, view] of cameras) {
    const match = files.find((name) => name.toLowerCase().startsWith(prefix))
    if (!match) {
      missing.push(`${preset}/${view}`)
      continue
    }
    const ext = path.extname(match).toLowerCase()
    const destDir = path.join(destRoot, preset)
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, `${view}${ext}`)
    fs.copyFileSync(path.join(dir, match), dest)
    copied += 1
  }
}
console.log(JSON.stringify({ copied, missing, destRoot }, null, 2))
if (missing.length) process.exit(1)
