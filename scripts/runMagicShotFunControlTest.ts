/**
 * Offline Magic Shot Fun Control smoke test for IMG_0252 assets.
 * No fal. No orbit. Writes into magic-shots-repo/test-bh-lob-0252/.
 *
 *   npx tsx scripts/runMagicShotFunControlTest.ts
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {
  generatePoseRetargetVideoComfy,
  isComfyFunControlConfigured,
} from '../src/technique/comfyVideo'

const outDir = path.resolve(__dirname, '../../../magic-shots-repo/test-bh-lob-0252')
const startPath = path.join(outDir, 'start.png')
const posePath = path.join(outDir, 'pose.mp4')

async function preferLocalComfy() {
  const local = 'http://127.0.0.1:8188'
  try {
    const r = await fetch(`${local}/system_stats`, { signal: AbortSignal.timeout(3000) })
    if (r.ok) process.env.COMFYUI_BASE_URL = local
  } catch {
    /* keep env */
  }
}

async function main() {
  await preferLocalComfy()
  if (!fs.existsSync(startPath) || !fs.existsSync(posePath)) {
    throw new Error(`Missing start.png or pose.mp4 in ${outDir}`)
  }
  if (!isComfyFunControlConfigured()) {
    throw new Error('Comfy Fun Control not configured')
  }
  console.log('[fun] start', {
    base: process.env.COMFYUI_BASE_URL,
    workflow: process.env.COMFYUI_FUN_CONTROL_WORKFLOW_PATH,
  })
  const t0 = Date.now()
  const buf = await generatePoseRetargetVideoComfy({
    analysisId: 'bh-lob-0252',
    frameNumber: 32,
    imageBuffer: fs.readFileSync(startPath),
    poseVideoBuffer: fs.readFileSync(posePath),
    shotName: 'Backhand Lob',
    handedness: 'right',
    length: 33,
    width: 448,
    height: 768,
    poseGuidance: 'strict',
    controlHandoff: { end: 1, tail: 'none' },
  })
  const outPath = path.join(outDir, `comfy-fun-control-${Date.now()}.mp4`)
  fs.writeFileSync(outPath, buf)
  console.log(
    '[fun] wrote',
    outPath,
    `${(buf.length / 1e6).toFixed(2)} MB`,
    `${Math.round((Date.now() - t0) / 1000)}s`
  )
}

main().catch((e) => {
  console.error('[fun] failed', e)
  process.exit(1)
})
