/**
 * End-to-end: contact frame + MediaPipe -> 3×3 board -> Nano Banana -> sliced cells.
 *
 *   npx tsx scripts/e2eHologramGrid.ts [analysisId]
 *
 * Default analysis has a local technique mp4 + pose_data on this machine.
 * Skips Seedance orbit. Writes parts under uploads/technique-holograms/<id>/ and
 * updates metrics.hologram so the app can pick them up.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { techniqueAnalysis, techniqueVideo } from '../src/db/schema'
import {
  generateHologram,
  isHologramConfigured,
  parseCachedHologram,
  resolveHologramMoment,
} from '../src/technique/hologram'
import { resolveVideoPath } from '../src/technique/frameExtractor'

const DEFAULT_ID = '7d947eb4-5550-4e26-b4ca-3c642e8d0772'

async function main() {
  const analysisId = (process.argv[2] || DEFAULT_ID).trim()
  if (!isHologramConfigured()) {
    throw new Error('Hologram provider is not configured (OPENROUTER_API_KEY / HOLOGRAM_PROVIDER)')
  }

  const row = await db.query.techniqueAnalysis.findFirst({
    where: (ta, { eq: _eq }) => _eq(ta.id, analysisId),
  })
  if (!row) throw new Error(`Analysis not found: ${analysisId}`)
  const metrics = (row.metrics ?? {}) as Record<string, unknown>
  const video = await db.query.techniqueVideo.findFirst({
    where: (tv, { eq: _eq }) => _eq(tv.id, row.techniqueVideoId),
  })
  if (!video?.cloudinaryPublicId) throw new Error('Video row missing')
  const videoPath = resolveVideoPath(video.cloudinaryPublicId)
  if (!fs.existsSync(videoPath)) throw new Error(`Video missing on disk: ${videoPath}`)

  const moment = resolveHologramMoment(metrics, metrics.user_contact_ms, metrics.user_contact_frame)
  if (!moment) throw new Error('No contact moment on this analysis')

  const poseFrames = Array.isArray(metrics.pose_data) ? metrics.pose_data.length : 0
  const hand = String((metrics as any)?.stroke_side?.dominant_hand ?? '').toLowerCase()
  const racketSide = hand === 'left' ? 'LEFT' : hand === 'right' ? 'RIGHT' : null

  console.log('[e2e-grid] start', {
    analysisId,
    videoPath,
    moment,
    poseFrames,
    racketSide,
    provider: process.env.HOLOGRAM_PROVIDER || 'openrouter',
    model: process.env.HOLOGRAM_IMAGE_MODEL || process.env.OPENROUTER_HOLOGRAM_MODEL || 'default',
  })

  const t0 = Date.now()
  const result = await generateHologram({
    analysisId,
    videoPath,
    moment,
    poseData: metrics.pose_data,
    fpsHint:
      typeof metrics.fps === 'number' && metrics.fps > 1
        ? metrics.fps
        : typeof metrics.video_fps === 'number' && metrics.video_fps > 1
          ? metrics.video_fps
          : undefined,
    racketSide,
  })
  const elapsedMs = Date.now() - t0

  const prior = parseCachedHologram(metrics.hologram)
  const keepOrbit = prior
    ? {
        ...(prior.orbitVideo ? { orbitVideo: prior.orbitVideo } : {}),
        ...(prior.orbitDurationMs != null ? { orbitDurationMs: prior.orbitDurationMs } : {}),
        ...(prior.orbitFrameCount != null ? { orbitFrameCount: prior.orbitFrameCount } : {}),
        ...(prior.orbitWidth != null ? { orbitWidth: prior.orbitWidth } : {}),
        ...(prior.orbitHeight != null ? { orbitHeight: prior.orbitHeight } : {}),
        ...(prior.orbitFrames ? { orbitFrames: prior.orbitFrames } : {}),
      }
    : {}

  const hologram = { ...result, ...keepOrbit }
  await db
    .update(techniqueAnalysis)
    .set({
      metrics: {
        ...metrics,
        hologram,
        hologram_job: {
          status: 'done',
          startedAt: new Date(t0).toISOString(),
          finishedAt: new Date().toISOString(),
        },
      },
    })
    .where(eq(techniqueAnalysis.id, analysisId))

  const partIds = Object.keys(result.parts ?? {})
  const diskCheck = (publicPath: string | null | undefined) => {
    if (!publicPath) return false
    const disk = path.join(process.cwd(), publicPath.replace(/^\//, ''))
    return fs.existsSync(disk)
  }

  const summary = {
    analysisId,
    elapsedMs,
    image: result.image,
    frameImage: result.frameImage,
    gridImage: result.gridImage ?? null,
    parts: result.parts ?? null,
    partCount: partIds.length,
    keypoints: result.keypoints ? Object.keys(result.keypoints).length : 0,
    filesOnDisk: {
      image: diskCheck(result.image),
      frameImage: diskCheck(result.frameImage),
      gridImage: diskCheck(result.gridImage),
      parts: Object.fromEntries(partIds.map((id) => [id, diskCheck(result.parts?.[id as keyof typeof result.parts])])),
    },
  }

  const outDir = path.join(process.cwd(), 'uploads', 'technique-holograms', analysisId)
  fs.mkdirSync(outDir, { recursive: true })
  const summaryPath = path.join(outDir, `e2e-grid-summary-${Date.now()}.json`)
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

  console.log('[e2e-grid] done', summary)
  console.log('[e2e-grid] summary file', summaryPath)

  if (partIds.length < 8) {
    console.warn('[e2e-grid] WARNING: expected 8 part cells, got', partIds.length)
    process.exitCode = 2
  }
  if (!diskCheck(result.image) || !diskCheck(result.gridImage)) {
    console.warn('[e2e-grid] WARNING: missing image or grid on disk')
    process.exitCode = 2
  }
}

main().catch((e) => {
  console.error('[e2e-grid] failed', e)
  process.exit(1)
})
