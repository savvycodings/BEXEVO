/**
 * Upload bandeja + remate-plano progression mp4s to production BEXEVO.
 *
 * Usage (PowerShell):
 *   $env:DRILLS_UPLOAD_SECRET="..."
 *   node scripts/upload-drills-media.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../drillsMEDIA')
const BASE = process.env.DRILLS_UPLOAD_BASE || 'https://bexevo-production.up.railway.app'
const SECRET = process.env.DRILLS_UPLOAD_SECRET?.trim()

if (!SECRET) {
  console.error('Set DRILLS_UPLOAD_SECRET')
  process.exit(1)
}

const FILES = [
  {
    key: 'bandeja/01-primary.mp4',
    file: path.join(
      ROOT,
      'Bandeja__Bandeja/01-primera-progresion__primary-progression/video/Bandeja (no pala).mp4'
    ),
  },
  {
    key: 'bandeja/02-secondary.mp4',
    file: path.join(
      ROOT,
      'Bandeja__Bandeja/02-segunda-progresion__secondary-progression/video/Bandeja sin bola (2da progresion).mp4'
    ),
  },
  {
    key: 'bandeja/03-tertiary.mp4',
    file: path.join(
      ROOT,
      'Bandeja__Bandeja/03-tercera-progresion__tertiary-progression/video/Bandeja con bola (3ra progresion).mp4'
    ),
  },
  {
    key: 'bandeja/04-final.mp4',
    file: path.join(
      ROOT,
      'Bandeja__Bandeja/04-golpe-final-extras__final-shot-extras/video/Golpe final Bandeja.mp4'
    ),
  },
  {
    key: 'remate-plano/01-primary.mp4',
    file: path.join(
      ROOT,
      'Remate plano__Flat smash/01-primera-progresion__primary-progression/video/Remate Plano (1ra progresion).mp4'
    ),
  },
  {
    key: 'remate-plano/02-secondary.mp4',
    file: path.join(
      ROOT,
      'Remate plano__Flat smash/02-segunda-progresion__secondary-progression/video/Remate plano (2da progresion).mp4'
    ),
  },
  {
    key: 'remate-plano/03-tertiary.mp4',
    file: path.join(
      ROOT,
      'Remate plano__Flat smash/03-tercera-progresion__tertiary-progression/video/Remate plano (3ra progresion).mp4'
    ),
  },
  {
    key: 'remate-plano/03-tertiary-slomo.mp4',
    file: path.join(
      ROOT,
      'Remate plano__Flat smash/03-tercera-progresion__tertiary-progression/video/Remate Plano Slo mo.mp4'
    ),
  },
  {
    key: 'remate-plano/04-final.mp4',
    file: path.join(
      ROOT,
      'Remate plano__Flat smash/04-golpe-final-extras__final-shot-extras/video/Remate plano terminacion slomo.mp4'
    ),
  },
]

async function uploadOne({ key, file }) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing file: ${file}`)
  }
  const buf = fs.readFileSync(file)
  const form = new FormData()
  form.append('key', key)
  form.append('file', new Blob([buf], { type: 'video/mp4' }), path.basename(file))
  const res = await fetch(`${BASE}/drills/media/upload`, {
    method: 'POST',
    headers: { 'x-drills-upload-secret': SECRET },
    body: form,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`Upload failed ${key}: ${res.status} ${text}`)
  }
  console.log('OK', key, json.bytes, json.url)
}

for (const item of FILES) {
  await uploadOne(item)
}
console.log('Done')
