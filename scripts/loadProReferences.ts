/**
 * Loads the curated pro references (pro-references.json) into the pro_reference table:
 * runs the local MediaPipe script (../correction-mvp/pose) on each clip and upserts the pose.
 *
 *   pnpm exec tsx scripts/loadProReferences.ts                 # DATABASE_URL from .env
 *   pnpm exec tsx scripts/loadProReferences.ts --env .env.e2e  # the local test database
 *   ... --fixture-out src/e2e/fixtures                         # also save poses as e2e fixtures
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { parse } from 'dotenv'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const envFile = flag('--env')
if (envFile) Object.assign(process.env, parse(fs.readFileSync(envFile)))
else require('dotenv').config()
const fixtureOut = flag('--fixture-out')

type Entry = { id: string; file: string; strokePreset: string; racketSide: 'LEFT' | 'RIGHT'; sourceLabel?: string }

async function main() {
  const { upsertProReference } = await import('../src/technique/poseCorrection/proReferences')
  const entries = JSON.parse(fs.readFileSync('pro-references.json', 'utf8')) as Entry[]
  const poseDir = path.resolve('..', 'correction-mvp', 'pose')
  for (const e of entries) {
    if (!fs.existsSync(e.file)) throw new Error(`missing clip for ${e.id}: ${e.file}`)
    const tmp = path.join(require('os').tmpdir(), `${e.id}.pose.json`)
    execFileSync('uv', ['run', '--project', poseDir, 'python', path.join(poseDir, 'analyze.py'), path.resolve(e.file), tmp], { stdio: 'ignore' })
    const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    const pose = { fps: raw.fps, width: raw.width, height: raw.height, frames: raw.frames }
    const r = await upsertProReference({ id: e.id, strokePreset: e.strokePreset, racketSide: e.racketSide, sourceLabel: e.sourceLabel, pose })
    if (fixtureOut) fs.writeFileSync(path.join(fixtureOut, `pro-${e.id}.json`), JSON.stringify({ ...e, pose }))
    console.log(`${e.id}: ${pose.frames.length} frames, facing ${r.facingRatio.toFixed(2)}, detection ${(raw.detectionRate * 100).toFixed(0)}%`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
