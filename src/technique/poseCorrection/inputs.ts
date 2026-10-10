/**
 * Inputs for the pose-correction Magic Shot video, from what BEXevo already stores:
 * the analysis' pose_data (2D + 3D world landmarks per frame), its declared stroke and the
 * player's dominant hand, plus the curated pro_reference rows.
 */
import type { PoseTrack, Side, Strengths } from './engine/types'
import { REGIONS } from './engine/types'
import type { ProPose } from './proReferences'

/** MediaPipe Pose landmark names in index order (33). */
export const MP_NAMES = [
  'NOSE', 'LEFT_EYE_INNER', 'LEFT_EYE', 'LEFT_EYE_OUTER', 'RIGHT_EYE_INNER', 'RIGHT_EYE', 'RIGHT_EYE_OUTER',
  'LEFT_EAR', 'RIGHT_EAR', 'MOUTH_LEFT', 'MOUTH_RIGHT', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'LEFT_ELBOW',
  'RIGHT_ELBOW', 'LEFT_WRIST', 'RIGHT_WRIST', 'LEFT_PINKY', 'RIGHT_PINKY', 'LEFT_INDEX', 'RIGHT_INDEX',
  'LEFT_THUMB', 'RIGHT_THUMB', 'LEFT_HIP', 'RIGHT_HIP', 'LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE',
  'LEFT_HEEL', 'RIGHT_HEEL', 'LEFT_FOOT_INDEX', 'RIGHT_FOOT_INDEX',
] as const

/** A request the backend refuses before any paid call; `status` is the HTTP status to report. */
export class PoseCorrectionError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type StoredFrame = {
  frame: number
  landmarks?: Record<string, { x: number; y: number; z?: number; visibility?: number }>
  world?: Record<string, { x: number; y: number; z: number }>
}

/**
 * Player pose track from stored metrics.pose_data. Analyses from before the analyzer returned
 * 3D landmarks have no `world`; those must be re-analyzed (spec: Old analysis).
 */
export function playerTrackFromStored(poseData: unknown, opts: { fps: number; width: number; height: number; totalFrames?: number }): PoseTrack {
  const rows = (Array.isArray(poseData) ? poseData : []) as StoredFrame[]
  if (!rows.length) throw new PoseCorrectionError(400, 'This analysis has no pose data.')
  if (rows.some((r) => !r.world || !Object.keys(r.world).length)) {
    throw new PoseCorrectionError(409, 'This analysis was made before Magic Shot video support. Re-analyze the video to use it.')
  }
  const n = Math.max(opts.totalFrames ?? 0, ...rows.map((r) => r.frame + 1))
  const byFrame = new Map(rows.map((r) => [r.frame, r]))
  let detected = 0
  const frames = Array.from({ length: n }, (_, i) => {
    const r = byFrame.get(i)
    const t = i / opts.fps
    if (!r?.landmarks || !r.world) return { t, image: null, world: null }
    detected++
    return {
      t,
      image: MP_NAMES.map((name) => {
        const p = r.landmarks![name]
        return p ? [p.x, p.y, p.z ?? 0, p.visibility ?? 0] : [0, 0, 0, 0]
      }),
      world: MP_NAMES.map((name) => {
        const p = r.world![name]
        return p ? [p.x, p.y, p.z] : [0, 0, 0]
      }),
    }
  })
  return { fps: opts.fps, width: opts.width, height: opts.height, frameCount: n, detectionRate: detected / n, frames }
}

export function proTrackFromPose(pose: ProPose): PoseTrack {
  const detected = pose.frames.filter((f) => f.image && f.world).length
  return { fps: pose.fps, width: pose.width, height: pose.height, frameCount: pose.frames.length, detectionRate: detected / Math.max(1, pose.frames.length), frames: pose.frames }
}

export type ProCandidate = { id: string; strokePreset: string; racketSide: string; facingRatio: number }

/** Max ratio between player and pro facing ratios (shoulder width ÷ torso) before refusing. */
export const MAX_FACING_RATIO = 1.8

/**
 * The reference for the stroke whose camera angle is closest to the player's. Refuses when the
 * stroke has no reference, or the closest one is filmed from a clearly different angle.
 */
export function selectProReference<T extends ProCandidate>(candidates: T[], strokePreset: string, playerFacing: number): T {
  const forStroke = candidates.filter((c) => c.strokePreset === strokePreset)
  if (!forStroke.length) throw new PoseCorrectionError(422, `No pro reference for the stroke "${strokePreset}" yet.`)
  const gap = (c: T) => Math.abs(Math.log(Math.max(1e-6, c.facingRatio) / Math.max(1e-6, playerFacing)))
  const best = [...forStroke].sort((a, b) => gap(a) - gap(b))[0]!
  if (Math.exp(gap(best)) > MAX_FACING_RATIO) {
    throw new PoseCorrectionError(422, 'No pro reference matches your camera angle for this stroke. Film from the front or back to use Magic Shot video.')
  }
  return best
}

/** Racket hand from the analysis' stroke-side result, when it knows the dominant hand. */
export function racketSideFromMetrics(metrics: Record<string, any>): Side | undefined {
  const h = String(metrics?.stroke_side?.dominant_hand ?? '').toLowerCase()
  return h === 'left' ? 'LEFT' : h === 'right' ? 'RIGHT' : undefined
}

export const STRENGTH_MIN = -1
export const STRENGTH_MAX = 1.5

/** Explicit strengths over the defaults; each must be a known region within the range. */
export function resolveStrengths(requested: unknown, defaults: Strengths): Strengths {
  const out = { ...defaults }
  if (requested == null) return out
  if (typeof requested !== 'object') throw new PoseCorrectionError(400, 'strengths must be an object.')
  for (const [k, v] of Object.entries(requested as Record<string, unknown>)) {
    if (!(REGIONS as string[]).includes(k)) throw new PoseCorrectionError(400, `Unknown region "${k}".`)
    const n = Number(v)
    if (!Number.isFinite(n) || n < STRENGTH_MIN || n > STRENGTH_MAX) {
      throw new PoseCorrectionError(400, `Strength for ${k} must be between ${STRENGTH_MIN} and ${STRENGTH_MAX}.`)
    }
    out[k as keyof Strengths] = n
  }
  return out
}
