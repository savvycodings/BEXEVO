/**
 * Pose-correction Magic Shot video (XEVO_VIDEO_PROVIDER=pose-correction): corrects the player's
 * own stroke toward (or away from) a matching pro reference, keeping their proportions, renders
 * the corrected OpenPose skeleton and generates the video with a hosted pose model.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { correctFrame, easeIn, scaleStrengths } from './engine/correct'
import { defaultStrengths, listCorrections } from './engine/corrections'
import { densify, mirrorTrack, sampleTrack } from './engine/landmarks'
import { fitScales, projectCorrection } from './engine/project'
import { alignReference, detectStroke } from './engine/stroke'
import type { Correction, DenseFrame, DenseTrack, Side, Strengths, StrokeInfo } from './engine/types'
import { facingRatio, viewsDiffer } from './engine/view'
import { estimateCost, planWindow, WindowError, type GenWindow } from './engine/window'
import { encodeFrames, extractFramesAt, probe } from './ffmpeg'
import {
  PoseCorrectionError,
  playerTrackFromStored,
  proTrackFromPose,
  racketSideFromMetrics,
  resolveStrengths,
  selectProReference,
} from './inputs'
import type { ProPose } from './proReferences'
import {
  POSE_VIDEO_NEGATIVE_PROMPT,
  POSE_VIDEO_PROMPT,
  resolvePoseVideoProvider,
  resolvePoseVideoResolution,
  type Resolution,
} from './providers'
import { outputSize, renderOverlayFrames, renderPoseFrames } from './render'
import { persistCorrectionVideo } from '../correctionVideoStorage'

const MAX_WINDOW_SECONDS = 5

type PairAnalysis = {
  playerStroke: StrokeInfo
  refStroke: StrokeInfo
  mirrored: boolean
  aligned: DenseFrame[]
  corrections: Correction[]
  defaults: Strengths
}

function analyzePair(player: DenseTrack, ref: DenseTrack, sides: { player?: Side; ref?: Side }, playerContactT?: number): PairAnalysis {
  if (viewsDiffer(player, ref)) {
    throw new PoseCorrectionError(422, 'No pro reference matches your camera angle for this stroke.')
  }
  const playerStroke = detectStroke(player, { racketSide: sides.player, contactT: playerContactT })
  let refTrack = ref
  let refStroke = detectStroke(ref, { racketSide: sides.ref })
  const mirrored = refStroke.racketSide !== playerStroke.racketSide
  if (mirrored) {
    refTrack = mirrorTrack(ref)
    refStroke = detectStroke(refTrack, { racketSide: playerStroke.racketSide })
  }
  const aligned = alignReference(player, playerStroke, refTrack, refStroke)
  const corrections = listCorrections(player.frames, aligned, playerStroke, 10)
  return { playerStroke, refStroke, mirrored, aligned, corrections, defaults: defaultStrengths(corrections) }
}

function correctedTrack(player: DenseTrack, a: PairAnalysis, strengths: Strengths, windowStart: number): DenseTrack {
  const scales = fitScales(player.frames, player.width, player.height)
  const frames = player.frames.map((f, i) => {
    const s = scaleStrengths(strengths, easeIn(f.t, windowStart))
    const world = correctFrame(f.world, a.aligned[i]!.world, a.playerStroke.racketSide, s)
    return { t: f.t, world, image: projectCorrection(f, world, scales[i]!, player.width, player.height) }
  })
  return { ...player, frames }
}

async function renderWindow(videoPath: string, player: DenseTrack, corrected: DenseTrack, window: GenWindow, resolution: Resolution, outDir: string) {
  const size = outputSize(player.width, player.height, resolution)
  const correctedAt = window.times.map((t) => sampleTrack(corrected, t * player.fps).image)
  const originalAt = window.times.map((t) => sampleTrack(player, t * player.fps).image)
  const work = path.join(outDir, 'frames')
  const [, playerFrames] = await Promise.all([
    renderPoseFrames(correctedAt, size.w, size.h, path.join(work, 'pose')),
    extractFramesAt(videoPath, window.times, path.join(work, 'player'), size.w, size.h),
  ])
  await renderOverlayFrames(playerFrames, originalAt, correctedAt, size.w, size.h, path.join(work, 'overlay'))
  const poseVideo = path.join(outDir, 'pose.mp4')
  const overlayVideo = path.join(outDir, 'overlay.mp4')
  const firstFrame = path.join(outDir, 'first.png')
  await Promise.all([
    encodeFrames(path.join(work, 'pose'), window.fps, poseVideo),
    encodeFrames(path.join(work, 'overlay'), window.fps, overlayVideo),
    fs.promises.copyFile(playerFrames[0]!, firstFrame),
  ])
  await fs.promises.rm(work, { recursive: true, force: true })
  return { poseVideo, overlayVideo, firstFrame }
}

export type PoseCorrectionJobResult = {
  video: string
  poseVideo?: string
  startImage: string
  overlayVideo: string
  corrections: Correction[]
  strengths: Strengths
}

/**
 * Runs one pose-correction video for an analysis and stores it as the analysis' correction video.
 * Throws PoseCorrectionError for requests refused before any paid call.
 */
export async function runPoseCorrectionVideoJob(opts: {
  analysisId: string
  userId: string
  metrics: Record<string, unknown>
  videoPath: string
  strengths?: unknown
}): Promise<PoseCorrectionJobResult> {
  const { db } = await import('../../db')
  const { proReference, techniqueAnalysis, userNotification } = await import('../../db/schema')

  if (!opts.videoPath || !fs.existsSync(opts.videoPath)) throw new PoseCorrectionError(404, 'Video file missing on server.')
  const clip = await probe(opts.videoPath)
  const total = typeof opts.metrics.total_frames === 'number' ? opts.metrics.total_frames : undefined
  const player = densify(playerTrackFromStored(opts.metrics.pose_data, { fps: clip.fps, width: clip.width, height: clip.height, totalFrames: total }))

  const userShot = (opts.metrics.user_shot ?? {}) as { strokePreset?: string; shotLabel?: string }
  const stroke = String(userShot.strokePreset ?? '').trim()
  if (!stroke) throw new PoseCorrectionError(422, 'This analysis has no declared stroke, so no pro reference can be chosen.')

  const candidates = await db
    .select({ id: proReference.id, strokePreset: proReference.strokePreset, racketSide: proReference.racketSide, facingRatio: proReference.facingRatio })
    .from(proReference)
    .where(eq(proReference.strokePreset, stroke))
  const chosen = selectProReference(candidates, stroke, facingRatio(player))
  const row = (await db.select().from(proReference).where(eq(proReference.id, chosen.id)).limit(1))[0]!
  const ref = densify(proTrackFromPose(row.pose as ProPose))

  // BEXevo's own impact frame (YOLO / clip based) beats wrist-speed peaks on analyzer landmarks.
  const impact = opts.metrics.impact_frame_resolved
  const playerContactT = typeof impact === 'number' && Number.isFinite(impact) ? impact / clip.fps : undefined
  const a = analyzePair(player, ref, { player: racketSideFromMetrics(opts.metrics), ref: row.racketSide as Side }, playerContactT)
  const strengths = resolveStrengths(opts.strengths, a.defaults)
  let window: GenWindow
  try {
    window = planWindow(a.playerStroke, clip.durationS, MAX_WINDOW_SECONDS)
  } catch (e) {
    if (e instanceof WindowError) throw new PoseCorrectionError(422, e.message)
    throw e
  }

  const provider = resolvePoseVideoProvider()
  const resolution = resolvePoseVideoResolution()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pose-correction-${opts.analysisId.slice(0, 8)}-`))
  try {
    const corrected = correctedTrack(player, a, strengths, window.start)
    const r = await renderWindow(opts.videoPath, player, corrected, window, resolution, work)
    const out = path.join(work, 'corrected.mp4')
    const t0 = Date.now()
    const gen = await provider.generate(
      {
        poseVideoPath: r.poseVideo,
        firstFramePath: r.firstFrame,
        prompt: POSE_VIDEO_PROMPT(userShot.shotLabel || stroke.replace(/_/g, ' ')),
        negativePrompt: POSE_VIDEO_NEGATIVE_PROMPT,
        numFrames: window.numFrames,
        fps: window.fps,
        resolution,
        seed: 42,
      },
      out,
    )

    const frame = Math.round(window.start * player.fps)
    const persisted = persistCorrectionVideo({
      analysisId: opts.analysisId,
      frame,
      videoBuffer: fs.readFileSync(gen.videoPath),
      startImageBuffer: fs.readFileSync(r.firstFrame),
      poseVideoBuffer: fs.readFileSync(r.poseVideo),
      windowStartMs: window.start * 1000,
      windowEndMs: window.end * 1000,
    })
    const overlayName = 'overlay.mp4'
    fs.copyFileSync(r.overlayVideo, path.join(process.cwd(), 'uploads', 'technique-correction-videos', opts.analysisId, overlayName))
    const overlayVideo = `/uploads/technique-correction-videos/${opts.analysisId}/${overlayName}`
    const cost = estimateCost(window.billedSeconds, provider.pricePerSecond(resolution))

    const fresh = await db.query.techniqueAnalysis.findFirst({ where: (ta, { eq: _eq }) => _eq(ta.id, opts.analysisId), columns: { metrics: true } })
    const latest = (fresh?.metrics ?? opts.metrics) as Record<string, unknown>
    await db
      .update(techniqueAnalysis)
      .set({
        metrics: {
          ...latest,
          correction_videos_comfy: { ...persisted, overlayVideo, corrections: a.corrections, strengths },
          correction_context_videos_comfy: {
            version: 'pose-correction-v1',
            pipeline: 'pose-correction',
            generated_at: new Date().toISOString(),
            frame,
            stroke,
            pro_reference_id: chosen.id,
            mirrored: a.mirrored,
            player_stroke: a.playerStroke,
            pro_stroke: a.refStroke,
            provider: provider.id,
            resolution,
            num_frames: window.numFrames,
            fps: window.fps,
            estimated_cost_usd: cost,
            generation_ms: Date.now() - t0,
            request_id: gen.requestId ?? null,
          },
        } as any,
      })
      .where(eq(techniqueAnalysis.id, opts.analysisId))

    await db
      .insert(userNotification)
      .values({
        id: randomUUID(),
        userId: opts.userId,
        kind: 'correction_videos_ready',
        title: 'Magic Shot',
        body: 'Video generated',
        refType: 'technique_analysis',
        refId: opts.analysisId,
        createdAt: new Date(),
      })
      .catch((e: unknown) => console.error('[PoseCorrection] notification insert failed', e))

    console.log('[PoseCorrection] done', {
      analysisId: opts.analysisId,
      pro: chosen.id,
      provider: provider.id,
      corrections: a.corrections.length,
      strengths,
      estimatedCostUsd: cost,
    })
    return { video: persisted.video, poseVideo: persisted.poseVideo, startImage: persisted.startImage, overlayVideo, corrections: a.corrections, strengths }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
