/**
 * Writes the e2e fakes fixtures from an analysis that already exists (read-only):
 *   src/e2e/fixtures/modal-analyze.json  — the Modal analyzer response, rebuilt
 *   src/e2e/fixtures/llm-analyze.json    — the analysis write-up the LLM returned
 *   src/e2e/fixtures/correction-image.png — a frame of the clip, used as the fake correction image
 *   src/e2e/fixtures/correction-video.mp4 — 2 s of the clip, used as the fake correction video
 *
 *   pnpm exec tsx scripts/recordE2eFixtures.ts [analysisId]
 *
 * Default analysis: 31230651…, the forehand volley in src/e2e/fixtures/player-forehand-volley.mp4.
 *
 * Analyses stored before the analyzer returned 3D landmarks have no `world` per frame; those are
 * computed with the local MediaPipe script (../correction-mvp/pose, uv) on the same clip and
 * merged by frame number.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Client } from 'pg'
import ffmpegPath from 'ffmpeg-static'

const ANALYSIS_ID = process.argv[2] ?? '31230651-d7d3-4dcd-9566-5eedaf77b3ab'
const OUT = path.join(process.cwd(), 'src', 'e2e', 'fixtures')

const MP_NAMES = [
  'NOSE', 'LEFT_EYE_INNER', 'LEFT_EYE', 'LEFT_EYE_OUTER', 'RIGHT_EYE_INNER', 'RIGHT_EYE', 'RIGHT_EYE_OUTER',
  'LEFT_EAR', 'RIGHT_EAR', 'MOUTH_LEFT', 'MOUTH_RIGHT', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'LEFT_ELBOW',
  'RIGHT_ELBOW', 'LEFT_WRIST', 'RIGHT_WRIST', 'LEFT_PINKY', 'RIGHT_PINKY', 'LEFT_INDEX', 'RIGHT_INDEX',
  'LEFT_THUMB', 'RIGHT_THUMB', 'LEFT_HIP', 'RIGHT_HIP', 'LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE',
  'LEFT_HEEL', 'RIGHT_HEEL', 'LEFT_FOOT_INDEX', 'RIGHT_FOOT_INDEX',
]

/** World landmarks for each recorded frame, from the local MediaPipe script on the fixture clip. */
function addLocalWorldLandmarks(poseData: Array<{ frame: number; landmarks: unknown; world?: unknown }>) {
  const poseDir = path.resolve(process.cwd(), '..', 'correction-mvp', 'pose')
  const out = path.join(OUT, '.local-pose.json')
  execFileSync('uv', ['run', '--project', poseDir, 'python', path.join(poseDir, 'analyze.py'), path.join(OUT, 'player-forehand-volley.mp4'), out], {
    stdio: 'ignore',
  })
  const local = JSON.parse(fs.readFileSync(out, 'utf8')) as { frames: Array<{ world: number[][] | null }> }
  fs.rmSync(out)
  return poseData.map((f) => {
    const w = local.frames[f.frame]?.world
    if (f.world || !w) return f
    return { ...f, world: Object.fromEntries(MP_NAMES.map((n, i) => [n, { x: w[i]![0]!, y: w[i]![1]!, z: w[i]![2]! }])) }
  })
}

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    const a = await c.query(`select metrics from technique_analysis where id = $1`, [ANALYSIS_ID])
    if (!a.rows[0]) throw new Error(`analysis ${ANALYSIS_ID} not found`)
    const m = a.rows[0].metrics as Record<string, any>
    const det = await c.query(
      `select frame, label, confidence, "boxX", "boxY", "boxW", "boxH" from technique_detection_frame where "analysisId" = $1 order by frame`,
      [ANALYSIS_ID],
    )

    // Only what the Modal analyzer returns: BEXevo adds racket fields to pose_data and the rest later.
    let poseData = (m.pose_data as any[]).map((f) => ({ frame: f.frame, landmarks: f.landmarks, ...(f.world ? { world: f.world } : {}) }))
    if (poseData.some((f) => !f.world)) poseData = addLocalWorldLandmarks(poseData)
    const modal = {
      status: 'success',
      analysis_id: 'e2e-fixture',
      metrics: {
        total_frames: m.total_frames,
        analyzed_frames: m.analyzed_frames,
        pose_data: poseData,
        yolo_detections: det.rows.map((r) => ({
          frame: r.frame,
          label: r.label,
          confidence: r.confidence,
          bbox: { x: r.boxX, y: r.boxY, w: r.boxW, h: r.boxH },
        })),
        yolo_summary: { sampled_frames: m.detection_summary?.sampled_frames ?? m.total_frames },
        ...(m.pose_enrichment ? { pose_enrichment: m.pose_enrichment } : {}),
      },
    }
    if (!m.ai_analysis) throw new Error('analysis has no ai_analysis to record')

    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'modal-analyze.json'), JSON.stringify(modal))
    fs.writeFileSync(path.join(OUT, 'llm-analyze.json'), JSON.stringify(m.ai_analysis, null, 2))
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.2',
      '-i', path.join(OUT, 'player-forehand-volley.mp4'), '-frames:v', '1', '-vf', 'scale=540:-2',
      path.join(OUT, 'correction-image.png'),
    ])
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner', '-loglevel', 'error', '-y', '-t', '2',
      '-i', path.join(OUT, 'player-forehand-volley.mp4'), '-an', '-vf', 'scale=360:-2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', path.join(OUT, 'correction-video.mp4'),
    ])
    console.log(
      `Wrote fixtures for ${ANALYSIS_ID}: ${poseData.length} pose frames (${poseData.filter((f) => f.world).length} with world), ${det.rows.length} detections`,
    )
  } finally {
    await c.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
